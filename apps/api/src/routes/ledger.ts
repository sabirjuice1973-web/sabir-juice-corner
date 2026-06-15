import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@sjc/db";
import { requireAuth } from "../lib/guards.js";
import { toJson } from "../lib/serialize.js";
import { createWriteStream, mkdirSync, createReadStream, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, "..", "..", "uploads", "ledger");
mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Khatabook / Ledger — 10 named account books per branch.
 *
 * Each branch has exactly 10 LedgerAccount slots (positions 1-10). The owner
 * can rename them freely (Daily Hisaab, Salary, Markeet Bill, etc.). Within
 * each account, entries record purchases/expenses with 9 fields.
 *
 * Cash Today = Opening Cash (manual input) + Today's POS Sales − Sum of
 * today's cashPaid across ALL ledger entries for all accounts.
 */

const DEFAULT_ACCOUNT_NAMES = [
  "Daily Hisaab",
  "Salary",
  "Markeet Bill",
  "Mendi-2020",
  "Kamety",
  "Ali Bhai Hisaab",
  "Account 7",
  "Account 8",
  "Account 9",
  "Account 10",
];

const EntryBody = z.object({
  ledgerAccountId: z.coerce.bigint(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  productName: z.string().trim().min(1).max(200),
  quantity: z.coerce.number().nonnegative().max(1_000_000).nullable().optional(),
  rate: z.coerce.number().nonnegative().max(10_000_000).nullable().optional(),
  total: z.coerce.number().nonnegative().max(10_000_000),
  headName: z.string().trim().max(120).nullable().optional(),
  supplierName: z.string().trim().max(120).nullable().optional(),
  cashPaid: z.coerce.number().nonnegative().max(10_000_000),
  description: z.string().trim().max(500).nullable().optional(),
  attachmentUrl: z.string().max(500).nullable().optional(),
});

const EntryUpdateBody = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  productName: z.string().trim().min(1).max(200).optional(),
  quantity: z.coerce.number().nonnegative().max(1_000_000).nullable().optional(),
  rate: z.coerce.number().nonnegative().max(10_000_000).nullable().optional(),
  total: z.coerce.number().nonnegative().max(10_000_000).optional(),
  headName: z.string().trim().max(120).nullable().optional(),
  supplierName: z.string().trim().max(120).nullable().optional(),
  cashPaid: z.coerce.number().nonnegative().max(10_000_000).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  attachmentUrl: z.string().max(500).nullable().optional(),
});

