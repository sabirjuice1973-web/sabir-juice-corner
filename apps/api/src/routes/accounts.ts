import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";
import { getBranchBusinessDate } from "../lib/businessDate.js";

/**
 * Customer / partner accounts — the creditor ledger.
 *
 * Concepts:
 *   • Account: a named entity that owes us money on a rolling basis.
 *       FOODPANDA: one per branch, billing cycle Mon-Sun, paid Tuesday.
 *       MARKET:    nearby shopkeepers (one per name).
 *       CUSTOMER:  walk-in credit customers (one per name).
 *   • Push-to-account: moves a PAID order's cash bucket to "credit", linking
 *     the Order to the Account. The order STAYS in PAID status — revenue is
 *     recognised on delivery; the cash hasn't arrived but is now owed by the
 *     account. The owner settles it later via a payment.
 *   • Account payment: a cash receipt against the account, optionally with a
 *     discount (Food Panda commission write-off, customer goodwill, etc.).
 *     May be split across multiple orders or applied to the running balance.
 *
 * Balance math (all values in PKR Decimal(12,2)):
 *   gross_owed   = sum(order.total) for orders.accountId = X
 *   paid_so_far  = sum(payment.amount + payment.discount) for payments.accountId = X
 *   current_bal  = gross_owed − paid_so_far    (positive = customer owes us)
 *
 * Permission: OWNER, BRANCH_MANAGER, ACCOUNTANT can write.
 */

const WRITE_ROLES = new Set(["OWNER", "BRANCH_MANAGER", "ACCOUNTANT"]);
function canWrite(roleCodes: string[]): boolean {
  return roleCodes.some((c) => WRITE_ROLES.has(c));
}

const CreateAccountBody = z.object({
  branchId: z.coerce.bigint(),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["FOODPANDA", "MARKET", "CUSTOMER"]),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(500).optional(),
});

const ListQuery = z.object({
  branchId: z.coerce.bigint(),
  type: z.enum(["FOODPANDA", "MARKET", "CUSTOMER"]).optional(),
  search: z.string().trim().optional(),
  includeInactive: z.coerce.boolean().optional(),
});

const PushBody = z.object({
  // Either: provide accountId (existing account) — used by Box 6 Food Panda push
  accountId: z.coerce.bigint().optional(),
  // Or: provide type + name to auto-create/find by name — used by creditor push
  type: z.enum(["FOODPANDA", "MARKET", "CUSTOMER"]).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(40).optional(),
});

const RecordPaymentBody = z.object({
  amount: z.coerce.number().nonnegative().max(10_000_000),
  discount: z.coerce.number().nonnegative().max(10_000_000).default(0),
  method: z.enum(["CASH", "CARD", "WALLET", "CREDIT", "BANK_TRANSFER"]).default("CASH"),
  reference: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  // Optional per-order application — owner can mark which orders this payment settles.
  // appliedAmount per orderId — order.total is the implicit target if not given.
  orderApplications: z.array(z.object({
    orderId: z.coerce.bigint(),
    appliedAmount: z.coerce.number().positive(),
  })).optional(),
});

