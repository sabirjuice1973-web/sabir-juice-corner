import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";
import { deductForOrder } from "../services/salesDeduction.js";
import { getBranchBusinessDate, yyyymmdd } from "../lib/businessDate.js";

/**
 * Orders / billing endpoints.
 *
 * Lifecycle: OPEN → (add items / discounts / modifiers) → PAID  (or VOIDED / CANCELLED).
 *
 * Notes:
 *  - Item price is captured at the time it's added to the order, so back-dated price
 *    edits never change historical sales.
 *  - Stock deduction via recipe is stubbed for Phase 1; will be wired in Phase 3 once
 *    raw materials & production batches are populated.
 *  - Custom mixes are accepted as a free-form components array on the line item.
 */

// ─── Validators ────────────────────────────────────────────────────────────

const CreateOrderBody = z.object({
  branchId: z.coerce.bigint(),
  shiftId: z.coerce.bigint(),
  waiterBox: z.number().int().min(1).max(9).optional(),
  waiterId: z.coerce.bigint().optional(),
  orderType: z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY"]).default("DINE_IN"),
});

const AddItemBody = z.object({
  itemCode: z.number().int().positive(),
  qty: z.coerce.number().positive().max(99),
  modifierIds: z.array(z.coerce.bigint()).optional(),
  isCustomMix: z.boolean().optional(),
  customMixComponents: z.array(z.object({
    name: z.string(),
    ratio: z.number().min(0).max(1),
  })).optional(),
  notes: z.string().max(200).optional(),
});

const CreateOrderWithItemsBody = z.object({
  branchId: z.coerce.bigint(),
  shiftId: z.coerce.bigint(),
  waiterBox: z.number().int().min(1).max(9).optional(),
  waiterId: z.coerce.bigint().optional(),
  orderType: z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY"]).default("DINE_IN"),
  // Optional customer/partner name. Required at the POS for box 7 (market orders)
  // and box 6 (food panda) so the row shows who the order belongs to. Boxes 1-5
  // can optionally tag a customer too (credit customers, regulars).
  customerName: z.string().trim().min(1).max(120).optional(),
  items: z.array(z.object({
    // Either itemCode (regular menu item) OR mixOf (custom-mix of 2-5 codes,
    // e.g. "Peach+Banana Medium" or "Peach+Banana+Mango Medium")
    itemCode: z.number().int().positive().optional(),
    mixOf: z.array(z.number().int().positive()).min(2).max(5).optional(),
    // Decimal qty allowed (0.25, 0.5, 1.75, etc.) — common for splits and halves
    qty: z.coerce.number().positive().max(99),
    notes: z.string().max(200).optional(),
  }).refine((d) => !!d.itemCode || !!d.mixOf, "Each item needs either itemCode or mixOf"))
    .min(1).max(50),
});

const ApplyDiscountBody = z.object({
  discountType: z.enum(["PERCENT", "FLAT"]).default("PERCENT"),
  value: z.coerce.number().positive(),
  reason: z.string().max(200).optional(),
});

const PayBody = z.object({
  method: z.enum(["CASH", "CARD", "WALLET", "CREDIT", "BANK_TRANSFER"]),
  amount: z.coerce.number().positive(),
  reference: z.string().max(120).optional(),
});