const ReportQuery = z.object({
  branchId: z.coerce.bigint(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountIds: z.string().optional().transform((s) =>
    s ? s.split(",").filter(Boolean).map((id) => BigInt(id)) : undefined
  ),
  headName: z.string().trim().optional(),
  supplierName: z.string().trim().optional(),
  productName: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export async function registerLedgerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ─── Accounts ────────────────────────────────────────────────────────────

  /**
   * GET /ledger/accounts?branchId=x
   * Returns 10 ledger accounts for the branch. Creates them if they don't exist yet.
   */
  app.get("/accounts", async (req, reply) => {
    const q = z.object({ branchId: z.coerce.bigint() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "branchId required" });

    const existing = await prisma.ledgerAccount.findMany({
      where: { branchId: q.data.branchId },
      orderBy: { position: "asc" },
    });

    // Idempotent init: create any missing slots (1-10)
    if (existing.length < 10) {
      const existingPositions = new Set(existing.map((a) => a.position));
      const toCreate = [];
      for (let pos = 1; pos <= 10; pos++) {
        if (!existingPositions.has(pos)) {
          toCreate.push({
            branchId: q.data.branchId,
            position: pos,
            name: DEFAULT_ACCOUNT_NAMES[pos - 1] ?? `Account ${pos}`,
          });
        }
      }
      if (toCreate.length > 0) {
        await prisma.ledgerAccount.createMany({ data: toCreate });
      }
      const all = await prisma.ledgerAccount.findMany({
        where: { branchId: q.data.branchId },
        orderBy: { position: "asc" },
      });
      return toJson({ accounts: all.map(serializeAccount) });
    }

    return toJson({ accounts: existing.map(serializeAccount) });
  });

  /**
   * PATCH /ledger/accounts/:id
   * Rename a ledger account.
   */
  app.patch("/accounts/:id", async (req, reply) => {
    const id = BigInt((req.params as any).id);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "name required" });

    const updated = await prisma.ledgerAccount.update({
      where: { id },
      data: { name: body.data.name },
    });
    return toJson({ account: serializeAccount(updated) });
  });

  // ─── Entries ─────────────────────────────────────────────────────────────

  /**
   * GET /ledger/entries?ledgerAccountId=x&from=&to=
   * List entries for one account with optional date range.
   */
  app.get("/entries", async (req, reply) => {
    const q = z.object({
      ledgerAccountId: z.coerce.bigint().optional(),
      branchId: z.coerce.bigint().optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.coerce.number().int().min(1).max(10000).default(200),
      sort: z.enum(["asc", "desc"]).default("desc"),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query" });

    const where: any = {};
    if (q.data.ledgerAccountId) where.ledgerAccountId = q.data.ledgerAccountId;
    if (q.data.branchId) where.branchId = q.data.branchId;
    if (q.data.from || q.data.to) {
      where.entryDate = {};
      if (q.data.from) where.entryDate.gte = new Date(q.data.from);
      if (q.data.to) where.entryDate.lte = new Date(q.data.to);
    }

    const dir = q.data.sort === "asc" ? "asc" : "desc";
    const entries = await prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ entryDate: dir }, { createdAt: dir }],
      take: q.data.limit,
    });

    return toJson({ entries: entries.map(serializeEntry) });
  });

  /** POST /ledger/entries/upload — upload an attachment image, returns { url } */
  app.post("/entries/upload", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "No file uploaded" });
    const ext = extname(data.filename).toLowerCase() || ".jpg";
    const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"];
    if (!allowed.includes(ext)) return reply.code(400).send({ error: "File type not allowed" });
    const filename = `${Date.now()}_${randomBytes(6).toString("hex")}${ext}`;
    const dest = join(UPLOAD_DIR, filename);
    await pipeline(data.file, createWriteStream(dest));
    return reply.send({ url: `/api/v1/ledger/uploads/${filename}` });
  });

  /** GET /ledger/uploads/:filename — serve an uploaded attachment */
  app.get("/uploads/:filename", async (req, reply) => {
    const { filename } = req.params as { filename: string };
    if (filename.includes("..") || filename.includes("/")) return reply.code(400).send();
    const filePath = join(UPLOAD_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send();
    const ext = extname(filename).toLowerCase();
    const mime: Record<string, string> = {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf",
    };
    reply.header("Content-Type", mime[ext] ?? "application/octet-stream");
    reply.header("Cache-Control", "max-age=31536000, immutable");
    return reply.send(createReadStream(filePath));
  });

  /** POST /ledger/entries — create a new entry. */
  app.post("/entries", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    const body = EntryBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid body", details: body.error.flatten() });

    const account = await prisma.ledgerAccount.findUnique({
      where: { id: body.data.ledgerAccountId },
    });
    if (!account) return reply.code(404).send({ error: "Ledger account not found" });

    const entry = await prisma.ledgerEntry.create({
      data: {
        branchId: account.branchId,
        ledgerAccountId: body.data.ledgerAccountId,
        entryDate: new Date(body.data.entryDate),
        productName: body.data.productName,
        quantity: body.data.quantity ?? null,
        rate: body.data.rate ?? null,
        total: body.data.total,
        headName: body.data.headName ?? null,
        supplierName: body.data.supplierName ?? null,
        cashPaid: body.data.cashPaid,
        description: body.data.description ?? null,
        attachmentUrl: body.data.attachmentUrl ?? null,
      },
    });

    return reply.code(201).send(toJson({ entry: serializeEntry(entry) }));
  });

  /** PATCH /ledger/entries/:id — update an entry. */
  app.patch("/entries/:id", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    const id = BigInt((req.params as any).id);
    const body = EntryUpdateBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid body", details: body.error.flatten() });

    const existing = await prisma.ledgerEntry.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Entry not found" });

    const updated = await prisma.ledgerEntry.update({
      where: { id },
      data: {
        ...(body.data.entryDate ? { entryDate: new Date(body.data.entryDate) } : {}),
        ...(body.data.productName !== undefined ? { productName: body.data.productName } : {}),
        ...(body.data.quantity !== undefined ? { quantity: body.data.quantity } : {}),
        ...(body.data.rate !== undefined ? { rate: body.data.rate } : {}),
        ...(body.data.total !== undefined ? { total: body.data.total } : {}),
        ...(body.data.headName !== undefined ? { headName: body.data.headName } : {}),
        ...(body.data.supplierName !== undefined ? { supplierName: body.data.supplierName } : {}),
        ...(body.data.cashPaid !== undefined ? { cashPaid: body.data.cashPaid } : {}),
        ...(body.data.description !== undefined ? { description: body.data.description } : {}),
        ...(body.data.attachmentUrl !== undefined ? { attachmentUrl: body.data.attachmentUrl } : {}),
      },
    });

    return toJson({ entry: serializeEntry(updated) });
  });

  /** DELETE /ledger/entries/:id — delete an entry. */
  app.delete("/entries/:id", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    const id = BigInt((req.params as any).id);

    const existing = await prisma.ledgerEntry.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Entry not found" });

    await prisma.ledgerEntry.delete({ where: { id } });
    return reply.code(204).send();
  });

  // ─── Autocomplete suggestions ──────────────────────────────────────────

  /**
   * GET /ledger/suggestions?branchId=x&field=productName&q=am
   * Returns up to 10 distinct past values for the given field that contain q.
   * field: "productName" | "supplierName" | "headName"
   */
  app.get("/suggestions", async (req, reply) => {
    const q = z.object({
      branchId: z.coerce.bigint(),
      accountId: z.coerce.bigint().optional(),
      field: z.enum(["productName", "supplierName", "headName"]),
      q: z.string().default(""),
      from: z.string().optional(),
      to: z.string().optional(),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "branchId and field required" });

    const { branchId, accountId, field, q: search, from, to } = q.data;

    const dateFilter: any = {};
    if (from || to) {
      dateFilter.entryDate = {};
      if (from) dateFilter.entryDate.gte = new Date(from);
      if (to)   dateFilter.entryDate.lte = new Date(to);
    }

    const rows = await (prisma.ledgerEntry as any).groupBy({
      by: [field],
      where: {
        branchId,
        ...(accountId ? { ledgerAccountId: accountId } : {}),
        ...dateFilter,
        ...(search
          ? { [field]: { contains: search, mode: "insensitive" } }
          : { [field]: { not: null } }),
      },
      orderBy: { _count: { [field]: "desc" } },
      take: 10,
    });

    const values = rows
      .map((r: any) => r[field])
      .filter((v: any) => v != null && v !== "") as string[];

    return toJson({ suggestions: values });
  });

  // ─── Report ────────────────────────────────────────────────────────────

  /**
   * GET /ledger/report — filtered report with running balance per account.
   */
  app.get("/report", async (req, reply) => {
    const q = ReportQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query", details: q.error.flatten() });

    const where: any = { branchId: q.data.branchId };
    if (q.data.accountIds?.length) where.ledgerAccountId = { in: q.data.accountIds };
    if (q.data.from || q.data.to) {
      where.entryDate = {};
      if (q.data.from) where.entryDate.gte = new Date(q.data.from);
      if (q.data.to) where.entryDate.lte = new Date(q.data.to);
    }
    if (q.data.headName) where.headName = { contains: q.data.headName, mode: "insensitive" };
    if (q.data.supplierName) where.supplierName = { contains: q.data.supplierName, mode: "insensitive" };
    if (q.data.productName) where.productName = { contains: q.data.productName, mode: "insensitive" };

    const entries = await prisma.ledgerEntry.findMany({
      where,
      include: { ledgerAccount: { select: { id: true, position: true, name: true } } },
      orderBy: [{ ledgerAccountId: "asc" }, { entryDate: "asc" }, { createdAt: "asc" }],
      take: q.data.limit,
    });

    // Group by account and compute running balance per account
    type AccountGroup = {
      account: { id: string; position: number; name: string };
      entries: ReturnType<typeof serializeReportEntry>[];
      totalAmount: string;
      totalCashPaid: string;
    };
    const groups = new Map<string, AccountGroup>();

    for (const e of entries) {
      const key = e.ledgerAccountId.toString();
      if (!groups.has(key)) {
        groups.set(key, {
          account: {
            id: e.ledgerAccount.id.toString(),
            position: e.ledgerAccount.position,
            name: e.ledgerAccount.name,
          },
          entries: [],
          totalAmount: "0",
          totalCashPaid: "0",
        });
      }
      const g = groups.get(key)!;
      g.entries.push(serializeReportEntry(e));
      g.totalAmount = (parseFloat(g.totalAmount) + parseFloat(e.total.toString())).toFixed(2);
      g.totalCashPaid = (parseFloat(g.totalCashPaid) + parseFloat(e.cashPaid.toString())).toFixed(2);
    }

    const grandTotalAmount = [...groups.values()]
      .reduce((sum, g) => sum + parseFloat(g.totalAmount), 0)
      .toFixed(2);
    const grandTotalCashPaid = [...groups.values()]
      .reduce((sum, g) => sum + parseFloat(g.totalCashPaid), 0)
      .toFixed(2);

    return toJson({
      groups: [...groups.values()],
      grandTotalAmount,
      grandTotalCashPaid,
      rowCount: entries.length,
    });
  });

  // ─── Cash Today ────────────────────────────────────────────────────────

  /**
   * GET /ledger/cash-today?branchId=x&date=YYYY-MM-DD
   * Returns total cashPaid across ALL ledger entries for the given date.
   * The client adds: openingCash (manual) + todaySale (from shifts) − totalExpenses
   */
  app.get("/cash-today", async (req, reply) => {
    const q = z.object({
      branchId: z.coerce.bigint(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "branchId and date required" });

    const dayStart = new Date(q.data.date);
    const dayEnd = new Date(q.data.date);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const agg = await prisma.ledgerEntry.aggregate({
      _sum: { cashPaid: true },
      where: {
        branchId: q.data.branchId,
        entryDate: { gte: dayStart, lt: dayEnd },
      },
    });

    const totalExpenses = agg._sum.cashPaid ?? 0;

    return toJson({
      date: q.data.date,
      totalExpenses: totalExpenses.toString(),
    });
  });
}

