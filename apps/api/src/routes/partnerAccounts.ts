import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";

/**
 * Partner Accounts — owners' personal cash-in/cash-out ledger. Tracks money
 * moving between the shop till and a partner's own pocket (a running loan,
 * not a sale or a supplier expense) — replaces the pair of personal Excel
 * sheets. Two fixed, renameable slots per branch (position 1-2), same
 * lazy-init pattern as LedgerAccount's 10 slots.
 *
 * A partner's balance = GAVE_TO_SHOP total − TOOK_FROM_SHOP − RECEIVED_ONLINE.
 * Positive means the shop owes the partner; negative means the partner owes
 * the shop. See GET /summary, folded into the Stats page's Total Shop Debt.
 *
 * OWNER-only end to end — same gating as Payment Schedule and the Ledger
 * Reports feature, since this is personal owner-level bookkeeping.
 */

const PARTNER_SLOT_COUNT = 2;
const DEFAULT_PARTNER_NAMES = ["Partner 1", "Partner 2"];

function ownerOnly(req: any, reply: any): true | undefined {
  if (!req.auth?.roles?.some((r: any) => r.code === "OWNER")) {
    reply.code(403).send({ error: "Only OWNER can access Partner Accounts" });
    return true;
  }
}

function serializeAccount(a: { id: bigint; position: number; name: string }) {
  return { id: a.id.toString(), position: a.position, name: a.name };
}

function serializeEntry(e: {
  id: bigint; entryDate: Date; type: string; amount: Prisma.Decimal; note: string | null;
}) {
  return {
    id: e.id.toString(),
    entryDate: e.entryDate.toISOString().slice(0, 10),
    type: e.type as "GAVE_TO_SHOP" | "TOOK_FROM_SHOP" | "RECEIVED_ONLINE",
    amount: e.amount.toString(),
    note: e.note,
  };
}

// balance = GAVE_TO_SHOP - TOOK_FROM_SHOP - RECEIVED_ONLINE
function computeBalance(entries: { type: string; amount: Prisma.Decimal }[]): Prisma.Decimal {
  return entries.reduce((bal, e) => {
    if (e.type === "GAVE_TO_SHOP") return bal.plus(e.amount);
    return bal.minus(e.amount);
  }, new Prisma.Decimal(0));
}

const EntryBody = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(["GAVE_TO_SHOP", "TOOK_FROM_SHOP", "RECEIVED_ONLINE"]),
  amount: z.coerce.number().positive().max(10_000_000),
  note: z.string().trim().max(300).nullable().optional(),
});
const EntryUpdateBody = EntryBody.partial();