export async function registerAccountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ─── List + lookup ────────────────────────────────────────────────────

  /** GET /accounts — list accounts with cached balances. */
  app.get("/", async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query", details: q.error.flatten() });

    const accounts = await prisma.account.findMany({
      where: {
        branchId: q.data.branchId,
        ...(q.data.type ? { type: q.data.type } : {}),
        ...(q.data.search ? { name: { contains: q.data.search, mode: "insensitive" } } : {}),
        ...(q.data.includeInactive ? {} : { isActive: true }),
        deletedAt: null,
      },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });

    // Aggregate balance in one go.
    const balances = await accountBalances(accounts.map((a) => a.id));

    return toJson({
      accounts: accounts.map((a) => ({
        id: a.id.toString(),
        name: a.name,
        type: a.type,
        phone: a.phone,
        notes: a.notes,
        isActive: a.isActive,
        ...balances.get(a.id.toString())!,
      })),
    });
  });

  /** GET /accounts/:id — single account with orders + payments + balance. */
  app.get("/:id", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const a = await prisma.account.findUnique({
      where: { id },
      include: { branch: { select: { id: true, name: true, code: true } } },
    });
    if (!a) return reply.code(404).send({ error: "Account not found" });

    const [orders, payments] = await Promise.all([
      prisma.order.findMany({
        where: { accountId: id },
        orderBy: { businessDate: "desc" },
        select: {
          id: true, orderNo: true, total: true, businessDate: true, openedAt: true,
          customerName: true,
          accountPaymentLinks: { select: { paymentId: true, appliedAmount: true } },
          items: { select: { qty: true, item: { select: { name: true, size: true } } } },
        },
        take: 200,
      }),
      prisma.accountPayment.findMany({
        where: { accountId: id },
        orderBy: { paidAt: "desc" },
        include: { recordedBy: { select: { fullName: true, username: true } }, orderLinks: { select: { orderId: true, appliedAmount: true } } },
        take: 200,
      }),
    ]);

    const balances = await accountBalances([id]);

    // Per-order "amountPaid" rollup so the UI can show outstanding per-order.
    const orderPaid = new Map<string, Prisma.Decimal>();
    for (const o of orders) {
      let sum = new Prisma.Decimal(0);
      for (const lk of o.accountPaymentLinks) sum = sum.plus(lk.appliedAmount);
      orderPaid.set(o.id.toString(), sum);
    }

    return toJson({
      id: a.id.toString(),
      name: a.name,
      type: a.type,
      phone: a.phone,
      notes: a.notes,
      isActive: a.isActive,
      branch: { id: a.branch.id.toString(), code: a.branch.code, name: a.branch.name },
      ...balances.get(a.id.toString())!,
      orders: orders.map((o) => {
        const paid = orderPaid.get(o.id.toString()) ?? new Prisma.Decimal(0);
        const outstanding = o.total.minus(paid);
        return {
          id: o.id.toString(),
          orderNo: o.orderNo,
          total: o.total.toString(),
          paid: paid.toString(),
          outstanding: outstanding.toString(),
          businessDate: o.businessDate.toISOString().slice(0, 10),
          openedAt: o.openedAt.toISOString(),
          customerName: o.customerName,
          itemsSummary: o.items.map((it) => `${it.qty}× ${it.item.name}${it.item.size !== "NA" ? " " + it.item.size : ""}`).join(", "),
        };
      }),
      payments: payments.map((p) => ({
        id: p.id.toString(),
        amount: p.amount.toString(),
        discount: p.discount.toString(),
        method: p.method,
        paidAt: p.paidAt.toISOString(),
        businessDate: p.businessDate.toISOString().slice(0, 10),
        notes: p.notes,
        recordedBy: p.recordedBy?.fullName ?? null,
        orderLinks: p.orderLinks.map((lk) => ({ orderId: lk.orderId.toString(), appliedAmount: lk.appliedAmount.toString() })),
      })),
    });
  });

  /** POST /accounts — manually create an account (e.g. for Food Panda before any orders). */
  app.post("/", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can create accounts" });
    }
    const parsed = CreateAccountBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const existing = await prisma.account.findUnique({
      where: { branchId_name_type: { branchId: parsed.data.branchId, name: parsed.data.name, type: parsed.data.type } },
    });
    if (existing) return reply.code(200).send({ account: serializeAccount(existing), existed: true });

    const created = await prisma.account.create({
      data: {
        branchId: parsed.data.branchId,
        name: parsed.data.name,
        type: parsed.data.type,
        phone: parsed.data.phone ?? null,
        notes: parsed.data.notes ?? null,
      },
    });
    await writeAudit({ req, branchId: parsed.data.branchId, action: "account.create", entityType: "Account", entityId: created.id, after: { name: created.name, type: created.type } });
    return toJson({ account: serializeAccount(created), existed: false });
  });

  // ─── Push order to account ────────────────────────────────────────────

  /**
   * POST /orders/push-to-account would normally live in orders.ts but logically
   * it belongs here. We mount it under /accounts/push-order for visibility:
   *   POST /accounts/push-order { orderId, accountId? | (type + name) }
   *
   * Behaviour:
   *   - Resolves the account (by id, or auto-find/create by type+name).
   *   - Marks the order PAID with a single Payment row (method=CREDIT, amount=total).
   *   - Sets order.accountId.
   *   - Returns the updated order + the account's new balance.
   *
   * Only OPEN orders can be pushed. Calling twice is rejected (409).
   */
  app.post("/push-order", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can push to account" });
    }
    const Body = z.object({
      orderId: z.coerce.bigint(),
    }).merge(PushBody);
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId } });
    if (!order) return reply.code(404).send({ error: "Order not found" });
    if (order.status !== "OPEN") return reply.code(409).send({ error: `Order is ${order.status}; only OPEN orders can be pushed to account` });

    // Resolve / create account.
    let accountId: bigint;
    if (parsed.data.accountId) {
      const a = await prisma.account.findUnique({ where: { id: parsed.data.accountId } });
      if (!a) return reply.code(404).send({ error: "Account not found" });
      if (a.branchId !== order.branchId) return reply.code(400).send({ error: "Account does not belong to this branch" });
      accountId = a.id;
    } else if (parsed.data.type && parsed.data.name) {
      // Find-or-create by (branch, name, type)
      const found = await prisma.account.findUnique({
        where: { branchId_name_type: { branchId: order.branchId, name: parsed.data.name, type: parsed.data.type } },
      });
      if (found) {
        accountId = found.id;
      } else {
        const created = await prisma.account.create({
          data: { branchId: order.branchId, name: parsed.data.name, type: parsed.data.type, phone: parsed.data.phone ?? null },
        });
        accountId = created.id;
      }
    } else {
      return reply.code(400).send({ error: "Provide either accountId, or type + name" });
    }

    // In a transaction: write CREDIT payment, mark order PAID, set accountId.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          orderId: order.id,
          method: "CREDIT",
          amount: order.total,
        },
      });
      return tx.order.update({
        where: { id: order.id },
        data: { status: "PAID", closedAt: new Date(), accountId },
      });
    });

    await writeAudit({
      req, branchId: order.branchId,
      action: "order.push-to-account", entityType: "Order", entityId: order.id,
      after: { accountId: accountId.toString(), amount: order.total.toString() },
    });

    const balances = await accountBalances([accountId]);
    return toJson({
      ok: true,
      order: { id: updated.id.toString(), status: updated.status, accountId: accountId.toString() },
      ...balances.get(accountId.toString())!,
    });
  });

  // ─── Payment recording ────────────────────────────────────────────────

  /**
   * POST /accounts/:id/payments
   *
   * Records a cash receipt. Body fields:
   *   amount               — cash in (PKR)
   *   discount             — written off (commission / goodwill)
   *   method, reference    — how the payment came in
   *   orderApplications    — optional list of {orderId, appliedAmount} to mark
   *                          specific orders as settled. The system DOES NOT
   *                          enforce that sum(appliedAmount) == amount; the
   *                          balance is recomputed from the full set of
   *                          payments + orders, so the link is just an audit aid.
   */
  app.post("/:id/payments", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can record payments" });
    }
    const id = BigInt((req.params as { id: string }).id);
    const parsed = RecordPaymentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const a = await prisma.account.findUnique({ where: { id } });
    if (!a) return reply.code(404).send({ error: "Account not found" });

    if (parsed.data.amount === 0 && parsed.data.discount === 0) {
      return reply.code(400).send({ error: "Amount and discount cannot both be zero" });
    }

    const businessDate = parsed.data.businessDate
      ? new Date(`${parsed.data.businessDate.slice(0, 10)}T00:00:00Z`)
      : await getBranchBusinessDate(a.branchId);

    const created = await prisma.$transaction(async (tx) => {
      const p = await tx.accountPayment.create({
        data: {
          accountId: id,
          amount: new Prisma.Decimal(parsed.data.amount),
          discount: new Prisma.Decimal(parsed.data.discount),
          method: parsed.data.method,
          reference: parsed.data.reference ?? null,
          notes: parsed.data.notes ?? null,
          businessDate,
          recordedById: BigInt(req.auth!.sub),
        },
      });
      if (parsed.data.orderApplications && parsed.data.orderApplications.length > 0) {
        for (const oa of parsed.data.orderApplications) {
          await tx.accountPaymentOrderLink.create({
            data: { paymentId: p.id, orderId: oa.orderId, appliedAmount: new Prisma.Decimal(oa.appliedAmount) },
          });
        }
      }
      return p;
    });

    await writeAudit({
      req, branchId: a.branchId,
      action: "account.payment.create", entityType: "AccountPayment", entityId: created.id,
      after: { accountId: id.toString(), amount: parsed.data.amount, discount: parsed.data.discount, method: parsed.data.method, applicationsCount: parsed.data.orderApplications?.length ?? 0 },
    });

    const balances = await accountBalances([id]);
    return toJson({ paymentId: created.id.toString(), ...balances.get(id.toString())! });
  });

  /** DELETE /accounts/:accountId/payments/:paymentId — undo a payment (owner-only). */
  app.delete("/:accountId/payments/:paymentId", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!req.auth.roles.some((r) => r.code === "OWNER")) {
      return reply.code(403).send({ error: "Only OWNER can delete a payment" });
    }
    const accountId = BigInt((req.params as { accountId: string; paymentId: string }).accountId);
    const paymentId = BigInt((req.params as { accountId: string; paymentId: string }).paymentId);
    const p = await prisma.accountPayment.findUnique({ where: { id: paymentId } });
    if (!p || p.accountId !== accountId) return reply.code(404).send({ error: "Payment not found" });
    await prisma.accountPayment.delete({ where: { id: paymentId } });
    await writeAudit({ req, action: "account.payment.delete", entityType: "AccountPayment", entityId: paymentId, before: { amount: p.amount.toString(), discount: p.discount.toString() } });
    return reply.code(204).send();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────

