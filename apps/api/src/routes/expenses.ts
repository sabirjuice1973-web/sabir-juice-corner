import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";
import { getBranchBusinessDate } from "../lib/businessDate.js";

/**
 * Daily Hisaab / expense entries — replaces the standalone "DAILY HISAAB" book
 * from the old desktop software (and its sibling pseudo-books like Markeet Bill).
 *
 * Each Expense row = one cash-out event:
 *   amount   = how much went out of cash
 *   category = head account (Shop Expense, Salary, Petrol, etc.) — picker from ExpenseCategory
 *   vendor   = free-text payee (worker name, shop name, etc.) — searchable in the ledger
 *   paidAt   = the real-world timestamp (used for receipts/audit)
 *   businessDate = the BRANCH's business day this expense counts toward — stamped from
 *                  branch.currentBusinessDate at create time so daily totals stay coherent
 *                  with sales when the shop runs past midnight.
 *   notes / description = free text
 *
 * Permission: OWNER, BRANCH_MANAGER, ACCOUNTANT can write. Anyone authenticated
 * can read (cashiers may glance at "today's cash out" total in the ledger).
 */

// Cash Paid replaces what was previously called "amount" in the UI — column
// name stays `amount` for DB stability. Allowed to be zero (credit purchases:
// goods received but not paid yet) and to differ from `total`.
const CreateBody = z.object({
  branchId: z.coerce.bigint(),
  categoryId: z.coerce.bigint(),
  amount: z.coerce.number().nonnegative().max(10_000_000),   // = Cash Paid
  // Transaction breakdown — all optional. quantity × rate = total (UI computes).
  productName: z.string().trim().max(120).nullable().optional(),
  quantity: z.coerce.number().nonnegative().max(1_000_000).nullable().optional(),
  rate: z.coerce.number().nonnegative().max(10_000_000).nullable().optional(),
  total: z.coerce.number().nonnegative().max(10_000_000).nullable().optional(),
  vendor: z.string().trim().max(120).nullable().optional(),   // = Supplier Name
  notes: z.string().trim().max(500).nullable().optional(),    // = Description
  paidById: z.coerce.bigint().optional(),                     // who handled the cash; defaults to req.auth.sub
  // Optional manual business-date override (for backdating with explicit intent).
  // If omitted, falls back to branch.currentBusinessDate.
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
});

const UpdateBody = z.object({
  categoryId: z.coerce.bigint().optional(),
  amount: z.coerce.number().nonnegative().max(10_000_000).optional(),
  productName: z.string().trim().max(120).nullable().optional(),
  quantity: z.coerce.number().nonnegative().max(1_000_000).nullable().optional(),
  rate: z.coerce.number().nonnegative().max(10_000_000).nullable().optional(),
  total: z.coerce.number().nonnegative().max(10_000_000).nullable().optional(),
  vendor: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
});

// `categoryIds` accepts a comma-separated list (?categoryIds=3,5,7) so the
// multi-select filter in the UI can request several head accounts at once.
// `categoryId` (single) is still honoured for backward compat.
const ListQuery = z.object({
  branchId: z.coerce.bigint().optional(),
  categoryId: z.coerce.bigint().optional(),
  categoryIds: z.string().optional().transform((s) => s ? s.split(",").filter(Boolean).map((id) => BigInt(id)) : undefined),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  vendor: z.string().trim().optional(),                      // contains-search on Supplier Name
  productName: z.string().trim().optional(),                 // contains-search on Product Name
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.coerce.bigint().optional(),
});

const CategoryBody = z.object({
  name: z.string().trim().min(1).max(80),
});

/** Owner / Branch Manager / Accountant can record cash-out. Cashier cannot — same
 *  rule as the business-date setter so the people who touch the books touch them. */
const ENTRY_ROLES = new Set(["OWNER", "BRANCH_MANAGER", "ACCOUNTANT"]);
function canWrite(roleCodes: string[]): boolean {
  return roleCodes.some((c) => ENTRY_ROLES.has(c));
}

