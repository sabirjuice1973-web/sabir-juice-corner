import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";

/**
 * Detect anomalies. Each rule:
 *   • is a pure read over recent data
 *   • returns zero or more Alert payloads
 *   • is idempotent — running twice in a day won't double-fire (we de-dup on
 *     ruleCode + branchId + dayKey written into payload).
 *
 * The runner aggregates results and writes Alert rows. Designed to be called
 * either on-demand (admin button) or via cron.
 */

export type AnomalySignal = {
  ruleCode: string;
  ruleName: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  branchId: bigint | null;
  message: string;
  payload: Record<string, any>;        // includes dayKey for de-dup
};

const DAY = 24 * 60 * 60 * 1000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

// ─── Rule: excessive voids by a cashier in a day ──────────────────────────
async function ruleExcessiveVoids(window: { since: Date; until: Date }): Promise<AnomalySignal[]> {
  const since = window.since;
  const groups = await prisma.order.groupBy({
    by: ["cashierId", "branchId"],
    where: {
      status: "VOIDED",
      cancelledAt: { gte: since, lte: window.until },
    },
    _count: { _all: true },
  });
  const cashierIds = groups.map((g) => g.cashierId);
  const cashiers = cashierIds.length
    ? await prisma.user.findMany({ where: { id: { in: cashierIds } }, select: { id: true, fullName: true, username: true } })
    : [];
  const cmap = new Map(cashiers.map((c) => [c.id.toString(), c]));
  return groups
    .filter((g) => g._count._all >= 5)
    .map((g) => ({
      ruleCode: "EXCESSIVE_VOIDS",
      ruleName: "Excessive voids by cashier",
      severity: g._count._all >= 10 ? "HIGH" : "MEDIUM",
      branchId: g.branchId,
      message: `${cmap.get(g.cashierId.toString())?.fullName ?? "Cashier #" + g.cashierId} voided ${g._count._all} orders since ${dayKey(since)}`,
      payload: {
        dayKey: dayKey(since),
        cashierId: g.cashierId.toString(),
        voidCount: g._count._all,
      },
    }));
}

// ─── Rule: persistent cash variance ───────────────────────────────────────
async function ruleCashVariance(_window: { since: Date; until: Date }): Promise<AnomalySignal[]> {
  // For each branch, look at last 7 days of closed shifts. If 3+ have |variance| > 500, alert.
  const branches = await prisma.branch.findMany({ select: { id: true, name: true } });
  const out: AnomalySignal[] = [];
  for (const b of branches) {
    const recent = await prisma.shift.findMany({
      where: {
        branchId: b.id,
        status: "CLOSED",
        closedAt: { gte: new Date(Date.now() - 7 * DAY) },
      },
      select: { varianceCash: true, closedAt: true },
      orderBy: { closedAt: "desc" },
      take: 7,
    });
    const big = recent.filter((s) => s.varianceCash && s.varianceCash.abs().greaterThan(500));
    if (big.length >= 3) {
      out.push({
        ruleCode: "CASH_VARIANCE_PERSISTENT",
        ruleName: "Persistent cash variance",
        severity: "HIGH",
        branchId: b.id,
        message: `${b.name}: ${big.length} of last ${recent.length} shifts had cash variance over ₨500`,
        payload: {
          dayKey: dayKey(new Date()),
          shifts: big.map((s) => ({ at: s.closedAt, variance: s.varianceCash?.toString() })),
        },
      });
    }
  }
  return out;
}

