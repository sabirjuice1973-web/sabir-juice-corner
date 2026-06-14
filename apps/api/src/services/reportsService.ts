import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";

/**
 * Reports.
 *
 * All functions take an inclusive date range as ISO strings (YYYY-MM-DD) and a
 * branchId. Computed on-demand for now; once the dataset grows we'll
 * materialise into DailyBranchSummary nightly.
 *
 * Money/quantity returned as strings to preserve Decimal precision.
 */

function dayRange(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T23:59:59.999Z`);
  return { start, end };
}

// ─── Variance / leakage report ────────────────────────────────────────────
//
// For each branch + processed product in the date range:
//   expected_in     = sum of TRANSFER_IN + PURCHASE_IN + PRODUCTION_IN qty
//   expected_glasses = expected_in × default_glasses_per_unit
//   actual_glasses_sold = sum of OrderItem.qty across PAID orders where the
//                          item's active recipe contains this processed product
//   sales_consumed   = sum of |SALE| movements for this product/branch
//   wastage_consumed = sum of |WASTAGE| movements
//   variance_units   = expected_in − sales_consumed − wastage_consumed − current_level
//   variance_pct     = variance_units / expected_in × 100  (when expected > 0)
//
// A positive variance_units means stock "disappeared" — that's the leakage signal.
//
export async function varianceReport(args: { branchId: bigint; from: string; to: string }) {
  const { start, end } = dayRange(args.from, args.to);

  // Get the branch's stock locations
  const locations = await prisma.stockLocation.findMany({
    where: { branchId: args.branchId, isActive: true },
    select: { id: true },
  });
  const locationIds = locations.map((l) => l.id);
  if (locationIds.length === 0) return { branchId: args.branchId.toString(), from: args.from, to: args.to, rows: [] };

  // All processed products that had any movement at this branch in the window
  const movementsRaw = await prisma.stockMovement.findMany({
    where: {
      locationId: { in: locationIds },
      stockableType: "PROCESSED_PRODUCT",
      createdAt: { gte: start, lte: end },
    },
    select: {
      stockableId: true,
      movementType: true,
      quantity: true,
    },
  });

  const byProduct = new Map<string, {
    productId: bigint;
    transfer_in: Prisma.Decimal;
    production_in: Prisma.Decimal;
    purchase_in: Prisma.Decimal;
    sales_out: Prisma.Decimal;
    wastage_out: Prisma.Decimal;
    transfer_out: Prisma.Decimal;
    other_out: Prisma.Decimal;
  }>();
  for (const m of movementsRaw) {
    const key = m.stockableId.toString();
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        productId: m.stockableId,
        transfer_in: new Prisma.Decimal(0),
        production_in: new Prisma.Decimal(0),
        purchase_in: new Prisma.Decimal(0),
        sales_out: new Prisma.Decimal(0),
        wastage_out: new Prisma.Decimal(0),
        transfer_out: new Prisma.Decimal(0),
        other_out: new Prisma.Decimal(0),
      });
    }
    const e = byProduct.get(key)!;
    const q = m.quantity;
    switch (m.movementType) {
      case "TRANSFER_IN":     e.transfer_in   = e.transfer_in.plus(q.abs());   break;
      case "PRODUCTION_IN":   e.production_in = e.production_in.plus(q.abs()); break;
      case "PURCHASE_IN":     e.purchase_in   = e.purchase_in.plus(q.abs());   break;
      case "SALE":            e.sales_out     = e.sales_out.plus(q.abs());     break;
      case "WASTAGE":         e.wastage_out   = e.wastage_out.plus(q.abs());   break;
      case "TRANSFER_OUT":    e.transfer_out  = e.transfer_out.plus(q.abs());  break;
      case "PRODUCTION_CONSUME":
      case "ADJUSTMENT":
      case "RETURN":
        if (q.lessThan(0)) e.other_out = e.other_out.plus(q.abs());
        else e.transfer_in = e.transfer_in.plus(q); // treat positive adjustments as inflow
        break;
    }
  }

  // Pull product metadata + current stock levels at the branch (sum across locations)
  const ids = [...byProduct.values()].map((v) => v.productId);
  const [products, currentLevels] = await Promise.all([
    prisma.processedProduct.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, defaultGlassesPerUnit: true, storageUnit: true },
    }),
    prisma.stockLevel.groupBy({
      by: ["stockableId"],
      where: {
        locationId: { in: locationIds },
        stockableType: "PROCESSED_PRODUCT",
        stockableId: { in: ids },
      },
      _sum: { quantity: true },
    }),
  ]);
  const productById = new Map(products.map((p) => [p.id.toString(), p]));
  const levelById = new Map(currentLevels.map((l) => [l.stockableId.toString(), l._sum.quantity ?? new Prisma.Decimal(0)]));

  // Also count "glasses sold" via order items — converted to MEDIUM GLASS EQUIVALENT
  // before any aggregation:
  //   MEDIUM / NA → 1.0
  //   JUMBO       → 1.5
  // ProcessedProduct.defaultGlassesPerUnit is configured per shoper in MEDIUM
  // glasses (e.g. "1 Peach shoper = 10 medium glasses"), so for expected and
  // actual to be apples-to-apples we must lift every Jumbo sale to its medium
  // equivalent here. Without this, the variance report under-counted pulp
  // usage by 0.5× on every Jumbo sold and hid that surplus from the owner.
  const orderItemsRaw = await prisma.orderItem.findMany({
    where: {
      order: {
        branchId: args.branchId,
        status: "PAID",
        openedAt: { gte: start, lte: end },
      },
    },
    select: {
      qty: true,
      itemId: true,
      item: { select: { size: true } },
    },
  });
  const JUMBO_FACTOR = new Prisma.Decimal("1.5");
  const itemQtyMap = new Map<string, Prisma.Decimal>();   // medium-glass-equivalent qty per item
  for (const oi of orderItemsRaw) {
    const factor = oi.item.size === "JUMBO" ? JUMBO_FACTOR : new Prisma.Decimal(1);
    const k = oi.itemId.toString();
    itemQtyMap.set(k, (itemQtyMap.get(k) ?? new Prisma.Decimal(0)).plus(oi.qty.times(factor)));
  }
  // Resolve recipes for those items. `sold` is already in medium-glass equivalent
  // (weighted above), so the same value flows straight into per-product totals.
  const recipes = await prisma.recipe.findMany({
    where: { itemId: { in: [...itemQtyMap.keys()].map((k) => BigInt(k)) }, isActive: true },
    include: { ingredients: { where: { ingredientType: "PROCESSED_PRODUCT" } } },
  });
  const glassesByProduct = new Map<string, Prisma.Decimal>();
  for (const r of recipes) {
    const sold = itemQtyMap.get(r.itemId.toString()) ?? new Prisma.Decimal(0);
    if (sold.equals(0)) continue;
    for (const ing of r.ingredients) {
      if (!ing.processedProductId) continue;
      const k = ing.processedProductId.toString();
      glassesByProduct.set(k, (glassesByProduct.get(k) ?? new Prisma.Decimal(0)).plus(sold));
    }
  }

  const rows = [...byProduct.values()].map((e) => {
    const p = productById.get(e.productId.toString());
    const totalIn = e.transfer_in.plus(e.production_in).plus(e.purchase_in);
    const currentLevel = levelById.get(e.productId.toString()) ?? new Prisma.Decimal(0);
    const expectedClose = totalIn.minus(e.sales_out).minus(e.wastage_out).minus(e.transfer_out).minus(e.other_out);
    const variance = expectedClose.minus(currentLevel);
    const variancePct = totalIn.greaterThan(0)
      ? variance.dividedBy(totalIn).times(100)
      : new Prisma.Decimal(0);
    const glassesSold = glassesByProduct.get(e.productId.toString()) ?? new Prisma.Decimal(0);
    const expectedGlasses = totalIn.times(p?.defaultGlassesPerUnit ?? 12);
    const glassesVariance = expectedGlasses.minus(glassesSold);
    return {
      productId: e.productId.toString(),
      name: p?.name ?? `(processed #${e.productId})`,
      unit: p?.storageUnit ?? "shoper",
      transferIn:    e.transfer_in.toString(),
      productionIn:  e.production_in.toString(),
      purchaseIn:    e.purchase_in.toString(),
      totalIn:       totalIn.toString(),
      salesOut:      e.sales_out.toString(),
      wastageOut:    e.wastage_out.toString(),
      transferOut:   e.transfer_out.toString(),
      currentLevel:  currentLevel.toString(),
      expectedClose: expectedClose.toString(),
      variance:      variance.toString(),
      variancePct:   variancePct.toFixed(2),
      glassesPerUnit: (p?.defaultGlassesPerUnit ?? new Prisma.Decimal(12)).toString(),
      expectedGlasses: expectedGlasses.toString(),
      glassesSold:    glassesSold.toString(),
      glassesVariance: glassesVariance.toString(),
    };
  });

  return {
    branchId: args.branchId.toString(),
    from: args.from,
    to: args.to,
    rows: rows.sort((a, b) => Number(b.variance) - Number(a.variance)),
  };
}