const VoidBody = z.object({
  reason: z.string().min(2).max(200),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function decimal(n: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(n);
}

/**
 * Round a Decimal UP to the next multiple of 10. Owner's pricing policy for
 * custom mixes: 426.67 → 430, 599 → 600, 1021 → 1030. Values that are already
 * a multiple of 10 (e.g. 320) pass through unchanged. Keeps cashier change-making
 * simple — no 30-paisa drawer math at 11pm.
 */
function ceilToNext10(d: Prisma.Decimal): Prisma.Decimal {
  return d.dividedBy(10).ceil().times(10);
}

async function recomputeOrderTotal(tx: Prisma.TransactionClient, orderId: bigint) {
  const [items, discounts] = await Promise.all([
    tx.orderItem.findMany({ where: { orderId }, select: { lineTotal: true } }),
    tx.discountApplied.findMany({ where: { orderId }, select: { amount: true } }),
  ]);
  const subtotal = items.reduce((s, i) => s.plus(i.lineTotal), decimal(0));
  const discount = discounts.reduce((s, d) => s.plus(d.amount), decimal(0));
  const total = Prisma.Decimal.max(subtotal.minus(discount), decimal(0));
  return tx.order.update({
    where: { id: orderId },
    data: { subtotal, discountAmount: discount, total },
    include: orderInclude,
  });
}

const orderInclude = {
  items: {
    include: {
      item: { select: { itemCode: true, name: true, size: true } },
      modifiers: { include: { modifier: { select: { name: true } } } },
    },
    orderBy: { id: "asc" as const },
  },
  payments: { orderBy: { paidAt: "asc" as const } },
  discounts: true,
  branch: { select: { id: true, code: true, name: true } },
  cashier: { select: { id: true, fullName: true, username: true } },
  waiter: { select: { id: true, fullName: true } },
};

async function nextOrderNo(branchId: bigint, businessDate: Date): Promise<string> {
  // Format: B{branchId}-YYYYMMDD-NNNN  (per-businessDate per-branch sequence).
  // We count by businessDate (not by openedAt) so two orders 5 minutes apart
  // never get different YYYYMMDD prefixes because real midnight passed mid-shift,
  // and so backdating the business date restarts the counter for that backdate.
  const datePart = yyyymmdd(businessDate);
  const taken = await prisma.order.count({
    where: { branchId, businessDate },
  });
  const seq = String(taken + 1).padStart(4, "0");
  return `B${branchId}-${datePart}-${seq}`;
}

// ─── Routes ────────────────────────────────────────────────────────────────

export async function registerOrderRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** GET /orders?branchId=&shiftId=&status=&waiterBox= */
  app.get("/", async (req) => {
    const q = z.object({
      branchId: z.coerce.bigint().optional(),
      shiftId: z.coerce.bigint().optional(),
      status: z.enum(["OPEN", "PAID", "CANCELLED", "VOIDED"]).optional(),
      waiterBox: z.coerce.number().int().min(1).max(7).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query);

    const orders = await prisma.order.findMany({
      where: {
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.shiftId ? { shiftId: q.shiftId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.waiterBox ? { waiterBox: q.waiterBox } : {}),
      },
      orderBy: { openedAt: "desc" },
      take: q.limit,
      include: orderInclude,
    });
    return toJson({ orders });
  });

  /** GET /orders/:id */
  app.get("/:id", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
    if (!order) return reply.code(404).send({ error: "Order not found" });
    return toJson({ order });
  });

  /** POST /orders — open a new order */
  app.post("/", { preHandler: requirePermission("POS_BILL") }, async (req, reply) => {
    const parsed = CreateOrderBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const shift = await prisma.shift.findUnique({ where: { id: parsed.data.shiftId } });
    if (!shift) return reply.code(404).send({ error: "Shift not found" });
    if (shift.status !== "OPEN") return reply.code(409).send({ error: "Shift is not open" });
    if (shift.branchId !== parsed.data.branchId) {
      return reply.code(400).send({ error: "Shift does not belong to this branch" });
    }

    const businessDate = await getBranchBusinessDate(parsed.data.branchId);
    const orderNo = await nextOrderNo(parsed.data.branchId, businessDate);
    const order = await prisma.order.create({
      data: {
        orderNo,
        branchId: parsed.data.branchId,
        shiftId: parsed.data.shiftId,
        waiterBox: parsed.data.waiterBox,
        waiterId: parsed.data.waiterId,
        orderType: parsed.data.orderType,
        businessDate,
        cashierId: BigInt(req.auth!.sub),
      },
      include: orderInclude,
    });
    await writeAudit({ req, branchId: parsed.data.branchId, action: "order.create", entityType: "Order", entityId: order.id });
    return toJson({ order });
  });

  /**
   * POST /orders/with-items — atomic create + add lines.
   *
   * The new POS workflow assembles a draft client-side and pushes the whole thing
   * to a waiter box in one shot. This endpoint creates the order and all items
   * in a single transaction so a partial write is impossible — either we get
   * back a complete order, or nothing was written.
   *
   * Per-item: item must be active, must have an effective price (branch-specific
   * preferred, falling back to org-wide). Mid-batch failure rolls everything back.
   */
  app.post("/with-items", { preHandler: requirePermission("POS_BILL") }, async (req, reply) => {
    const parsed = CreateOrderWithItemsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const shift = await prisma.shift.findUnique({ where: { id: parsed.data.shiftId } });
    if (!shift) return reply.code(404).send({ error: "Shift not found" });
    if (shift.status !== "OPEN") return reply.code(409).send({ error: "Shift is not open" });
    if (shift.branchId !== parsed.data.branchId) {
      return reply.code(400).send({ error: "Shift does not belong to this branch" });
    }

    // Pre-fetch every item we'll touch — regular itemCodes plus the two codes of each mix.
    const allCodes = new Set<number>();
    for (const li of parsed.data.items) {
      if (li.itemCode) allCodes.add(li.itemCode);
      if (li.mixOf) for (const c of li.mixOf) allCodes.add(c);
    }
    const items = await prisma.item.findMany({
      where: { itemCode: { in: [...allCodes] }, isActive: true, deletedAt: null },
      include: {
        prices: {
          where: {
            OR: [{ branchId: parsed.data.branchId }, { branchId: null }],
            effectiveTo: null,
          },
          orderBy: [{ branchId: { sort: "desc", nulls: "last" } }, { effectiveFrom: "desc" }],
          take: 1,
        },
      },
    });
    const itemByCode = new Map(items.map((i) => [i.itemCode, i]));

    // Validate every line up front so we can fail fast (before opening a transaction)
    for (const li of parsed.data.items) {
      if (li.itemCode) {
        const it = itemByCode.get(li.itemCode);
        if (!it) return reply.code(404).send({ error: `Item code ${li.itemCode} not found or inactive` });
        if (!it.prices[0]) return reply.code(409).send({ error: `Item code ${li.itemCode} has no active price` });
      } else if (li.mixOf) {
        // 2-5 codes — all distinct, all active+priced, all the same size.
        const codes = li.mixOf;
        if (new Set(codes).size !== codes.length) {
          return reply.code(400).send({ error: `Mix needs distinct codes (got ${codes.join("+")})` });
        }
        const its = codes.map((c) => itemByCode.get(c));
        for (let i = 0; i < codes.length; i++) {
          const it = its[i];
          if (!it) return reply.code(404).send({ error: `Mix component code ${codes[i]} not found or inactive` });
          if (!it.prices[0]) return reply.code(409).send({ error: `Mix component ${it.name} (#${codes[i]}) has no active price` });
        }
        const sizes = new Set(its.map((it) => it!.size));
        if (sizes.size !== 1) {
          const detail = its.map((it) => `${it!.name} (${it!.size})`).join(" + ");
          return reply.code(400).send({ error: `Cannot mix different sizes: ${detail}` });
        }
      }
    }

    const businessDate = await getBranchBusinessDate(parsed.data.branchId);
    const orderNo = await nextOrderNo(parsed.data.branchId, businessDate);
    const created = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          orderNo,
          branchId: parsed.data.branchId,
          shiftId: parsed.data.shiftId,
          waiterBox: parsed.data.waiterBox,
          waiterId: parsed.data.waiterId,
          orderType: parsed.data.orderType,
          businessDate,
          customerName: parsed.data.customerName ?? null,
          cashierId: BigInt(req.auth!.sub),
        },
      });

      let subtotal = decimal(0);
      for (const li of parsed.data.items) {
        const qty = decimal(li.qty);
        if (li.mixOf) {
          // Custom mix (2-5 components): sort components by alphabetical name so display
          // and storage are deterministic. unitPrice = average of the N component prices.
          // itemId points to the alphabetically-first component for FK integrity; the line is
          // tagged isCustomMix=true with all components stored in JSON so the UI/receipt can
          // render the joined name correctly and salesDeduction can split stock 1/N per pulp.
          const sorted = li.mixOf
            .map((c) => itemByCode.get(c)!)
            .sort((x, y) => x.name.localeCompare(y.name));
          const sumPrice = sorted.reduce((s, it) => s.plus(it.prices[0].price), decimal(0));
          // Raw average then round UP to next multiple of 10 (owner's policy).
          const avgPrice = ceilToNext10(sumPrice.dividedBy(sorted.length));
          const lineTotal = avgPrice.times(qty);
          subtotal = subtotal.plus(lineTotal);
          await tx.orderItem.create({
            data: {
              orderId: order.id,
              itemId: sorted[0].id,            // FK anchor — alphabetically first
              qty,
              unitPrice: avgPrice,
              lineTotal,
              isCustomMix: true,
              customMixComponents: sorted.map((it) => ({
                itemCode: it.itemCode,
                name: it.name,
                size: it.size,
                price: it.prices[0].price.toString(),
              })) as Prisma.InputJsonValue,
              notes: li.notes,
            },
          });
        } else {
          const it = itemByCode.get(li.itemCode!)!;
          const unitPrice = it.prices[0].price;
          const lineTotal = unitPrice.times(qty);
          subtotal = subtotal.plus(lineTotal);
          await tx.orderItem.create({
            data: {
              orderId: order.id,
              itemId: it.id,
              qty,
              unitPrice,
              lineTotal,
              notes: li.notes,
            },
          });
        }
      }

      return tx.order.update({
        where: { id: order.id },
        data: { subtotal, total: subtotal },
        include: orderInclude,
      });
    });

    await writeAudit({
      req, branchId: parsed.data.branchId,
      action: "order.create.with_items",
      entityType: "Order", entityId: created.id,
      after: { orderNo, lineCount: parsed.data.items.length, total: created.total.toString() },
    });
    return toJson({ order: created });
  });

  /**
   * PUT /orders/:id/replace-items — replace ALL line items on an OPEN order.
   *
   * Used by the cashier's "edit order" flow (Shift+C from POS): they re-open
   * the OrderWindow pre-filled with the existing items, change anything, then
   * push back. This avoids the awkward "add one, remove one" dance and lets
   * them rebuild the order from scratch in one shot.
   *
   * Constraints:
   *   • Only allowed when order.status === "OPEN". PAID orders are immutable —
   *     editing a paid bill is an accounting smell; void + new order instead.
   *   • Items array follows the same shape as POST /with-items (itemCode OR mixOf).
   *   • Re-prices everything using the CURRENT effective price for each item.
   *     A price that drifted since the order was first placed will show in the
   *     new bill — desirable: the cashier expects fresh prices when they edit.
   *
   * Transactional: existing OrderItems are deleted + new ones inserted + total
   * recomputed in a single transaction. If anything fails the original order
   * is untouched.
   */
  /**
   * POST /orders/merge — combine 2-10 OPEN orders into the first one, void the rest.
   * Regular items are grouped by itemId (qty summed); mix items are kept as-is.
   * Requires POS_BILL — voiding of the non-target orders is an implementation detail.
   */
  app.post("/merge", { preHandler: requirePermission("POS_BILL") }, async (req, reply) => {
    const parsed = z.object({
      orderIds: z.array(z.coerce.bigint()).min(2).max(10),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const ids = parsed.data.orderIds;
    const targetId = ids[0];

    const orders = await prisma.order.findMany({
      where: { id: { in: ids } },
      include: { items: true },
    });

    if (orders.length !== ids.length) {
      return reply.code(404).send({ error: "One or more orders not found" });
    }

    const nonOpen = orders.filter((o) => o.status !== "OPEN");
    if (nonOpen.length > 0) {
      return reply.code(409).send({ error: `Orders must all be OPEN. Not open: ${nonOpen.map((o) => o.orderNo).join(", ")}` });
    }
    const branchId = orders[0].branchId;
    if (!orders.every((o) => o.branchId === branchId)) {
      return reply.code(400).send({ error: "All orders must belong to the same branch" });
    }
    const shiftId = orders[0].shiftId;
    if (!orders.every((o) => o.shiftId === shiftId)) {
      return reply.code(400).send({ error: "All orders must belong to the same shift" });
    }

    const target = orders.find((o) => o.id === targetId)!;
    const others = orders.filter((o) => o.id !== targetId);

    // Regular items: group by itemId, accumulate qty + lineTotal
    const regularMap = new Map<string, { itemId: bigint; qty: Prisma.Decimal; lineTotal: Prisma.Decimal }>();
    const mixItems: { itemId: bigint; qty: Prisma.Decimal; unitPrice: Prisma.Decimal; lineTotal: Prisma.Decimal; customMixComponents: Prisma.JsonValue }[] = [];

    for (const order of orders) {
      for (const item of order.items) {
        if (item.isCustomMix) {
          mixItems.push({ itemId: item.itemId, qty: item.qty, unitPrice: item.unitPrice, lineTotal: item.lineTotal, customMixComponents: item.customMixComponents });
        } else {
          const key = item.itemId.toString();
          if (regularMap.has(key)) {
            const ex = regularMap.get(key)!;
            regularMap.set(key, { itemId: item.itemId, qty: ex.qty.plus(item.qty), lineTotal: ex.lineTotal.plus(item.lineTotal) });
          } else {
            regularMap.set(key, { itemId: item.itemId, qty: item.qty, lineTotal: item.lineTotal });
          }
        }
      }
    }

    const merged = await prisma.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: targetId } });

      for (const { itemId, qty, lineTotal } of regularMap.values()) {
        const unitPrice = qty.isZero() ? decimal(0) : lineTotal.dividedBy(qty);
        await tx.orderItem.create({ data: { orderId: targetId, itemId, qty, unitPrice, lineTotal } });
      }
      for (const mix of mixItems) {
        await tx.orderItem.create({
          data: {
            orderId: targetId,
            itemId: mix.itemId,
            qty: mix.qty,
            unitPrice: mix.unitPrice,
            lineTotal: mix.lineTotal,
            isCustomMix: true,
            customMixComponents: mix.customMixComponents as Prisma.InputJsonValue,
          },
        });
      }

      const updatedOrder = await recomputeOrderTotal(tx, targetId);

      const now = new Date();
      for (const other of others) {
        await tx.order.update({
          where: { id: other.id },
          data: {
            status: "VOIDED",
            cancelReason: `Merged into order ${target.orderNo}`,
            cancelledById: BigInt(req.auth!.sub),
            cancelledAt: now,
          },
        });
      }

      return updatedOrder;
    });

    await writeAudit({
      req, branchId,
      action: "order.merge",
      entityType: "Order", entityId: targetId,
      after: { mergedOrderIds: others.map((o) => o.id.toString()), targetOrderNo: target.orderNo, itemCount: merged.items.length, total: merged.total.toString() },
    });
    return toJson({ order: merged });
  });

  app.put("/:id/replace-items", { preHandler: requirePermission("POS_BILL") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = z.object({
      items: CreateOrderWithItemsBody.shape.items,
      toBox: z.number().int().min(1).max(9).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, status: true, branchId: true } });
    if (!order) return reply.code(404).send({ error: "Order not found" });
    if (order.status !== "OPEN") return reply.code(409).send({ error: `Cannot edit order in status ${order.status}` });

    // Same pre-fetch + validation as POST /with-items — fail before opening a tx.
    const allCodes = new Set<number>();
    for (const li of parsed.data.items) {
      if (li.itemCode) allCodes.add(li.itemCode);
      if (li.mixOf) for (const c of li.mixOf) allCodes.add(c);
    }
    const items = await prisma.item.findMany({
      where: { itemCode: { in: [...allCodes] }, isActive: true, deletedAt: null },
      include: {
        prices: {
          where: { OR: [{ branchId: order.branchId }, { branchId: null }], effectiveTo: null },
          orderBy: [{ branchId: { sort: "desc", nulls: "last" } }, { effectiveFrom: "desc" }],
          take: 1,
        },
      },
    });
    const itemByCode = new Map(items.map((i) => [i.itemCode, i]));

    for (const li of parsed.data.items) {
      if (li.itemCode) {
        const it = itemByCode.get(li.itemCode);
        if (!it) return reply.code(404).send({ error: `Item code ${li.itemCode} not found or inactive` });
        if (!it.prices[0]) return reply.code(409).send({ error: `Item code ${li.itemCode} has no active price` });
      } else if (li.mixOf) {
        const codes = li.mixOf;
        if (new Set(codes).size !== codes.length) {
          return reply.code(400).send({ error: `Mix needs distinct codes (got ${codes.join("+")})` });
        }
        const its = codes.map((c) => itemByCode.get(c));
        for (let i = 0; i < codes.length; i++) {
          const it = its[i];
          if (!it) return reply.code(404).send({ error: `Mix component code ${codes[i]} not found or inactive` });
          if (!it.prices[0]) return reply.code(409).send({ error: `Mix component ${it.name} (#${codes[i]}) has no active price` });
        }
        const sizes = new Set(its.map((it) => it!.size));
        if (sizes.size !== 1) {
          const detail = its.map((it) => `${it!.name} (${it!.size})`).join(" + ");
          return reply.code(400).send({ error: `Cannot mix different sizes: ${detail}` });
        }
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Wipe existing lines (and their modifiers via cascade)
      await tx.orderItem.deleteMany({ where: { orderId: id } });

      let subtotal = decimal(0);
      for (const li of parsed.data.items) {
        const qty = decimal(li.qty);
        if (li.mixOf) {
          // Same N-way mix logic as POST /with-items — sort by name, average across N, store all.
          const sorted = li.mixOf
            .map((c) => itemByCode.get(c)!)
            .sort((x, y) => x.name.localeCompare(y.name));
          const sumPrice = sorted.reduce((s, it) => s.plus(it.prices[0].price), decimal(0));
          // Raw average then round UP to next multiple of 10 (owner's policy).
          const avgPrice = ceilToNext10(sumPrice.dividedBy(sorted.length));
          const lineTotal = avgPrice.times(qty);
          subtotal = subtotal.plus(lineTotal);
          await tx.orderItem.create({
            data: {
              orderId: id,
              itemId: sorted[0].id,
              qty, unitPrice: avgPrice, lineTotal,
              isCustomMix: true,
              customMixComponents: sorted.map((it) => ({
                itemCode: it.itemCode,
                name: it.name,
                size: it.size,
                price: it.prices[0].price.toString(),
              })) as Prisma.InputJsonValue,
              notes: li.notes,
            },
          });
        } else {
          const it = itemByCode.get(li.itemCode!)!;
          const unitPrice = it.prices[0].price;
          const lineTotal = unitPrice.times(qty);
          subtotal = subtotal.plus(lineTotal);
          await tx.orderItem.create({
            data: { orderId: id, itemId: it.id, qty, unitPrice, lineTotal, notes: li.notes },
          });
        }
      }

      // Move to a different box if requested.
      if (parsed.data.toBox !== undefined) {
        await tx.order.update({ where: { id }, data: { waiterBox: parsed.data.toBox } });
      }

      // Re-apply any existing discount, recompute total.
      return recomputeOrderTotal(tx, id);
    });

    await writeAudit({
      req, branchId: order.branchId,
      action: "order.replace.items", entityType: "Order", entityId: id,
      after: { lineCount: parsed.data.items.length, total: updated.total.toString() },
    });
    return toJson({ order: updated });
  });

  /** POST /orders/:id/items — add a line item to an open order */
  app.post("/:id/items", { preHandler: requirePermission("POS_BILL") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = AddItemBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return reply.code(404).send({ error: "Order not found" });
    if (order.status !== "OPEN") return reply.code(409).send({ error: `Order is ${order.status}` });

    const item = await prisma.item.findUnique({
      where: { itemCode: parsed.data.itemCode },
      include: {
        prices: {
          where: {
            OR: [{ branchId: order.branchId }, { branchId: null }],
            effectiveTo: null,
          },
          orderBy: [{ branchId: { sort: "desc", nulls: "last" } }, { effectiveFrom: "desc" }],
          take: 1,
        },
      },
    });
    if (!item || !item.isActive || item.deletedAt) {
      return reply.code(404).send({ error: "Item not available" });
    }
    const unitPrice = item.prices[0]?.price;
    if (!unitPrice) return reply.code(409).send({ error: "Item has no active price" });

    const modifiers = parsed.data.modifierIds?.length
      ? await prisma.modifier.findMany({ where: { id: { in: parsed.data.modifierIds }, isActive: true } })
      : [];
    const modifierDelta = modifiers.reduce((s, m) => s.plus(m.priceDelta), decimal(0));

    const qty = decimal(parsed.data.qty);
    const lineTotal = unitPrice.plus(modifierDelta).times(qty);

    const updated = await prisma.$transaction(async (tx) => {
      const line = await tx.orderItem.create({
        data: {
          orderId: order.id,
          itemId: item.id,
          qty,
          unitPrice,
          lineTotal,
          isCustomMix: parsed.data.isCustomMix ?? false,
          customMixComponents: parsed.data.customMixComponents
            ? (parsed.data.customMixComponents as unknown as Prisma.InputJsonValue)
            : undefined,
          notes: parsed.data.notes,
        },
      });
      if (modifiers.length > 0) {
        await tx.orderItemModifier.createMany({
          data: modifiers.map((m) => ({
            orderItemId: line.id,
            modifierId: m.id,
            priceDelta: m.priceDelta,
          })),
        });
      }
      return recomputeOrderTotal(tx, order.id);
    });
    return toJson({ order: updated });
  });

  /** DELETE /orders/:id/items/:lineId — remove a line item from an open order */
  app.delete("/:id/items/:lineId", { preHandler: requirePermission("POS_BILL") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const lineId = BigInt((req.params as { lineId: string }).lineId);
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return reply.code(404).send({ error: "Order not found" });
    if (order.status !== "OPEN") return reply.code(409).send({ error: `Order is ${order.status}` });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.orderItem.delete({ where: { id: lineId } });
      return recomputeOrderTotal(tx, order.id);
    });
    return toJson({ order: updated });
  });

  /** POST /orders/:id/discount — apply discount (permission-gated above 10%) */
  app.post("/:id/discount", { preHandler: requirePermission("POS_DISCOUNT_SMALL") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = ApplyDiscountBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return reply.code(404).send({ error: "Order not found" });
    if (order.status !== "OPEN") return reply.code(409).send({ error: `Order is ${order.status}` });

    // Compute absolute amount
    let amount: Prisma.Decimal;
    if (parsed.data.discountType === "PERCENT") {
      if (parsed.data.value > 100) return reply.code(400).send({ error: "Percent must be <= 100" });
      amount = order.subtotal.times(parsed.data.value).dividedBy(100);
    } else {
      amount = decimal(parsed.data.value);
    }

    // Enforce: discount > 10% of subtotal requires POS_DISCOUNT_LARGE
    const pctOfSubtotal = order.subtotal.greaterThan(0)
      ? amount.dividedBy(order.subtotal).times(100)
      : decimal(0);
    if (pctOfSubtotal.greaterThan(10)) {
      const hasLarge = await prisma.rolePermission.findFirst({
        where: {
          role: { code: { in: req.auth!.roles.map((r) => r.code) } },
          permission: { code: "POS_DISCOUNT_LARGE" },
        },
      });
      const isOwner = req.auth!.roles.some((r) => r.code === "OWNER");
      if (!hasLarge && !isOwner) {
        return reply.code(403).send({ error: "Discount above 10% requires manager approval (POS_DISCOUNT_LARGE)" });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.discountApplied.create({
        data: {
          orderId: order.id,
          discountType: parsed.data.discountType,
          amount,
          reason: parsed.data.reason,
          approvedById: BigInt(req.auth!.sub),
        },
      });
      return recomputeOrderTotal(tx, order.id);
    });
    await writeAudit({
      req, branchId: order.branchId,
      action: "order.discount",
      entityType: "Order", entityId: order.id,
      after: { type: parsed.data.discountType, value: parsed.data.value, amount: amount.toString() },
    });
    return toJson({ order: updated });
  });

  /** POST /orders/:id/pay — record a payment, close order when fully paid */
  app.post("/:id/pay", { preHandler: requirePermission("POS_BILL") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = PayBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const order = await prisma.order.findUnique({
      where: { id },
      include: { payments: { select: { amount: true } } },
    });
    if (!order) return reply.code(404).send({ error: "Order not found" });
    if (order.status !== "OPEN") return reply.code(409).send({ error: `Order is ${order.status}` });
    if (order.total.equals(0)) return reply.code(409).send({ error: "Order has no items" });

    const alreadyPaid = order.payments.reduce((s, p) => s.plus(p.amount), decimal(0));
    const due = order.total.minus(alreadyPaid);
    if (due.lessThanOrEqualTo(0)) {
      return reply.code(409).send({ error: "Order already fully paid" });
    }
    if (decimal(parsed.data.amount).greaterThan(due)) {
      // Allow overpay for CASH (change due is the caller's responsibility) but warn otherwise.
      if (parsed.data.method !== "CASH") {
        return reply.code(400).send({ error: "Payment exceeds amount due", due: due.toString() });
      }
    }

    const recordedAmount = parsed.data.method === "CASH"
      ? Prisma.Decimal.min(decimal(parsed.data.amount), due)  // record only what counts toward total
      : decimal(parsed.data.amount);

    const { updated, deductions } = await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          orderId: order.id,
          method: parsed.data.method,
          amount: recordedAmount,
          reference: parsed.data.reference,
        },
      });
      const sum = await tx.payment.aggregate({ _sum: { amount: true }, where: { orderId: order.id } });
      const paid = sum._sum.amount ?? decimal(0);

      if (paid.greaterThanOrEqualTo(order.total)) {
        // Transition to PAID. Deduct stock based on recipes — only happens on the
        // transition, so a partial-pay then complete-pay flow deducts once.
        const finalOrder = await tx.order.update({
          where: { id: order.id },
          data: { status: "PAID", closedAt: new Date() },
          include: orderInclude,
        });
        const events = await deductForOrder(tx, {
          orderId: order.id,
          branchId: order.branchId,
          performedById: BigInt(req.auth!.sub),
        });
        return { updated: finalOrder, deductions: events };
      }
      const stillOpen = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      return { updated: stillOpen, deductions: [] };
    });
    return toJson({
      order: updated,
      change: parsed.data.method === "CASH"
        ? Prisma.Decimal.max(decimal(parsed.data.amount).minus(due), decimal(0)).toString()
        : "0",
      deductions,
    });
  });

  /** POST /orders/:id/void — void with reason */
  app.post("/:id/void", { preHandler: requirePermission("POS_VOID") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = VoidBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Reason required (min 2 chars)" });

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return reply.code(404).send({ error: "Order not found" });
    if (order.status === "VOIDED" || order.status === "CANCELLED") {
      return reply.code(409).send({ error: `Order already ${order.status}` });
    }

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: "VOIDED",
        cancelReason: parsed.data.reason,
        cancelledById: BigInt(req.auth!.sub),
        cancelledAt: new Date(),
      },
      include: orderInclude,
    });
    await writeAudit({
      req, branchId: order.branchId,
      action: "order.void",
      entityType: "Order", entityId: order.id,
      before: { status: order.status },
      after: { status: "VOIDED", reason: parsed.data.reason },
    });
    return toJson({ order: updated });
  });
}
