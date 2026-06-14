import type OpenAI from "openai";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { branchPnL, itemProfitability, varianceReport } from "./reportsService.js";

/**
 * Read-only tools exposed to the owner assistant.
 *
 * All tools:
 *   • are pure reads — they never mutate state
 *   • return small, summarized JSON (the LLM context is precious)
 *   • use stable shapes; their schemas live next to the executors so it's hard
 *     to let the two drift
 *
 * Naming convention is snake_case so the LLM's function-call interface stays
 * consistent with its training distribution.
 *
 * Defined as a SORTED array so the JSON payload is byte-stable across requests.
 * OpenAI applies automatic prompt caching to identical leading prompt portions,
 * so a stable, sorted tool list maximizes cache hits.
 */

export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_alert_summary",
      description: "Counts of open (unacknowledged) alerts by severity for the last N days. Use this for 'are there any issues?' questions.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 90, description: "Look back window in days (default 7)" },
          branchId: { type: "integer", description: "Optional: scope to a single branch" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_branch_pnl",
      description: "Branch profit & loss for a date range. Returns sales, discounts, COGS (from active recipes and latest GRN rates), expenses, net profit, and net margin %.",
      parameters: {
        type: "object",
        properties: {
          branchId: { type: "integer", description: "Branch ID (1 = central kitchen, 2 = Branch 1, etc.)" },
          from: { type: "string", description: "Start date YYYY-MM-DD" },
          to: { type: "string", description: "End date YYYY-MM-DD" },
        },
        required: ["branchId", "from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_item_profitability",
      description: "Per-item sales, revenue, COGS, profit, and margin % for a date range. Useful for 'which items are most/least profitable' questions.",
      parameters: {
        type: "object",
        properties: {
          branchId: { type: "integer", description: "Optional branch filter" },
          from: { type: "string", description: "Start date YYYY-MM-DD" },
          to: { type: "string", description: "End date YYYY-MM-DD" },
          topN: { type: "integer", minimum: 1, maximum: 50, description: "Return top N by profit (default 10)" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_open_alerts",
      description: "Detail of currently open (unacknowledged) alerts. Each alert has severity, rule code, message, and branch. Use when the user wants to know what to act on.",
      parameters: {
        type: "object",
        properties: {
          branchId: { type: "integer", description: "Optional branch filter" },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Max alerts to return (default 20)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_orders",
      description: "Recent paid orders, newest first. Returns order_no, branch, total, openedAt, item count.",
      parameters: {
        type: "object",
        properties: {
          branchId: { type: "integer", description: "Optional branch filter" },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Number of orders (default 10)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_levels",
      description: "Current stock on hand. Each row: location, branch, item name, quantity, unit, reorder threshold. NEGATIVE quantity = leakage signal.",
      parameters: {
        type: "object",
        properties: {
          branchId: { type: "integer", description: "Optional branch filter" },
          stockableType: {
            type: "string",
            enum: ["RAW_MATERIAL", "PROCESSED_PRODUCT", "PACKAGING"],
            description: "Optional type filter",
          },
          lowStockOnly: { type: "boolean", description: "Return only items at or below reorder level" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_supplier_ledger",
      description: "Outstanding balance and recent activity for a supplier. Use for 'how much do we owe X?' questions.",
      parameters: {
        type: "object",
        properties: {
          supplierId: { type: "integer", description: "Supplier ID" },
        },
        required: ["supplierId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_variance_report",
      description: "Stock variance for a branch over a date range. Compares received - sold - wasted - current_stock for each processed product. Positive variance = stock disappeared (leakage signal).",
      parameters: {
        type: "object",
        properties: {
          branchId: { type: "integer", description: "Branch ID (1 = central kitchen, 2 = Branch 1, 3 = Branch 2, 4 = Branch 3)" },
          from: { type: "string", description: "Start date YYYY-MM-DD" },
          to: { type: "string", description: "End date YYYY-MM-DD" },
        },
        required: ["branchId", "from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_branches",
      description: "All active branches with id, code, name. Call this first if the user names a branch and you don't know its ID.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_suppliers",
      description: "All active suppliers with id, name, phone, payment terms. Call this first if the user names a supplier you don't know.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ─── Tool execution (provider-agnostic) ────────────────────────────────────

type ToolInput = Record<string, any>;

/** Execute a tool call. Returns a JSON-stringifiable value. */
export async function executeTool(name: string, input: ToolInput): Promise<unknown> {
  switch (name) {
    case "list_branches": {
      const branches = await prisma.branch.findMany({
        where: { status: "ACTIVE" },
        select: { id: true, code: true, name: true, city: true, isCentralKitchen: true },
        orderBy: { id: "asc" },
      });
      return branches.map((b) => ({ id: Number(b.id), code: b.code, name: b.name, city: b.city, isCentralKitchen: b.isCentralKitchen }));
    }

    case "list_suppliers": {
      const suppliers = await prisma.supplier.findMany({
        where: { isActive: true },
        select: { id: true, name: true, phone: true, paymentTermsDays: true },
        orderBy: { name: "asc" },
      });
      return suppliers.map((s) => ({ id: Number(s.id), name: s.name, phone: s.phone, paymentTermsDays: s.paymentTermsDays }));
    }

    case "get_variance_report": {
      const r = await varianceReport({
        branchId: BigInt(input.branchId),
        from: input.from,
        to: input.to,
      });
      return {
        branchId: r.branchId,
        from: r.from,
        to: r.to,
        rows: r.rows.map((row) => ({
          name: row.name,
          unit: row.unit,
          received: row.totalIn,
          sold: row.salesOut,
          wasted: row.wastageOut,
          currentStock: row.currentLevel,
          variance: row.variance,
          variancePct: row.variancePct,
          expectedGlasses: row.expectedGlasses,
          glassesSold: row.glassesSold,
          glassesVariance: row.glassesVariance,
        })),
      };
    }

    case "get_branch_pnl": {
      const r = await branchPnL({
        branchId: BigInt(input.branchId),
        from: input.from,
        to: input.to,
      });
      return r;
    }

    case "get_item_profitability": {
      const r = await itemProfitability({
        branchId: input.branchId ? BigInt(input.branchId) : undefined,
        from: input.from,
        to: input.to,
      });
      const topN = input.topN ?? 10;
      return {
        from: r.from,
        to: r.to,
        rows: r.rows.slice(0, topN).map((row) => ({
          itemCode: row.itemCode,
          name: row.name,
          qtySold: row.qtySold,
          revenue: row.revenue,
          cogsPerUnit: row.cogsPerUnit,
          profit: row.profit,
          marginPct: row.marginPct,
        })),
      };
    }

    case "get_stock_levels": {
      const branchId = input.branchId ? BigInt(input.branchId) : undefined;
      const locations = await prisma.stockLocation.findMany({
        where: { isActive: true, ...(branchId ? { branchId } : {}) },
        include: { branch: { select: { code: true, name: true } } },
      });
      const levels = await prisma.stockLevel.findMany({
        where: {
          locationId: { in: locations.map((l) => l.id) },
          ...(input.stockableType ? { stockableType: input.stockableType } : {}),
        },
        include: { unit: { select: { code: true } } },
      });
      const rawIds = levels.filter((l) => l.stockableType === "RAW_MATERIAL").map((l) => l.stockableId);
      const procIds = levels.filter((l) => l.stockableType === "PROCESSED_PRODUCT").map((l) => l.stockableId);
      const [raws, procs] = await Promise.all([
        rawIds.length ? prisma.rawMaterial.findMany({ where: { id: { in: rawIds } }, select: { id: true, name: true, reorderLevel: true } }) : Promise.resolve([]),
        procIds.length ? prisma.processedProduct.findMany({ where: { id: { in: procIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      ]);
      const rawById = new Map(raws.map((r) => [r.id.toString(), r]));
      const procById = new Map(procs.map((p) => [p.id.toString(), p]));
      const locById = new Map(locations.map((l) => [l.id.toString(), l]));

      let rows = levels.map((l) => {
        const loc = locById.get(l.locationId.toString())!;
        const name =
          l.stockableType === "RAW_MATERIAL" ? rawById.get(l.stockableId.toString())?.name
          : l.stockableType === "PROCESSED_PRODUCT" ? procById.get(l.stockableId.toString())?.name
          : null;
        const reorderLevel = l.stockableType === "RAW_MATERIAL"
          ? rawById.get(l.stockableId.toString())?.reorderLevel
          : null;
        return {
          branch: loc.branch.name,
          location: loc.name,
          locationType: loc.type,
          type: l.stockableType,
          name: name ?? `(unknown #${l.stockableId})`,
          quantity: l.quantity.toString(),
          unit: l.unit.code,
          reorderLevel: reorderLevel?.toString() ?? null,
        };
      });
      if (input.lowStockOnly) {
        rows = rows.filter((r) => r.reorderLevel && Number(r.quantity) <= Number(r.reorderLevel));
      }
      // Surface negatives first — they are the leakage signals
      rows.sort((a, b) => Number(a.quantity) - Number(b.quantity));
      return { rows };
    }

    case "get_recent_orders": {
      const limit = Math.min(input.limit ?? 10, 50);
      const branchId = input.branchId ? BigInt(input.branchId) : undefined;
      const orders = await prisma.order.findMany({
        where: { status: "PAID", ...(branchId ? { branchId } : {}) },
        orderBy: { openedAt: "desc" },
        take: limit,
        include: {
          branch: { select: { code: true, name: true } },
          items: { select: { qty: true, lineTotal: true, item: { select: { name: true, size: true } } } },
        },
      });
      return {
        orders: orders.map((o) => ({
          orderNo: o.orderNo,
          branch: o.branch.name,
          total: o.total.toString(),
          openedAt: o.openedAt,
          waiterBox: o.waiterBox,
          itemCount: o.items.length,
          items: o.items.slice(0, 3).map((i) => `${i.qty}× ${i.item.name} ${i.item.size === "NA" ? "" : `(${i.item.size})`}`),
        })),
      };
    }

    case "get_supplier_ledger": {
      const id = BigInt(input.supplierId);
      const supplier = await prisma.supplier.findUnique({ where: { id } });
      if (!supplier) return { error: "Supplier not found" };

      const [poSum, paymentSum, recentPayments] = await Promise.all([
        prisma.purchaseOrder.aggregate({ _sum: { total: true }, where: { supplierId: id, status: { not: "CANCELLED" } } }),
        prisma.supplierPayment.aggregate({ _sum: { amount: true }, where: { supplierId: id } }),
        prisma.supplierPayment.findMany({ where: { supplierId: id }, orderBy: { paidAt: "desc" }, take: 5, select: { amount: true, method: true, paidAt: true, reference: true } }),
      ]);
      const opening = supplier.openingBalance;
      const purchased = poSum._sum.total ?? new Prisma.Decimal(0);
      const paid = paymentSum._sum.amount ?? new Prisma.Decimal(0);
      const balance = opening.plus(purchased).minus(paid);

      return {
        supplier: { id: Number(supplier.id), name: supplier.name, phone: supplier.phone, paymentTermsDays: supplier.paymentTermsDays },
        balance: balance.toString(),
        opening: opening.toString(),
        purchased: purchased.toString(),
        paid: paid.toString(),
        recentPayments: recentPayments.map((p) => ({ amount: p.amount.toString(), method: p.method, paidAt: p.paidAt, reference: p.reference })),
      };
    }

    case "get_alert_summary": {
      const days = input.days ?? 7;
      const since = new Date(Date.now() - days * 86400_000);
      const counts = await prisma.alert.groupBy({
        by: ["severity"],
        where: {
          ...(input.branchId ? { branchId: BigInt(input.branchId) } : {}),
          createdAt: { gte: since },
          acknowledgedAt: null,
        },
        _count: { _all: true },
      });
      return {
        windowDays: days,
        open: {
          CRITICAL: counts.find((c) => c.severity === "CRITICAL")?._count._all ?? 0,
          HIGH:     counts.find((c) => c.severity === "HIGH")?._count._all ?? 0,
          MEDIUM:   counts.find((c) => c.severity === "MEDIUM")?._count._all ?? 0,
          LOW:      counts.find((c) => c.severity === "LOW")?._count._all ?? 0,
        },
      };
    }

    case "get_open_alerts": {
      const limit = Math.min(input.limit ?? 20, 50);
      const branchId = input.branchId ? BigInt(input.branchId) : undefined;
      const alerts = await prisma.alert.findMany({
        where: { acknowledgedAt: null, ...(branchId ? { branchId } : {}) },
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
        take: limit,
        include: { rule: { select: { code: true, name: true } }, branch: { select: { name: true } } },
      });
      return {
        alerts: alerts.map((a) => ({
          id: Number(a.id),
          severity: a.severity,
          ruleCode: a.rule.code,
          ruleName: a.rule.name,
          branch: a.branch?.name ?? null,
          message: a.message,
          createdAt: a.createdAt,
        })),
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