// ─── Branch P&L ────────────────────────────────────────────────────────────
//
//   sales        = sum(orders.total) for PAID orders
//   discounts    = sum(orders.discountAmount)
//   cogs         = sum, per paid order item, of (ingredient qty × ingredient cost)
//                  ingredient cost = latest GRN rate for the raw material, or
//                                    weighted batch cost for the processed product
//                                    (for now we approximate using latest GRN of any input)
//   expenses     = sum(expenses.amount) for branch in period
//   net          = sales − discounts − cogs − expenses
//
export async function branchPnL(args: { branchId: bigint; from: string; to: string }) {
  const { start, end } = dayRange(args.from, args.to);

  const orders = await prisma.order.findMany({
    where: {
      branchId: args.branchId,
      status: "PAID",
      openedAt: { gte: start, lte: end },
    },
    select: {
      total: true,
      discountAmount: true,
      items: {
        select: { itemId: true, qty: true },
      },
    },
  });

  const sales = orders.reduce((s, o) => s.plus(o.total), new Prisma.Decimal(0));
  const discounts = orders.reduce((s, o) => s.plus(o.discountAmount), new Prisma.Decimal(0));

  // Build cost map
  const itemQty = new Map<string, Prisma.Decimal>();
  for (const o of orders) {
    for (const li of o.items) {
      const k = li.itemId.toString();
      itemQty.set(k, (itemQty.get(k) ?? new Prisma.Decimal(0)).plus(li.qty));
    }
  }

  // For each item with sales, compute COGS per unit from active recipe.
  const cogsByItem = await computeItemCogs([...itemQty.keys()].map((k) => BigInt(k)));

  let cogs = new Prisma.Decimal(0);
  for (const [itemKey, qty] of itemQty) {
    const c = cogsByItem.get(itemKey) ?? new Prisma.Decimal(0);
    cogs = cogs.plus(c.times(qty));
  }

  const expenseAgg = await prisma.expense.aggregate({
    _sum: { amount: true },
    where: {
      branchId: args.branchId,
      paidAt: { gte: start, lte: end },
    },
  });
  const expenses = expenseAgg._sum.amount ?? new Prisma.Decimal(0);

  const net = sales.minus(discounts).minus(cogs).minus(expenses);

  return {
    branchId: args.branchId.toString(),
    from: args.from,
    to: args.to,
    orderCount: orders.length,
    sales:     sales.toString(),
    discounts: discounts.toString(),
    cogs:      cogs.toString(),
    expenses:  expenses.toString(),
    net:       net.toString(),
    netMarginPct: sales.greaterThan(0) ? net.dividedBy(sales).times(100).toFixed(2) : "0.00",
  };
}