export async function registerExpenseRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ─── Categories ────────────────────────────────────────────────────────

  /** GET /expenses/categories — list head accounts for the picker. */
  app.get("/categories", async () => {
    const cats = await prisma.expenseCategory.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });
    return toJson({ categories: cats.map((c) => ({ id: c.id, name: c.name })) });
  });

  /** POST /expenses/categories — create a new head account. */
  app.post("/categories", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can manage categories" });
    }
    const parsed = CategoryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const existing = await prisma.expenseCategory.findUnique({ where: { name: parsed.data.name } });
    if (existing) return reply.code(409).send({ error: "Category with that name already exists", id: existing.id.toString() });

    const cat = await prisma.expenseCategory.create({ data: { name: parsed.data.name } });
    await writeAudit({ req, action: "expense.category.create", entityType: "ExpenseCategory", entityId: cat.id, after: { name: cat.name } });
    return toJson({ category: { id: cat.id, name: cat.name } });
  });

  // ─── Entries ───────────────────────────────────────────────────────────

  /**
   * GET /expenses — ledger query with filters.
   *
   * Filters:
   *   branchId    — single branch (defaults to none = all branches the user can see)
   *   from / to   — businessDate range (YYYY-MM-DD, inclusive)
   *   categoryId  — single head account
   *   vendor      — case-insensitive contains-match on the vendor string
   *
   * Returns rows newest-first plus a `totalAmount` for the entire filtered set
   * (not just the page) — useful for the running total at the bottom of the screen.
   */
  app.get("/", async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query", details: q.error.flatten() });

    // categoryIds (multi-select) takes precedence over categoryId (single).
    // If both supplied, the IN list wins.
    const categoryFilter = q.data.categoryIds && q.data.categoryIds.length > 0
      ? { categoryId: { in: q.data.categoryIds } }
      : q.data.categoryId
        ? { categoryId: q.data.categoryId }
        : {};
    const where: Prisma.ExpenseWhereInput = {
      ...(q.data.branchId ? { branchId: q.data.branchId } : {}),
      ...categoryFilter,
      ...(q.data.vendor ? { vendor: { contains: q.data.vendor, mode: "insensitive" } } : {}),
      ...(q.data.productName ? { productName: { contains: q.data.productName, mode: "insensitive" } } : {}),
      ...(q.data.from || q.data.to ? {
        businessDate: {
          ...(q.data.from ? { gte: new Date(`${q.data.from}T00:00:00Z`) } : {}),
          ...(q.data.to   ? { lte: new Date(`${q.data.to}T00:00:00Z`) }   : {}),
        },
      } : {}),
      ...(q.data.cursor ? { id: { lt: q.data.cursor } } : {}),
    };

    const [rows, sum] = await Promise.all([
      prisma.expense.findMany({
        where,
        orderBy: [{ businessDate: "desc" }, { id: "desc" }],
        take: q.data.limit + 1,
        include: {
          category: { select: { id: true, name: true } },
          branch:   { select: { id: true, code: true, name: true } },
          paidBy:   { select: { id: true, fullName: true, username: true } },
        },
      }),
      prisma.expense.aggregate({ where, _sum: { amount: true, total: true }, _count: { _all: true } }),
    ]);
    const hasMore = rows.length > q.data.limit;
    const page = hasMore ? rows.slice(0, q.data.limit) : rows;

    return toJson({
      expenses: page.map(serializeExpense),
      nextCursor: hasMore ? page[page.length - 1].id.toString() : null,
      totals: {
        count: sum._count._all,
        amount: (sum._sum.amount ?? new Prisma.Decimal(0)).toString(),
        total:  (sum._sum.total  ?? new Prisma.Decimal(0)).toString(),
      },
    });
  });

  /**
   * GET /expenses/suggestions — distinct product names and supplier names already
   * recorded at this branch. Drives the autocomplete on the entry form so the
   * owner can re-use payee names ("M.Karimullah", "DAILY HISAB") and product
   * names ("Petrol Motorcycle", "Khana Irke") without retyping them.
   */
  app.get("/suggestions", async (req, reply) => {
    const q = z.object({ branchId: z.coerce.bigint().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query" });

    const where: Prisma.ExpenseWhereInput = q.data.branchId ? { branchId: q.data.branchId } : {};
    const [products, suppliers] = await Promise.all([
      prisma.expense.findMany({
        where: { ...where, productName: { not: null } },
        distinct: ["productName"],
        select: { productName: true },
        orderBy: { productName: "asc" },
        take: 500,
      }),
      prisma.expense.findMany({
        where: { ...where, vendor: { not: null } },
        distinct: ["vendor"],
        select: { vendor: true },
        orderBy: { vendor: "asc" },
        take: 500,
      }),
    ]);
    return toJson({
      products: products.map((r) => r.productName).filter((s): s is string => !!s),
      suppliers: suppliers.map((r) => r.vendor).filter((s): s is string => !!s),
    });
  });

  /** POST /expenses — record one cash-out entry. */
  app.post("/", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can record expenses" });
    }
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    // Validate FKs before opening any write — cleaner 400s than a Prisma FK error.
    const [branch, category] = await Promise.all([
      prisma.branch.findUnique({ where: { id: parsed.data.branchId }, select: { id: true } }),
      prisma.expenseCategory.findUnique({ where: { id: parsed.data.categoryId }, select: { id: true, name: true } }),
    ]);
    if (!branch)   return reply.code(404).send({ error: "Branch not found" });
    if (!category) return reply.code(404).send({ error: "Category not found" });

    // Resolve businessDate — explicit override wins, otherwise the branch's current.
    const businessDate = parsed.data.businessDate
      ? new Date(`${parsed.data.businessDate.slice(0, 10)}T00:00:00Z`)
      : await getBranchBusinessDate(parsed.data.branchId);

    const paidById = parsed.data.paidById ?? BigInt(req.auth.sub);

    const created = await prisma.expense.create({
      data: {
        branchId: parsed.data.branchId,
        categoryId: parsed.data.categoryId,
        amount: new Prisma.Decimal(parsed.data.amount),
        productName: parsed.data.productName ?? null,
        quantity: parsed.data.quantity != null ? new Prisma.Decimal(parsed.data.quantity) : null,
        rate:     parsed.data.rate     != null ? new Prisma.Decimal(parsed.data.rate)     : null,
        total:    parsed.data.total    != null ? new Prisma.Decimal(parsed.data.total)    : null,
        vendor: parsed.data.vendor ?? null,
        notes: parsed.data.notes ?? null,
        businessDate,
        paidById,
      },
      include: { category: true, branch: true, paidBy: true },
    });

    await writeAudit({
      req, branchId: parsed.data.branchId,
      action: "expense.create", entityType: "Expense", entityId: created.id,
      after: {
        amount: created.amount.toString(),
        total: created.total?.toString() ?? null,
        category: category.name,
        productName: created.productName,
        vendor: created.vendor,
        businessDate: created.businessDate.toISOString().slice(0, 10),
      },
    });

    return toJson({ expense: serializeExpense(created) });
  });

  /** PATCH /expenses/:id — edit an existing entry. */
  app.patch("/:id", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can edit expenses" });
    }
    const id = BigInt((req.params as { id: string }).id);
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const before = await prisma.expense.findUnique({ where: { id }, include: { category: true } });
    if (!before) return reply.code(404).send({ error: "Expense not found" });

    // If category is changing, validate it exists.
    if (parsed.data.categoryId && parsed.data.categoryId !== before.categoryId) {
      const cat = await prisma.expenseCategory.findUnique({ where: { id: parsed.data.categoryId } });
      if (!cat) return reply.code(404).send({ error: "Category not found" });
    }

    const updated = await prisma.expense.update({
      where: { id },
      data: {
        ...(parsed.data.categoryId !== undefined ? { categoryId: parsed.data.categoryId } : {}),
        ...(parsed.data.amount !== undefined ? { amount: new Prisma.Decimal(parsed.data.amount) } : {}),
        ...(parsed.data.productName !== undefined ? { productName: parsed.data.productName } : {}),
        ...(parsed.data.quantity !== undefined ? { quantity: parsed.data.quantity != null ? new Prisma.Decimal(parsed.data.quantity) : null } : {}),
        ...(parsed.data.rate !== undefined ? { rate: parsed.data.rate != null ? new Prisma.Decimal(parsed.data.rate) : null } : {}),
        ...(parsed.data.total !== undefined ? { total: parsed.data.total != null ? new Prisma.Decimal(parsed.data.total) : null } : {}),
        ...(parsed.data.vendor !== undefined ? { vendor: parsed.data.vendor } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        ...(parsed.data.businessDate ? { businessDate: new Date(`${parsed.data.businessDate.slice(0, 10)}T00:00:00Z`) } : {}),
      },
      include: { category: true, branch: true, paidBy: true },
    });

    await writeAudit({
      req, branchId: before.branchId,
      action: "expense.update", entityType: "Expense", entityId: id,
      before: { amount: before.amount.toString(), total: before.total?.toString() ?? null, category: before.category.name, productName: before.productName, vendor: before.vendor, businessDate: before.businessDate.toISOString().slice(0, 10) },
      after:  { amount: updated.amount.toString(), total: updated.total?.toString() ?? null, category: updated.category.name, productName: updated.productName, vendor: updated.vendor, businessDate: updated.businessDate.toISOString().slice(0, 10) },
    });

    return toJson({ expense: serializeExpense(updated) });
  });

  /**
   * DELETE /expenses/:id — only OWNER (and not just the entry-roles set).
   * Destructive on a financial record so we keep the gate tight; audit log
   * captures the full row so reconstruction is still possible.
   */
  app.delete("/:id", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!req.auth.roles.some((r) => r.code === "OWNER")) {
      return reply.code(403).send({ error: "Only OWNER can delete an expense" });
    }
    const id = BigInt((req.params as { id: string }).id);
    const before = await prisma.expense.findUnique({ where: { id }, include: { category: true } });
    if (!before) return reply.code(404).send({ error: "Expense not found" });

    await prisma.expense.delete({ where: { id } });
    await writeAudit({
      req, branchId: before.branchId,
      action: "expense.delete", entityType: "Expense", entityId: id,
      before: {
        amount: before.amount.toString(),
        total: before.total?.toString() ?? null,
        category: before.category.name,
        productName: before.productName,
        vendor: before.vendor,
        notes: before.notes,
        businessDate: before.businessDate.toISOString().slice(0, 10),
      },
    });
    return reply.code(204).send();
  });
}

/**
 * Shared serializer — every endpoint that returns an Expense uses this so the
 * client-facing shape stays consistent (and so future field additions get picked
 * up automatically by every endpoint).
 */
function serializeExpense(e: any) {
  return {
    id: e.id.toString(),
    amount: e.amount.toString(),                      // Cash Paid
    productName: e.productName,
    quantity: e.quantity?.toString() ?? null,
    rate:     e.rate?.toString()     ?? null,
    total:    e.total?.toString()    ?? null,
    vendor: e.vendor,                                  // Supplier Name
    notes: e.notes,                                    // Description
    businessDate: e.businessDate.toISOString().slice(0, 10),
    paidAt: e.paidAt.toISOString(),
    category: { id: e.category.id.toString(), name: e.category.name },
    branch:   { id: e.branch.id.toString(),   code: e.branch.code, name: e.branch.name },
    paidBy:   e.paidBy ? { id: e.paidBy.id.toString(), fullName: e.paidBy.fullName, username: e.paidBy.username } : null,
  };
}
