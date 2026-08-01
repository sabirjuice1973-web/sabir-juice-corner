import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";

/**
 * Payment Schedule — owner's forward-looking cash-flow planner (replaces a
 * manual Excel sheet). Lists upcoming/recurring obligations (supplier
 * payments, bills, home expenses) with a running "Average" column — the
 * cumulative scheduled amount divided by calendar days elapsed since the
 * first entry of the period — so the owner can compare a daily burn rate
 * against actual sales and decide whether the schedule needs reshuffling.
 *
 * Deliberately separate from LedgerEntry: this is a forecast/checklist, not
 * a record of money that already moved. Marking a row "paid" (or recording a
 * partial-payment installment) never creates a LedgerEntry — see the model's
 * doc comment in schema.prisma.
 *
 * OWNER-only end to end (list/create/update/delete) — same gating pattern
 * as the Ledger Reports feature, since this is owner-level planning, not a
 * cashier task, even though the entry point button lives in the POS.
 */

function ownerOnly(req: any, reply: any): true | undefined {
  if (!req.auth?.roles?.some((r: any) => r.code === "OWNER")) {
    reply.code(403).send({ error: "Only OWNER can access the Payment Schedule" });
    return true;
  }
}

// `amount` on PaymentScheduleEntry is the ORIGINAL scheduled amount and is
// never mutated by recording a partial payment — `outstanding` is always
// derived fresh here as (amount − sum of installments), floored at 0. This
// is deliberate: a previous version decremented `amount` in place on every
// installment, which meant each new partial payment's correctness depended
// on the entry's stored amount already being right from the last write —
// any drift (a missed update, a stale read) silently compounded. Deriving
// outstanding from the installments list every time this is impossible.
function serializeEntry(e: {
  id: bigint; entryDate: Date; details: string; amount: Prisma.Decimal;
  description: string | null; recurrence: string | null; isPaid: boolean;
  installments?: { id: bigint; amount: Prisma.Decimal; paidDate: Date; note: string | null }[];
}) {
  const installments = e.installments ?? [];
  const paidSoFar = installments.reduce((s, i) => s.plus(i.amount), new Prisma.Decimal(0));
  const outstanding = Prisma.Decimal.max(e.amount.minus(paidSoFar), new Prisma.Decimal(0));
  return {
    id: e.id.toString(),
    entryDate: e.entryDate.toISOString().slice(0, 10),
    details: e.details,
    amount: e.amount.toString(),
    outstanding: outstanding.toString(),
    description: e.description,
    recurrence: e.recurrence,
    isPaid: e.isPaid,
    installments: installments.map((i) => ({
      id: i.id.toString(), amount: i.amount.toString(),
      paidDate: i.paidDate.toISOString().slice(0, 10), note: i.note,
    })),
  };
}

