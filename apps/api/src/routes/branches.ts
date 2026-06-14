import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@sjc/db";
import { requireAuth } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";

/**
 * Branch-level admin endpoints — currently just the business-date setter, but
 * the file is the natural home for future branch settings (hours, contact, etc.).
 *
 * The business-date mechanism:
 *   Every branch has a manually-set `currentBusinessDate` that's used as the
 *   authoritative "today" for that branch. Orders/Shifts/Expenses/Transfers all
 *   stamp this date on themselves at creation time so reports group by business
 *   day even when the shop runs past midnight or the owner backdates entries.
 *   Updates here only affect FUTURE rows — existing rows keep the date they
 *   were created with.
 */

const SetDateBody = z.object({
  // ISO date string (YYYY-MM-DD). We accept the YYYY-MM-DD prefix of a longer
  // ISO timestamp too, just to be tolerant of clients sending `Date.toISOString()`.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Expected YYYY-MM-DD"),
});

/** Owner + Branch Manager are allowed to change the business date. */
function canChangeBusinessDate(roleCodes: string[]): boolean {
  return roleCodes.includes("OWNER") || roleCodes.includes("BRANCH_MANAGER");
}

export async function registerBranchRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** GET /branches/:id/business-date — current business date for this branch. */
  app.get("/:id/business-date", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const branch = await prisma.branch.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, currentBusinessDate: true },
    });
    if (!branch || branch === null) return reply.code(404).send({ error: "Branch not found" });
    return toJson({
      branchId: branch.id,
      code: branch.code,
      name: branch.name,
      // Return as YYYY-MM-DD; the frontend's <input type="date"> consumes that shape.
      businessDate: branch.currentBusinessDate.toISOString().slice(0, 10),
    });
  });

  /**
   * PATCH /branches/:id/business-date — owner or branch-manager updates it.
   *
   * Only FUTURE entries are affected: orders/shifts/expenses that already exist
   * keep the businessDate they were stamped with at creation. The system has no
   * notion of "this open shift's business day" — the shift was stamped at open,
   * and any orders pushed inside it inherit a fresh stamp from this branch
   * setting at order-create time.
   */
  app.patch("/:id/business-date", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    const roleCodes = req.auth.roles.map((r) => r.code);
    if (!canChangeBusinessDate(roleCodes)) {
      return reply.code(403).send({ error: "Only OWNER or BRANCH_MANAGER can change the business date" });
    }
    const id = BigInt((req.params as { id: string }).id);
    const parsed = SetDateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const branch = await prisma.branch.findUnique({ where: { id }, select: { id: true, currentBusinessDate: true } });
    if (!branch) return reply.code(404).send({ error: "Branch not found" });

    // Parse the YYYY-MM-DD into a Date — using midnight UTC keeps the column
    // value stable regardless of the server's timezone (the column is DATE so
    // Postgres ignores the time component anyway).
    const isoDate = parsed.data.date.slice(0, 10);
    const newDate = new Date(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(newDate.getTime())) {
      return reply.code(400).send({ error: "Invalid date" });
    }

    const before = branch.currentBusinessDate.toISOString().slice(0, 10);
    if (before === isoDate) {
      // No-op — don't write an audit row for a click that didn't change anything.
      return toJson({ branchId: id, businessDate: isoDate, changed: false });
    }

    // Refuse to roll the business date forward (or backward) if there are still
    // OPEN orders on the CURRENT business date. Owner must pay/void/cancel them
    // first — otherwise those orders get stranded with yesterday's businessDate
    // while the system has already moved on, which makes reconciliation a mess.
    const pendingCount = await prisma.order.count({
      where: { branchId: id, businessDate: branch.currentBusinessDate, status: "OPEN" },
    });
    if (pendingCount > 0) {
      const samples = await prisma.order.findMany({
        where: { branchId: id, businessDate: branch.currentBusinessDate, status: "OPEN" },
        select: { orderNo: true, waiterBox: true },
        orderBy: { openedAt: "asc" },
        take: 5,
      });
      return reply.code(409).send({
        error: `Cannot change business date — ${pendingCount} order${pendingCount === 1 ? "" : "s"} on ${before} ${pendingCount === 1 ? "is" : "are"} still open. Save (pay) or void them first.`,
        pendingCount,
        samples: samples.map((s) => ({ orderNo: s.orderNo, waiterBox: s.waiterBox })),
      });
    }

    const updated = await prisma.branch.update({
      where: { id },
      data: { currentBusinessDate: newDate },
      select: { currentBusinessDate: true },
    });

    await writeAudit({
      req, branchId: id,
      action: "branch.business-date.update", entityType: "Branch", entityId: id,
      before: { businessDate: before },
      after: { businessDate: isoDate },
    });

    return toJson({
      branchId: id,
      businessDate: updated.currentBusinessDate.toISOString().slice(0, 10),
      changed: true,
    });
  });
}