// ─── Rule: discount abuse — cashier discounts on > 30% of their orders ────
async function ruleDiscountAbuse(window: { since: Date; until: Date }): Promise<AnomalySignal[]> {
  const out: AnomalySignal[] = [];
  // Aggregate orders per cashier in window
  const cashierStats = await prisma.order.groupBy({
    by: ["cashierId", "branchId"],
    where: { status: "PAID", openedAt: { gte: window.since, lte: window.until } },
    _count: { _all: true },
  });
  for (const cs of cashierStats) {
    if (cs._count._all < 10) continue;
    const withDiscount = await prisma.order.count({
      where: {
        cashierId: cs.cashierId,
        branchId: cs.branchId,
        status: "PAID",
        openedAt: { gte: window.since, lte: window.until },
        discountAmount: { gt: 0 },
      },
    });
    const ratio = withDiscount / cs._count._all;
    if (ratio > 0.3) {
      const u = await prisma.user.findUnique({ where: { id: cs.cashierId }, select: { fullName: true } });
      out.push({
        ruleCode: "DISCOUNT_ABUSE",
        ruleName: "Cashier discount abuse",
        severity: ratio > 0.5 ? "HIGH" : "MEDIUM",
        branchId: cs.branchId,
        message: `${u?.fullName ?? "Cashier #" + cs.cashierId} applied discounts on ${(ratio * 100).toFixed(0)}% of orders (${withDiscount}/${cs._count._all}) since ${dayKey(window.since)}`,
        payload: { dayKey: dayKey(window.since), cashierId: cs.cashierId.toString(), ratio: ratio.toFixed(3), withDiscount, total: cs._count._all },
      });
    }
  }
  return out;
}