// ─── Serializers ─────────────────────────────────────────────────────────

function serializeAccount(a: { id: bigint; branchId: bigint; position: number; name: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: a.id.toString(),
    branchId: a.branchId.toString(),
    position: a.position,
    name: a.name,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function serializeEntry(e: {
  id: bigint; branchId: bigint; ledgerAccountId: bigint;
  entryDate: Date; productName: string;
  quantity: any; rate: any; total: any;
  headName: string | null; supplierName: string | null;
  cashPaid: any; description: string | null;
  attachmentUrl?: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: e.id.toString(),
    branchId: e.branchId.toString(),
    ledgerAccountId: e.ledgerAccountId.toString(),
    entryDate: e.entryDate.toISOString().slice(0, 10),
    productName: e.productName,
    quantity: e.quantity != null ? e.quantity.toString() : null,
    rate: e.rate != null ? e.rate.toString() : null,
    total: e.total.toString(),
    headName: e.headName,
    supplierName: e.supplierName,
    cashPaid: e.cashPaid.toString(),
    description: e.description,
    attachmentUrl: e.attachmentUrl ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function serializeReportEntry(e: {
  id: bigint; branchId: bigint; ledgerAccountId: bigint;
  entryDate: Date; productName: string;
  quantity: any; rate: any; total: any;
  headName: string | null; supplierName: string | null;
  cashPaid: any; description: string | null;
  createdAt: Date; updatedAt: Date;
  ledgerAccount: { id: bigint; position: number; name: string };
}) {
  return serializeEntry(e);
}