function serializeAccount(a: any) {
  return {
    id: a.id.toString(),
    branchId: a.branchId.toString(),
    name: a.name,
    type: a.type,
    phone: a.phone,
    notes: a.notes,
    isActive: a.isActive,
  };
}

/**
 * Compute current balances for a set of accounts in one round-trip.
 * Returns Map<accountId-string, { grossOwed, totalReceived, totalDiscount, currentBalance }>
 */
async function accountBalances(accountIds: bigint[]) {
  const result = new Map<string, {
    grossOwed: string;
    totalReceived: string;
    totalDiscount: string;
    currentBalance: string;
    orderCount: number;
    paymentCount: number;
  }>();
  if (accountIds.length === 0) return result;

  const [orderAgg, paymentAgg] = await Promise.all([
    prisma.order.groupBy({
      by: ["accountId"],
      where: { accountId: { in: accountIds } },
      _sum: { total: true },
      _count: { _all: true },
    }),
    prisma.accountPayment.groupBy({
      by: ["accountId"],
      where: { accountId: { in: accountIds } },
      _sum: { amount: true, discount: true },
      _count: { _all: true },
    }),
  ]);
  const ordersById = new Map(orderAgg.map((r) => [r.accountId?.toString() ?? "", r]));
  const paymentsById = new Map(paymentAgg.map((r) => [r.accountId.toString(), r]));

  for (const id of accountIds) {
    const k = id.toString();
    const o = ordersById.get(k);
    const p = paymentsById.get(k);
    const gross = o?._sum.total ?? new Prisma.Decimal(0);
    const received = p?._sum.amount ?? new Prisma.Decimal(0);
    const discount = p?._sum.discount ?? new Prisma.Decimal(0);
    const balance = gross.minus(received).minus(discount);
    result.set(k, {
      grossOwed: gross.toString(),
      totalReceived: received.toString(),
      totalDiscount: discount.toString(),
      currentBalance: balance.toString(),
      orderCount: o?._count._all ?? 0,
      paymentCount: p?._count._all ?? 0,
    });
  }
  return result;
}