function addOccurrence(d: Date, recurrence: "WEEKLY" | "MONTHLY"): Date {
  const next = new Date(d);
  if (recurrence === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

const EntryBody = z.object({
  branchId: z.coerce.bigint(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  details: z.string().trim().min(1).max(200),
  amount: z.coerce.number().nonnegative().max(100_000_000),
  description: z.string().trim().max(500).nullable().optional(),
  recurrence: z.enum(["WEEKLY", "MONTHLY"]).nullable().optional(),
});

const RecurringBody = EntryBody.extend({
  recurrence: z.enum(["WEEKLY", "MONTHLY"]),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const EntryUpdateBody = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  details: z.string().trim().min(1).max(200).optional(),
  amount: z.coerce.number().nonnegative().max(100_000_000).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  recurrence: z.enum(["WEEKLY", "MONTHLY"]).nullable().optional(),
  isPaid: z.boolean().optional(),
});

const InstallmentBody = z.object({
  amount: z.coerce.number().positive().max(100_000_000),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(300).nullable().optional(),
  // Optional — moves the parent entry's due date forward to reflect when the
  // still-outstanding remainder (if any) is now expected.
  newEntryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export async function registerPaymentScheduleRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** GET /payment-schedule?branchId=&from=&to= — entries in range + their installment history, oldest first */
  app.get("/", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const q = z.object({
      branchId: z.coerce.bigint(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "branchId, from, to required (YYYY-MM-DD)" });

    const entries = await prisma.paymentScheduleEntry.findMany({
      where: {
        branchId: q.data.branchId,
        entryDate: {
          gte: new Date(`${q.data.from}T00:00:00Z`),
          lte: new Date(`${q.data.to}T00:00:00Z`),
        },
      },
      include: { installments: { orderBy: { paidDate: "asc" } } },
      orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
    });

    return toJson({ entries: entries.map(serializeEntry) });
  });

  /**
   * GET /payment-schedule/sales-summary?branchId=&from=&to= — actual PAID
   * order revenue in the same range, branch-scoped (no shiftId needed), so
   * the schedule's "Average / day" can be compared against real sales.
   */
  app.get("/sales-summary", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const q = z.object({
      branchId: z.coerce.bigint(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "branchId, from, to required (YYYY-MM-DD)" });

    const agg = await prisma.order.aggregate({
      _sum: { total: true },
      where: {
        branchId: q.data.branchId,
        status: "PAID",
        businessDate: {
          gte: new Date(`${q.data.from}T00:00:00Z`),
          lte: new Date(`${q.data.to}T00:00:00Z`),
        },
      },
    });

    return toJson({ totalSales: (agg._sum.total ?? new Prisma.Decimal(0)).toString() });
  });

  /** POST /payment-schedule — add a single (one-time, or manually cloned) scheduled entry */
  app.post("/", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const parsed = EntryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const created = await prisma.paymentScheduleEntry.create({
      data: {
        branchId: parsed.data.branchId,
        entryDate: new Date(`${parsed.data.entryDate}T00:00:00Z`),
        details: parsed.data.details,
        amount: new Prisma.Decimal(parsed.data.amount),
        description: parsed.data.description ?? null,
        recurrence: parsed.data.recurrence ?? null,
        createdById: BigInt(req.auth!.sub),
      },
      include: { installments: true },
    });
    await writeAudit({
      req, branchId: parsed.data.branchId, action: "payment_schedule.create",
      entityType: "PaymentScheduleEntry", entityId: created.id,
      after: { details: created.details, amount: parsed.data.amount, entryDate: parsed.data.entryDate },
    });
    return toJson({ entry: serializeEntry(created) });
  });

  /**
   * POST /payment-schedule/recurring — generate every occurrence of a weekly
   * or monthly payment from `entryDate` through `until` (inclusive) in one
   * shot, anchored to the given start date. E.g. entryDate=2026-08-02,
   * recurrence=WEEKLY, until=2026-08-31 → creates Aug 2, 9, 16, 23, 30.
   */
  app.post("/recurring", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const parsed = RecurringBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const start = new Date(`${parsed.data.entryDate}T00:00:00Z`);
    const until = new Date(`${parsed.data.until}T00:00:00Z`);
    if (until < start) return reply.code(400).send({ error: "until must be on/after entryDate" });

    const occurrences: Date[] = [];
    for (let d = start; d <= until; d = addOccurrence(d, parsed.data.recurrence)) {
      occurrences.push(new Date(d));
      if (occurrences.length > 366) break; // sanity cap
    }

    const created = await prisma.$transaction(
      occurrences.map((d) =>
        prisma.paymentScheduleEntry.create({
          data: {
            branchId: parsed.data.branchId,
            entryDate: d,
            details: parsed.data.details,
            amount: new Prisma.Decimal(parsed.data.amount),
            description: parsed.data.description ?? null,
            recurrence: parsed.data.recurrence,
            createdById: BigInt(req.auth!.sub),
          },
          include: { installments: true },
        }),
      ),
    );

    await writeAudit({
      req, branchId: parsed.data.branchId, action: "payment_schedule.create_recurring",
      entityType: "PaymentScheduleEntry",
      after: { details: parsed.data.details, amount: parsed.data.amount, count: created.length, recurrence: parsed.data.recurrence },
    });
    return toJson({ entries: created.map(serializeEntry) });
  });

  /** PATCH /payment-schedule/:id — edit an entry or toggle isPaid */
  app.patch("/:id", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const parsed = EntryUpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const existing = await prisma.paymentScheduleEntry.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Entry not found" });

    const updated = await prisma.paymentScheduleEntry.update({
      where: { id },
      data: {
        ...(parsed.data.entryDate ? { entryDate: new Date(`${parsed.data.entryDate}T00:00:00Z`) } : {}),
        ...(parsed.data.details !== undefined ? { details: parsed.data.details } : {}),
        ...(parsed.data.amount !== undefined ? { amount: new Prisma.Decimal(parsed.data.amount) } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.recurrence !== undefined ? { recurrence: parsed.data.recurrence } : {}),
        ...(parsed.data.isPaid !== undefined ? { isPaid: parsed.data.isPaid } : {}),
      },
      include: { installments: { orderBy: { paidDate: "asc" } } },
    });
    await writeAudit({
      req, branchId: existing.branchId, action: "payment_schedule.update",
      entityType: "PaymentScheduleEntry", entityId: id,
      before: { details: existing.details, amount: existing.amount.toString(), isPaid: existing.isPaid },
      after: { details: updated.details, amount: updated.amount.toString(), isPaid: updated.isPaid },
    });
    return toJson({ entry: serializeEntry(updated) });
  });

  // Recompute isPaid from the true outstanding balance (amount minus every
  // installment) and persist it — called after any installment is created,
  // edited, or deleted so isPaid never drifts from reality.
  async function recomputeIsPaid(tx: Prisma.TransactionClient, id: bigint) {
    const entry = await tx.paymentScheduleEntry.findUniqueOrThrow({
      where: { id }, include: { installments: true },
    });
    const paidSoFar = entry.installments.reduce((s, i) => s.plus(i.amount), new Prisma.Decimal(0));
    const outstanding = Prisma.Decimal.max(entry.amount.minus(paidSoFar), new Prisma.Decimal(0));
    return tx.paymentScheduleEntry.update({
      where: { id },
      data: { isPaid: outstanding.equals(0) },
      include: { installments: { orderBy: { paidDate: "asc" } } },
    });
  }

  /**
   * POST /payment-schedule/:id/installments — record a partial payment.
   * Never touches the entry's `amount` (the original scheduled total) —
   * outstanding is always derived from amount minus every installment (see
   * serializeEntry). Optionally moves entryDate to reflect when the
   * remainder is now due, and auto-marks isPaid once nothing is left owing.
   */
  app.post("/:id/installments", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const parsed = InstallmentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const existing = await prisma.paymentScheduleEntry.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Entry not found" });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.paymentScheduleInstallment.create({
        data: {
          scheduleEntryId: id,
          amount: new Prisma.Decimal(parsed.data.amount),
          paidDate: new Date(`${parsed.data.paidDate}T00:00:00Z`),
          note: parsed.data.note ?? null,
        },
      });
      if (parsed.data.newEntryDate) {
        await tx.paymentScheduleEntry.update({
          where: { id },
          data: { entryDate: new Date(`${parsed.data.newEntryDate}T00:00:00Z`) },
        });
      }
      return recomputeIsPaid(tx, id);
    });

    await writeAudit({
      req, branchId: existing.branchId, action: "payment_schedule.installment.create",
      entityType: "PaymentScheduleEntry", entityId: id,
      after: { paid: parsed.data.amount, paidDate: parsed.data.paidDate },
    });
    return toJson({ entry: serializeEntry(updated) });
  });

  /** PATCH /payment-schedule/:id/installments/:instId — correct a previously recorded partial payment */
  app.patch("/:id/installments/:instId", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const instId = BigInt((req.params as { instId: string }).instId);
    const parsed = InstallmentBody.omit({ newEntryDate: true }).partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const inst = await prisma.paymentScheduleInstallment.findUnique({ where: { id: instId } });
    if (!inst || inst.scheduleEntryId !== id) return reply.code(404).send({ error: "Installment not found" });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.paymentScheduleInstallment.update({
        where: { id: instId },
        data: {
          ...(parsed.data.amount !== undefined ? { amount: new Prisma.Decimal(parsed.data.amount) } : {}),
          ...(parsed.data.paidDate ? { paidDate: new Date(`${parsed.data.paidDate}T00:00:00Z`) } : {}),
          ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
        },
      });
      return recomputeIsPaid(tx, id);
    });

    await writeAudit({
      req, branchId: updated.branchId, action: "payment_schedule.installment.update",
      entityType: "PaymentScheduleInstallment", entityId: instId,
      before: { amount: inst.amount.toString(), paidDate: inst.paidDate.toISOString().slice(0, 10) },
      after: parsed.data,
    });
    return toJson({ entry: serializeEntry(updated) });
  });

  /** DELETE /payment-schedule/:id/installments/:instId — remove a mistaken partial payment */
  app.delete("/:id/installments/:instId", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const instId = BigInt((req.params as { instId: string }).instId);

    const inst = await prisma.paymentScheduleInstallment.findUnique({ where: { id: instId } });
    if (!inst || inst.scheduleEntryId !== id) return reply.code(404).send({ error: "Installment not found" });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.paymentScheduleInstallment.delete({ where: { id: instId } });
      return recomputeIsPaid(tx, id);
    });

    await writeAudit({
      req, branchId: updated.branchId, action: "payment_schedule.installment.delete",
      entityType: "PaymentScheduleInstallment", entityId: instId,
      before: { amount: inst.amount.toString(), paidDate: inst.paidDate.toISOString().slice(0, 10) },
    });
    return toJson({ entry: serializeEntry(updated) });
  });

  /** DELETE /payment-schedule/:id */
  app.delete("/:id", async (req, reply) => {
    if (ownerOnly(req, reply)) return;
    const id = BigInt((req.params as { id: string }).id);
    const existing = await prisma.paymentScheduleEntry.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Entry not found" });

    await prisma.paymentScheduleEntry.delete({ where: { id } });
    await writeAudit({
      req, branchId: existing.branchId, action: "payment_schedule.delete",
      entityType: "PaymentScheduleEntry", entityId: id,
      before: { details: existing.details, amount: existing.amount.toString() },
    });
    return toJson({ ok: true });
  });
}