// ─── Item profitability ───────────────────────────────────────────────────

export async function itemProfitability(args: { branchId?: bigint; from: string; to: string }) {
  const { start, end } = dayRange(args.from, args.to);

  const orderItemsRaw = await prisma.orderItem.findMany({
    where: {
      order: {
        status: "PAID",
        ...(args.branchId ? { branchId: args.branchId } : {}),
        openedAt: { gte: start, lte: end },
      },
    },
    select: { itemId: true, qty: true, lineTotal: true, unitPrice: true },
  });

  const agg = new Map<string, { qty: Prisma.Decimal; revenue: Prisma.Decimal; unitPrice: Prisma.Decimal }>();
  for (const oi of orderItemsRaw) {
    const k = oi.itemId.toString();
    if (!agg.has(k)) agg.set(k, { qty: new Prisma.Decimal(0), revenue: new Prisma.Decimal(0), unitPrice: oi.unitPrice });
    const e = agg.get(k)!;
    e.qty = e.qty.plus(oi.qty);
    e.revenue = e.revenue.plus(oi.lineTotal);
  }

  if (agg.size === 0) {
    return { branchId: args.branchId?.toString() ?? null, from: args.from, to: args.to, rows: [] };
  }

  const ids = [...agg.keys()].map((k) => BigInt(k));
  const [items, cogsByItem] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: ids } }, select: { id: true, itemCode: true, name: true, size: true } }),
    computeItemCogs(ids),
  ]);
  const itemById = new Map(items.map((i) => [i.id.toString(), i]));

  const rows = [...agg.entries()].map(([id, e]) => {
    const it = itemById.get(id);
    const cogsPerUnit = cogsByItem.get(id) ?? new Prisma.Decimal(0);
    const cogsTotal = cogsPerUnit.times(e.qty);
    const profit = e.revenue.minus(cogsTotal);
    const marginPct = e.revenue.greaterThan(0) ? profit.dividedBy(e.revenue).times(100) : new Prisma.Decimal(0);
    return {
      itemId: id,
      itemCode: it?.itemCode ?? null,
      name: it ? `${it.name}${it.size !== "NA" ? " " + it.size : ""}` : `#${id}`,
      qtySold: e.qty.toString(),
      revenue: e.revenue.toString(),
      unitPrice: e.unitPrice.toString(),
      cogsPerUnit: cogsPerUnit.toString(),
      cogsTotal: cogsTotal.toString(),
      profit: profit.toString(),
      marginPct: marginPct.toFixed(2),
    };
  }).sort((a, b) => Number(b.profit) - Number(a.profit));

  return { branchId: args.branchId?.toString() ?? null, from: args.from, to: args.to, rows };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Compute COGS per unit for each item. Walks the active recipe:
 *   • RAW_MATERIAL ingredient → latest GRN rate (rate × quantity)
 *   • PROCESSED_PRODUCT ingredient → average batch cost per unit
 *     (sum of input costs / output qty across recent batches)
 *   • PACKAGING / OTHER → 0 (no cost tracked yet)
 *
 * Returns 0 for items with no active recipe (water, coke, etc.).
 */