export async function registerPartnerAccountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** GET /partner-accounts?branchId= — the 2 partner slots, creating them if they don't exist yet */
  app.get("/", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const q = z.object({ branchId: z.coerce.bigint() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "branchId required" });

    const existing = await prisma.partnerAccount.findMany({
      where: { branchId: q.data.branchId },
      orderBy: { position: "asc" },
    });
    if (existing.length < PARTNER_SLOT_COUNT) {
      const existingPositions = new Set(existing.map((a) => a.position));
      const toCreate = [];
      for (let pos = 1; pos <= PARTNER_SLOT_COUNT; pos++) {
        if (!existingPositions.has(pos)) {
          toCreate.push({ branchId: q.data.branchId, position: pos, name: DEFAULT_PARTNER_NAMES[pos - 1] ?? `Partner ${pos}` });
        }
      }
      if (toCreate.length > 0) await prisma.partnerAccount.createMany({ data: toCreate });
    }

    const accounts = await prisma.partnerAccount.findMany({
      where: { branchId: q.data.branchId },
      orderBy: { position: "asc" },
      include: { entries: true },
    });
    return toJson({
      accounts: accounts.map((a) => ({ ...serializeAccount(a), balance: computeBalance(a.entries).toString() })),
    });
  });

  /** PATCH /partner-accounts/:id — rename a partner slot */
  app.patch("/:id", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "name required" });

    const updated = await prisma.partnerAccount.update({ where: { id }, data: { name: body.data.name } });
    return toJson({ account: serializeAccount(updated) });
  });

  /**
   * GET /partner-accounts/summary?branchId= — every partner's current
   * balance + the grand total, for folding into the Stats page's Total Shop
   * Debt (a positive balance is money the shop owes them, i.e. shop debt).
   */
  app.get("/summary", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const q = z.object({ branchId: z.coerce.bigint() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "branchId required" });

    const accounts = await prisma.partnerAccount.findMany({
      where: { branchId: q.data.branchId },
      orderBy: { position: "asc" },
      include: { entries: true },
    });
    const partners = accounts.map((a) => ({ ...serializeAccount(a), balance: computeBalance(a.entries).toString() }));
    const totalOwedToPartners = partners.reduce((s, p) => s + Math.max(0, Number(p.balance)), 0);
    const totalOwedByPartners = partners.reduce((s, p) => s + Math.max(0, -Number(p.balance)), 0);
    return toJson({ partners, totalOwedToPartners, totalOwedByPartners });
  });

  /** GET /partner-accounts/:id/entries — full history, oldest first (for running-balance display client-side) */
  app.get("/:id/entries", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const entries = await prisma.partnerAccountEntry.findMany({
      where: { partnerAccountId: id },
      orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
    });
    return toJson({ entries: entries.map(serializeEntry) });
  });

  /** POST /partner-accounts/:id/entries — add a cash-in/cash-out entry */
  app.post("/:id/entries", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const parsed = EntryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const account = await prisma.partnerAccount.findUnique({ where: { id } });
    if (!account) return reply.code(404).send({ error: "Partner account not found" });

    const created = await prisma.partnerAccountEntry.create({
      data: {
        branchId: account.branchId,
        partnerAccountId: id,
        entryDate: new Date(`${parsed.data.entryDate}T00:00:00Z`),
        type: parsed.data.type,
        amount: new Prisma.Decimal(parsed.data.amount),
        note: parsed.data.note ?? null,
        createdById: BigInt(req.auth!.sub),
      },
    });
    await writeAudit({
      req, branchId: account.branchId, action: "partner_account.entry.create",
      entityType: "PartnerAccountEntry", entityId: created.id,
      after: { type: parsed.data.type, amount: parsed.data.amount, entryDate: parsed.data.entryDate },
    });
    return toJson({ entry: serializeEntry(created) });
  });

  /** PATCH /partner-accounts/:id/entries/:entryId — correct a previously logged entry */
  app.patch("/:id/entries/:entryId", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const entryId = BigInt((req.params as { entryId: string }).entryId);
    const parsed = EntryUpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const existing = await prisma.partnerAccountEntry.findUnique({ where: { id: entryId } });
    if (!existing || existing.partnerAccountId !== id) return reply.code(404).send({ error: "Entry not found" });

    const updated = await prisma.partnerAccountEntry.update({
      where: { id: entryId },
      data: {
        ...(parsed.data.entryDate ? { entryDate: new Date(`${parsed.data.entryDate}T00:00:00Z`) } : {}),
        ...(parsed.data.type ? { type: parsed.data.type } : {}),
        ...(parsed.data.amount !== undefined ? { amount: new Prisma.Decimal(parsed.data.amount) } : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      },
    });
    await writeAudit({
      req, branchId: existing.branchId, action: "partner_account.entry.update",
      entityType: "PartnerAccountEntry", entityId: entryId,
      before: { type: existing.type, amount: existing.amount.toString() },
      after: parsed.data,
    });
    return toJson({ entry: serializeEntry(updated) });
  });

  /** DELETE /partner-accounts/:id/entries/:entryId */
  app.delete("/:id/entries/:entryId", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const entryId = BigInt((req.params as { entryId: string }).entryId);

    const existing = await prisma.partnerAccountEntry.findUnique({ where: { id: entryId } });
    if (!existing || existing.partnerAccountId !== id) return reply.code(404).send({ error: "Entry not found" });

    await prisma.partnerAccountEntry.delete({ where: { id: entryId } });
    await writeAudit({
      req, branchId: existing.branchId, action: "partner_account.entry.delete",
      entityType: "PartnerAccountEntry", entityId: entryId,
      before: { type: existing.type, amount: existing.amount.toString() },
    });
    return toJson({ ok: true });
  });
}
