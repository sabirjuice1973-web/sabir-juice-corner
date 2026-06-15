import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";
import { getBranchBusinessDate } from "../lib/businessDate.js";

const OpenBody = z.object({
  branchId: z.coerce.bigint(),
  openingCash: z.coerce.number().nonnegative(),
  notes: z.string().max(500).optional(),
});

const CloseBody = z.object({
  closingCash: z.coerce.number().nonnegative(),
  notes: z.string().max(500).optional(),
});

const ListQuery = z.object({
  branchId: z.coerce.bigint().optional(),
  status: z.enum(["OPEN", "CLOSED", "REOPENED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function registerShiftRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** GET /shifts/current?branchId=... — the open shift for this branch, if any */
  app.get("/current", async (req, reply) => {
    const q = z.object({ branchId: z.coerce.bigint() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "branchId required" });
    const shift = await prisma.shift.findFirst({
      where: { branchId: q.data.branchId, status: "OPEN" },
      include: { openedBy: { select: { id: true, fullName: true, username: true } } },
    });
    return toJson({ shift });
  });

  /**
   * GET /shifts/:id/today-stats — running totals for the active shift, scoped
   * to the branch's CURRENT business date.
   *
   * Why both shift + businessDate: a single shift can contain orders stamped
   * with different businessDates if the owner changes the date mid-shift. The
   * "today's sales" widget should reflect the CURRENTLY-ACTIVE business day —
   * so changing the date to a fresh day immediately drops the widget to zero,
   * and new orders punched after the change accrue back up.
   *
   * Counts only PAID orders so drafts/voids don't inflate the figure.
   */
  app.get("/:id/today-stats", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const shift = await prisma.shift.findUnique({ where: { id }, select: { id: true, branchId: true, status: true } });
    if (!shift) return reply.code(404).send({ error: "Shift not found" });

    const businessDate = await getBranchBusinessDate(shift.branchId);

    const [orderAgg, paymentBreakdown, latePaymentAgg] = await Promise.all([
      prisma.order.aggregate({
        _sum: { total: true, discountAmount: true },
        _count: { _all: true },
        where: { shiftId: id, status: "PAID", businessDate },
      }),
      prisma.payment.groupBy({
        by: ["method"],
        where: { order: { shiftId: id, status: "PAID", businessDate } },
        _sum: { amount: true },
      }),
      prisma.accountPayment.aggregate({
        _sum: { amount: true, discount: true },
        where: { businessDate, account: { branchId: shift.branchId } },
      }),
    ]);
    const byMethod = (m: string) =>
      paymentBreakdown.find((p) => p.method === m)?._sum.amount?.toString() ?? "0";

    return toJson({
      shiftId: id.toString(),
      branchId: shift.branchId.toString(),
      orderCount: orderAgg._count._all,
      salesTotal: (orderAgg._sum.total ?? new Prisma.Decimal(0)).toString(),
      discountsTotal: (orderAgg._sum.discountAmount ?? new Prisma.Decimal(0)).toString(),
      byMethod: {
        cash:   byMethod("CASH"),
        card:   byMethod("CARD"),
        wallet: byMethod("WALLET"),
        credit: byMethod("CREDIT"),
        bank:   byMethod("BANK_TRANSFER"),
      },
      lateCashReceived: (latePaymentAgg._sum.amount   ?? new Prisma.Decimal(0)).toString(),
      lateDiscount:     (latePaymentAgg._sum.discount ?? new Prisma.Decimal(0)).toString(),
    });
  });

  /**
   * GET /shifts/:id/today-orders — list of every order on this shift.
   *
   * Returned one row per order with the fields the cashier wants for a quick
   * sales review: time, order#, status, discount, total, payment method(s).
   * Sorted newest-first so the "Today's Sales" panel reads top-down.
   *
   * Status filter: by default returns ALL statuses (PAID + OPEN + CANCELLED + VOIDED)
   * so the cashier can see voids/cancellations in context. Pass `status=PAID` to
   * filter to revenue-generating orders only.
   */
  app.get("/:id/today-orders", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const q = z.object({
      status: z.enum(["OPEN", "PAID", "CANCELLED", "VOIDED"]).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query" });

    const shift = await prisma.shift.findUnique({ where: { id }, select: { id: true, branchId: true } });
    if (!shift) return reply.code(404).send({ error: "Shift not found" });

    // When from/to provided: query across ALL shifts for this branch in that date range.
    // Otherwise scope to current shift + current business date.
    let baseWhere: Record<string, unknown>;
    if (q.data.from || q.data.to) {
      const dateFilter: Record<string, Date> = {};
      if (q.data.from) dateFilter.gte = new Date(`${q.data.from}T00:00:00.000Z`);
      if (q.data.to)   dateFilter.lte = new Date(`${q.data.to}T00:00:00.000Z`);
      baseWhere = { branchId: shift.branchId, businessDate: dateFilter };
    } else {
      const businessDate = await getBranchBusinessDate(shift.branchId);
      baseWhere = { shiftId: id, businessDate };
    }

    const orders = await prisma.order.findMany({
      where: {
        ...baseWhere,
        ...(q.data.status ? { status: q.data.status } : {}),
      },
      orderBy: { openedAt: "desc" },
      include: {
        payments: { select: { method: true, amount: true } },
        cashier: { select: { id: true, fullName: true, username: true } },
      },
    });

    return toJson({
      orders: orders.map((o) => ({
        id: o.id.toString(),
        orderNo: o.orderNo,
        status: o.status,
        waiterBox: o.waiterBox,
        openedAt: o.openedAt,
        closedAt: o.closedAt,
        subtotal: o.subtotal.toString(),
        discountAmount: o.discountAmount.toString(),
        total: o.total.toString(),
        cashier: o.cashier ? { id: o.cashier.id.toString(), fullName: o.cashier.fullName, username: o.cashier.username } : null,
        cancelReason: o.cancelReason,
        payments: o.payments.map((p) => ({ method: p.method, amount: p.amount.toString() })),
      })),
    });
  });

  /**
   * GET /shifts/:id/item-summary — per-item sales totals for this shift.
   *
   * Group by item, sum qty and lineTotal. PAID orders only (drafts and voids
   * don't count toward "what we sold today").
   *
   * Caveat for custom mixes: an OrderItem for a "Banana+Peach" mix is anchored
   * to ONE itemId (the alphabetically-first component), so its full qty is
   * attributed to that anchor. We expose the mix's full display name so the
   * cashier can recognise it, but the per-component split (0.5 + 0.5) is not done.
   */
  app.get("/:id/item-summary", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const q = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      type: z.enum(["CASH", "CREDIT"]).optional(),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query" });

    const shift = await prisma.shift.findUnique({ where: { id }, select: { id: true, branchId: true } });
    if (!shift) return reply.code(404).send({ error: "Shift not found" });

    const paymentFilter =
      q.data.type === "CASH"   ? { payments: { none: { method: "CREDIT" } } } :
      q.data.type === "CREDIT" ? { payments: { some: { method: "CREDIT" } } } :
      {};

    let orderWhere: Record<string, unknown>;
    if (q.data.from || q.data.to) {
      const dateFilter: Record<string, Date> = {};
      if (q.data.from) dateFilter.gte = new Date(`${q.data.from}T00:00:00.000Z`);
      if (q.data.to)   dateFilter.lte = new Date(`${q.data.to}T00:00:00.000Z`);
      orderWhere = { order: { branchId: shift.branchId, status: "PAID", businessDate: dateFilter, ...paymentFilter } };
    } else {
      const businessDate = await getBranchBusinessDate(shift.branchId);
      orderWhere = { order: { shiftId: id, status: "PAID", businessDate, ...paymentFilter } };
    }

    // Pull every OrderItem for PAID orders, with the joined item.
    const rows = await prisma.orderItem.findMany({
      where: orderWhere,
      select: {
        qty: true,
        lineTotal: true,
        isCustomMix: true,
        customMixComponents: true,
        item: { select: { id: true, itemCode: true, name: true, size: true } },
      },
    });

    type Agg = {
      itemId: string;
      itemCode: number | null;  // null for custom mixes
      name: string;
      size: string;
      qty: number;
      revenue: number;
      isMix: boolean;
    };

    const byItem = new Map<string, Agg>();
    for (const r of rows) {
      const glassQty = Number(r.qty.toString());
      const lineTotalNum = Number(r.lineTotal.toString());

      if (r.isCustomMix) {
        // Each unique mix combination gets its own row, keyed by sorted component codes.
        const components = Array.isArray(r.customMixComponents)
          ? (r.customMixComponents as Array<{ name: string; size: string; itemCode: number }>)
          : [];
        const sortedCodes = [...components].sort((a, b) => a.itemCode - b.itemCode).map((c) => c.itemCode).join("_");
        const key = `mix_${sortedCodes}`;
        const slot: Agg = byItem.get(key) ?? {
          itemId: key,
          itemCode: null,
          name: components.map((c) => c.name).join(" + "),
          size: components[0]?.size ?? "NA",
          qty: 0, revenue: 0, isMix: true,
        };
        slot.qty += glassQty;
        slot.revenue += lineTotalNum;
        byItem.set(key, slot);
      } else {
        const key = r.item.id.toString();
        const slot: Agg = byItem.get(key) ?? {
          itemId: key, itemCode: r.item.itemCode, name: r.item.name, size: r.item.size,
          qty: 0, revenue: 0, isMix: false,
        };
        slot.qty += glassQty;
        slot.revenue += lineTotalNum;
        byItem.set(key, slot);
      }
    }

    const items = [...byItem.values()]
      .sort((a, b) => b.qty - a.qty)
      .map((s) => ({
        itemId: s.itemId,
        itemCode: s.itemCode,
        name: s.name,
        size: s.size,
        qty: s.qty.toFixed(2).replace(/\.?0+$/, ""),
        revenue: s.revenue.toFixed(2),
        isMix: s.isMix,
      }));

    const totals = items.reduce(
      (acc, it) => ({ qty: acc.qty + Number(it.qty), revenue: acc.revenue + Number(it.revenue) }),
      { qty: 0, revenue: 0 },
    );

    return toJson({
      items,
      totals: { qty: totals.qty.toFixed(2).replace(/\.?0+$/, ""), revenue: totals.revenue.toFixed(2) },
    });
  });

  /** GET /shifts — list shifts (admin / reporting) */
  app.get("/", async (req) => {
    const q = ListQuery.parse(req.query);
    const shifts = await prisma.shift.findMany({
      where: {
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { openedAt: "desc" },
      take: q.limit,
      include: {
        branch: { select: { id: true, code: true, name: true } },
        openedBy: { select: { id: true, fullName: true } },
        closedBy: { select: { id: true, fullName: true } },
      },
    });
    return toJson({ shifts });
  });

  /** POST /shifts/open — cashier or manager starts a shift */
  app.post("/open", { preHandler: requirePermission("POS_BILL") }, async (req, reply) => {
    const parsed = OpenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    const { branchId, openingCash, notes } = parsed.data;

    // One open shift per branch at a time
    const existing = await prisma.shift.findFirst({
      where: { branchId, status: "OPEN" },
      select: { id: true },
    });
    if (existing) {
      return reply.code(409).send({ error: "A shift is already open for this branch", shiftId: existing.id.toString() });
    }

    const businessDate = await getBranchBusinessDate(branchId);
    const shift = await prisma.shift.create({
      data: {
        branchId,
        openedById: BigInt(req.auth!.sub),
        openingCash: new Prisma.Decimal(openingCash),
        businessDate,
        notes,
      },
    });
    await writeAudit({ req, branchId, action: "shift.open", entityType: "Shift", entityId: shift.id, after: { openingCash } });
    return toJson({ shift });
  });

  /** POST /shifts/:id/close — manager closes with cash count, system computes variance */
  app.post("/:id/close", { preHandler: requirePermission("POS_BILL") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = CloseBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const shift = await prisma.shift.findUnique({ where: { id } });
    if (!shift) return reply.code(404).send({ error: "Shift not found" });
    if (shift.status !== "OPEN") return reply.code(409).send({ error: `Cannot close shift in status ${shift.status}` });

    // Compute expected cash:
    //   opening + sum(payments.cash for orders in this shift) + sum(drawer IN) - sum(drawer OUT)
    const [cashPayments, drawerIn, drawerOut] = await Promise.all([
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          method: "CASH",
          order: { shiftId: id, status: "PAID" },
        },
      }),
      prisma.cashDrawerMovement.aggregate({
        _sum: { amount: true },
        where: { shiftId: id, type: "IN" },
      }),
      prisma.cashDrawerMovement.aggregate({
        _sum: { amount: true },
        where: { shiftId: id, type: "OUT" },
      }),
    ]);
    const opening = shift.openingCash;
    const cashIn   = cashPayments._sum.amount ?? new Prisma.Decimal(0);
    const drawIn   = drawerIn._sum.amount     ?? new Prisma.Decimal(0);
    const drawOut  = drawerOut._sum.amount    ?? new Prisma.Decimal(0);

    const expected = opening.plus(cashIn).plus(drawIn).minus(drawOut);
    const closing  = new Prisma.Decimal(parsed.data.closingCash);
    const variance = closing.minus(expected);

    const updated = await prisma.shift.update({
      where: { id },
      data: {
        status: "CLOSED",
        closedById: BigInt(req.auth!.sub),
        closedAt: new Date(),
        closingCash: closing,
        expectedCash: expected,
        varianceCash: variance,
        notes: parsed.data.notes ?? shift.notes,
      },
    });
    await writeAudit({
      req,
      branchId: shift.branchId,
      action: "shift.close",
      entityType: "Shift",
      entityId: id,
      before: { status: shift.status },
      after: { status: "CLOSED", expectedCash: expected.toString(), closingCash: closing.toString(), varianceCash: variance.toString() },
    });
    return toJson({
      shift: updated,
      summary: {
        opening: opening.toString(),
        cashSales: cashIn.toString(),
        drawerIn: drawIn.toString(),
        drawerOut: drawOut.toString(),
        expected: expected.toString(),
        counted: closing.toString(),
        variance: variance.toString(),
      },
    });
  });
}