async function computeItemCogs(itemIds: bigint[]): Promise<Map<string, Prisma.Decimal>> {
  const result = new Map<string, Prisma.Decimal>();
  if (itemIds.length === 0) return result;

  const recipes = await prisma.recipe.findMany({
    where: { itemId: { in: itemIds }, isActive: true },
    include: {
      ingredients: {
        include: {
          rawMaterial: true,
          processedProduct: true,
          unit: true,
        },
      },
    },
  });

  // Pre-fetch latest GRN rate per raw material we'll need
  const rawIds = new Set<string>();
  const procIds = new Set<string>();
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      if (ing.rawMaterialId) rawIds.add(ing.rawMaterialId.toString());
      if (ing.processedProductId) procIds.add(ing.processedProductId.toString());
    }
  }

  const latestRawRates = new Map<string, Prisma.Decimal>();
  for (const rid of rawIds) {
    const last = await prisma.grnItem.findFirst({
      where: { rawMaterialId: BigInt(rid) },
      orderBy: { id: "desc" },
      select: { rate: true },
    });
    if (last) latestRawRates.set(rid, last.rate);
  }

  // Approximate processed-product unit cost from recent batches.
  const procCosts = new Map<string, Prisma.Decimal>();
  for (const pid of procIds) {
    const batches = await prisma.batchOutput.findMany({
      where: { processedProductId: BigInt(pid) },
      take: 5,
      orderBy: { id: "desc" },
      include: {
        batch: {
          include: { inputs: true },
        },
      },
    });
    if (batches.length === 0) {
      procCosts.set(pid, new Prisma.Decimal(0));
      continue;
    }
    let totalCost = new Prisma.Decimal(0);
    let totalOutput = new Prisma.Decimal(0);
    for (const out of batches) {
      const inputCost = out.batch.inputs.reduce(
        (s, i) => s.plus(i.costAtIntake.times(i.quantity)),
        new Prisma.Decimal(0),
      );
      totalCost = totalCost.plus(inputCost);
      totalOutput = totalOutput.plus(out.outputQty);
    }
    procCosts.set(pid, totalOutput.greaterThan(0) ? totalCost.dividedBy(totalOutput) : new Prisma.Decimal(0));
  }

  for (const r of recipes) {
    let perUnit = new Prisma.Decimal(0);
    for (const ing of r.ingredients) {
      if (ing.ingredientType === "RAW_MATERIAL" && ing.rawMaterialId) {
        const rate = latestRawRates.get(ing.rawMaterialId.toString()) ?? new Prisma.Decimal(0);
        perUnit = perUnit.plus(rate.times(ing.quantity));
      } else if (ing.ingredientType === "PROCESSED_PRODUCT" && ing.processedProductId) {
        const rate = procCosts.get(ing.processedProductId.toString()) ?? new Prisma.Decimal(0);
        perUnit = perUnit.plus(rate.times(ing.quantity));
      }
    }
    const yieldQty = new Prisma.Decimal(r.yieldQty || 1);
    result.set(r.itemId.toString(), perUnit.dividedBy(yieldQty));
  }
  return result;
}