// ─── Rule: supplier rate jump > 15% on a fresh GRN ────────────────────────
async function ruleSupplierRateJump(_window: { since: Date; until: Date }): Promise<AnomalySignal[]> {
  const out: AnomalySignal[] = [];
  // For each raw material with >= 2 GRN lines, compare latest to 30-day moving average.
  const recentGrnItems = await prisma.grnItem.findMany({
    where: { grn: { receivedAt: { gte: new Date(Date.now() - 30 * DAY) } } },
    include: { rawMaterial: true, grn: { select: { receivedAt: true } } },
  });
  const byMat = new Map<string, { latest: Prisma.Decimal; mean: Prisma.Decimal; samples: number; name: string }>();
  // Group by rawMaterialId
  const groups = new Map<string, typeof recentGrnItems>();
  for (const r of recentGrnItems) {
    const k = r.rawMaterialId.toString();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  for (const [k, items] of groups) {
    items.sort((a, b) => +b.grn.receivedAt - +a.grn.receivedAt);
    const latest = items[0].rate;
    const others = items.slice(1);
    if (others.length === 0) continue;
    const meanOthers = others.reduce((s, it) => s.plus(it.rate), new Prisma.Decimal(0)).dividedBy(others.length);
    if (meanOthers.equals(0)) continue;
    const jumpPct = latest.minus(meanOthers).dividedBy(meanOthers).times(100);
    if (jumpPct.greaterThan(15)) {
      byMat.set(k, { latest, mean: meanOthers, samples: others.length, name: items[0].rawMaterial.name });
      out.push({
        ruleCode: "SUPPLIER_RATE_JUMP",
        ruleName: "Supplier rate jump",
        severity: jumpPct.greaterThan(30) ? "HIGH" : "MEDIUM",
        branchId: null,
        message: `${items[0].rawMaterial.name} rate jumped ${jumpPct.toFixed(1)}% — latest ₨${latest} vs 30-day avg ₨${meanOthers.toFixed(2)}`,
        payload: { dayKey: dayKey(new Date()), rawMaterialId: k, latest: latest.toString(), mean: meanOthers.toFixed(2), jumpPct: jumpPct.toFixed(2) },
      });
    }
  }
  return out;
}

// ─── Rule: batch wastage spike — wastage > 15% of inputs ──────────────────
async function ruleBatchWastageSpike(window: { since: Date; until: Date }): Promise<AnomalySignal[]> {
  const out: AnomalySignal[] = [];
  const batches = await prisma.productionBatch.findMany({
    where: { startedAt: { gte: window.since, lte: window.until }, status: "COMPLETED" },
    include: { inputs: true, wastages: true, branch: { select: { id: true, name: true } } },
  });
  for (const b of batches) {
    const inputs = b.inputs.reduce((s, i) => s.plus(i.quantity), new Prisma.Decimal(0));
    const wastage = b.wastages.reduce((s, w) => s.plus(w.wastageQty), new Prisma.Decimal(0));
    if (inputs.equals(0)) continue;
    const wastagePct = wastage.dividedBy(inputs).times(100);
    if (wastagePct.greaterThan(15)) {
      out.push({
        ruleCode: "BATCH_WASTAGE_SPIKE",
        ruleName: "Batch wastage spike",
        severity: wastagePct.greaterThan(25) ? "HIGH" : "MEDIUM",
        branchId: b.branchId,
        message: `${b.batchNo} at ${b.branch.name}: wastage ${wastagePct.toFixed(1)}% of inputs (${wastage}/${inputs})`,
        payload: { dayKey: dayKey(b.startedAt), batchId: b.id.toString(), wastagePct: wastagePct.toFixed(2) },
      });
    }
  }
  return out;
}

// ─── Rule: negative branch stock — there's measured leakage ───────────────
async function ruleNegativeStock(_window: { since: Date; until: Date }): Promise<AnomalySignal[]> {
  const negatives = await prisma.stockLevel.findMany({
    where: { quantity: { lt: 0 } },
    include: { location: { include: { branch: true } }, unit: true },
  });
  const out: AnomalySignal[] = [];
  for (const n of negatives) {
    // Resolve human-readable name
    let label = `#${n.stockableId}`;
    if (n.stockableType === "PROCESSED_PRODUCT") {
      const p = await prisma.processedProduct.findUnique({ where: { id: n.stockableId }, select: { name: true } });
      if (p) label = p.name;
    } else if (n.stockableType === "RAW_MATERIAL") {
      const r = await prisma.rawMaterial.findUnique({ where: { id: n.stockableId }, select: { name: true } });
      if (r) label = r.name;
    }
    out.push({
      ruleCode: "NEGATIVE_STOCK",
      ruleName: "Negative on-hand stock",
      severity: "HIGH",
      branchId: n.location.branchId,
      message: `${n.location.branch.name} / ${n.location.name}: ${label} = ${n.quantity} ${n.unit.code} (sold more than received)`,
      payload: { dayKey: dayKey(new Date()), location: n.location.name, stockableType: n.stockableType, stockableId: n.stockableId.toString(), quantity: n.quantity.toString() },
    });
  }
  return out;
}

// ─── Runner ───────────────────────────────────────────────────────────────

export async function runAllRules(opts?: { windowDays?: number }): Promise<{ created: number; signals: AnomalySignal[] }> {
  const windowDays = opts?.windowDays ?? 7;
  const window = { since: new Date(Date.now() - windowDays * DAY), until: new Date() };

  const all = (await Promise.all([
    ruleExcessiveVoids(window),
    ruleCashVariance(window),
    ruleDiscountAbuse(window),
    ruleSupplierRateJump(window),
    ruleBatchWastageSpike(window),
    ruleNegativeStock(window),
  ])).flat();

  // Ensure rule rows exist
  const ruleRows = new Map<string, bigint>();
  for (const sig of all) {
    if (ruleRows.has(sig.ruleCode)) continue;
    const r = await prisma.alertRule.upsert({
      where: { code: sig.ruleCode },
      update: { name: sig.ruleName, severity: sig.severity, isActive: true },
      create: { code: sig.ruleCode, name: sig.ruleName, severity: sig.severity, ruleType: "STAT_THRESHOLD", threshold: {} as Prisma.InputJsonValue, isActive: true },
    });
    ruleRows.set(sig.ruleCode, r.id);
  }

  // De-dup against existing un-acknowledged alerts with same rule + branch + dayKey
  let created = 0;
  for (const sig of all) {
    const ruleId = ruleRows.get(sig.ruleCode)!;
    const dup = await prisma.alert.findFirst({
      where: {
        ruleId,
        branchId: sig.branchId,
        acknowledgedAt: null,
        payload: { path: ["dayKey"], equals: sig.payload.dayKey },
      },
      select: { id: true },
    });
    if (dup) continue;
    await prisma.alert.create({
      data: {
        ruleId,
        branchId: sig.branchId,
        severity: sig.severity,
        message: sig.message,
        payload: sig.payload as Prisma.InputJsonValue,
      },
    });
    created++;
  }

  return { created, signals: all };
}
