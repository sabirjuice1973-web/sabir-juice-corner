/**
 * One-shot backfill script — corrects historical custom-mix stock deductions.
 *
 * Background:
 *   Before the Bug B fix in salesDeduction.ts, every custom-mix OrderItem
 *   (cashier typed code+code at the POS, e.g. "7+41") deducted the FULL
 *   anchor item's recipe and silently deducted ZERO from the second component.
 *   So the variance report has been under-reporting consumption of the second
 *   component on every custom mix ever placed.
 *
 *   The salesDeduction code is now correct for new orders, but the historical
 *   StockMovement rows still reflect the broken split. This script walks every
 *   PAID custom-mix OrderItem and posts compensating ADJUSTMENT movements:
 *     • For the anchor's recipe ingredients: ADD BACK 0.5x what was over-deducted.
 *     • For the second component's recipe ingredients: SUBTRACT the 0.5x that
 *       was never deducted.
 *
 * Idempotency:
 *   Every adjustment movement we post is tagged referenceType="OrderCustomMixBackfill"
 *   and referenceId=orderItemId. Before processing an OrderItem, we check whether
 *   such a movement already exists for it; if yes, we skip. So this script is
 *   safe to run multiple times — it'll never double-correct.
 *
 * Usage:
 *   pnpm --filter @sjc/api exec tsx src/scripts/backfill-custom-mix-deduction.ts
 *       → DRY RUN (prints what it would do, writes nothing)
 *   pnpm --filter @sjc/api exec tsx src/scripts/backfill-custom-mix-deduction.ts --apply
 *       → APPLY (writes ADJUSTMENT movements + updates StockLevel cache)
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { move, defaultSaleLocation } from "../services/stockService.js";

const APPLY = process.argv.includes("--apply");
const REFERENCE_TYPE = "OrderCustomMixBackfill";

type IngredientType = "RAW_MATERIAL" | "PROCESSED_PRODUCT" | "PACKAGING" | "OTHER";

function stockableOf(ingredientType: string, rawMaterialId: bigint | null, processedProductId: bigint | null) {
  if (ingredientType === "RAW_MATERIAL")      return rawMaterialId      ? { stockableType: "RAW_MATERIAL" as const,      stockableId: rawMaterialId      } : null;
  if (ingredientType === "PROCESSED_PRODUCT") return processedProductId ? { stockableType: "PROCESSED_PRODUCT" as const, stockableId: processedProductId } : null;
  if (ingredientType === "PACKAGING")         return null;   // packaging is not tracked through stockMovements today
  return null;
}

async function main() {
  console.log(`\n=== Custom-mix deduction backfill ${APPLY ? "[APPLY]" : "[DRY RUN]"} ===\n`);

  // 1. Find every PAID custom-mix order item
  const items = await prisma.orderItem.findMany({
    where: { isCustomMix: true, order: { status: "PAID" } },
    include: { order: { select: { id: true, orderNo: true, branchId: true, cashierId: true } } },
    orderBy: { id: "asc" },
  });
  console.log(`Found ${items.length} PAID custom-mix OrderItems`);

  // 2. Identify the ones already backfilled (idempotency)
  const alreadyDone = items.length === 0 ? [] : await prisma.stockMovement.findMany({
    where: { referenceType: REFERENCE_TYPE, referenceId: { in: items.map((i) => i.id) } },
    select: { referenceId: true },
    distinct: ["referenceId"],
  });
  const doneSet = new Set(alreadyDone.map((m) => m.referenceId?.toString()).filter(Boolean));
  const todo = items.filter((i) => !doneSet.has(i.id.toString()));
  console.log(`  ${doneSet.size} already backfilled, ${todo.length} to process\n`);

  let totalMovementsWritten = 0;
  let skipped = 0;
  const sample: string[] = [];

  for (const oi of todo) {
    const components = (oi.customMixComponents as any) as Array<{ itemCode?: number }>;
    if (!Array.isArray(components) || components.length < 2 || components.some((c) => typeof c.itemCode !== "number")) {
      skipped++;
      sample.push(`  SKIP OrderItem #${oi.id}: malformed components`);
      continue;
    }
    const N = components.length;

    // Resolve the sale location for this branch (used to anchor the ADJUSTMENT)
    const branchId = oi.order.branchId;
    const location = await defaultSaleLocation(prisma as any, branchId);
    if (!location) {
      skipped++;
      sample.push(`  SKIP OrderItem #${oi.id}: branch ${branchId} has no sale location`);
      continue;
    }

    // Aggregate deltas by (stockableType, stockableId, unitId).
    // Positive delta = stock IN (add back what was over-deducted from the anchor).
    // Negative delta = stock OUT (remove what was under-deducted from non-anchors).
    type Key = string;
    const deltas = new Map<Key, { stockableType: "RAW_MATERIAL" | "PROCESSED_PRODUCT"; stockableId: bigint; unitId: bigint; qty: Prisma.Decimal }>();
    const add = (st: "RAW_MATERIAL" | "PROCESSED_PRODUCT", sid: bigint, unitId: bigint, q: Prisma.Decimal) => {
      const k = `${st}|${sid}|${unitId}`;
      const cur = deltas.get(k);
      if (cur) cur.qty = cur.qty.plus(q);
      else deltas.set(k, { stockableType: st, stockableId: sid, unitId, qty: q });
    };

    // 2a. Reverse the OLD deduction: anchor recipe at full oi.qty.
    const anchorRecipe = await prisma.recipe.findFirst({
      where: { itemId: oi.itemId, isActive: true },
      orderBy: { version: "desc" },
      include: { ingredients: true },
    });
    if (anchorRecipe) {
      const yieldQty = new Prisma.Decimal(anchorRecipe.yieldQty || 1);
      for (const ing of anchorRecipe.ingredients) {
        const stockable = stockableOf(ing.ingredientType as IngredientType, ing.rawMaterialId, ing.processedProductId);
        if (!stockable) continue;
        const consumed = ing.quantity.times(oi.qty).dividedBy(yieldQty);
        if (consumed.isZero()) continue;
        // Reverse → positive (stock IN)
        add(stockable.stockableType, stockable.stockableId, ing.unitId, consumed);
      }
    }

    // 2b. Apply the NEW deduction: each component's recipe at oi.qty / N.
    const ratio = new Prisma.Decimal(1).dividedBy(N);
    for (const c of components) {
      const componentItem = await prisma.item.findUnique({
        where: { itemCode: c.itemCode! },
        select: { id: true },
      });
      if (!componentItem) continue;
      const recipe = await prisma.recipe.findFirst({
        where: { itemId: componentItem.id, isActive: true },
        orderBy: { version: "desc" },
        include: { ingredients: true },
      });
      if (!recipe) continue;
      const yieldQty = new Prisma.Decimal(recipe.yieldQty || 1);
      const legQty = oi.qty.times(ratio);
      for (const ing of recipe.ingredients) {
        const stockable = stockableOf(ing.ingredientType as IngredientType, ing.rawMaterialId, ing.processedProductId);
        if (!stockable) continue;
        const consumed = ing.quantity.times(legQty).dividedBy(yieldQty);
        if (consumed.isZero()) continue;
        // Apply → negative (stock OUT)
        add(stockable.stockableType, stockable.stockableId, ing.unitId, consumed.negated());
      }
    }

    const nonZero = [...deltas.values()].filter((d) => !d.qty.isZero());
    if (nonZero.length === 0) {
      sample.push(`  OrderItem #${oi.id} (Order ${oi.order.orderNo}): no-op (both legs lack recipes or net-zero)`);
      continue;
    }

    sample.push(`  OrderItem #${oi.id} (Order ${oi.order.orderNo}, qty ${oi.qty}, ${N} components): ${nonZero.length} adjustment(s)`);
    for (const d of nonZero) {
      const sign = d.qty.greaterThan(0) ? "+" : "";
      sample.push(`    ${d.stockableType}#${d.stockableId}  qty ${sign}${d.qty.toFixed(3)} (unit ${d.unitId})`);
    }

    if (APPLY) {
      // Wrap one OrderItem's adjustments in a single transaction so partial failure
      // doesn't leave a half-corrected row. We use the canonical move() helper so
      // StockLevel cache stays in sync — same chokepoint as live deductions.
      await prisma.$transaction(async (tx) => {
        for (const d of nonZero) {
          await move(tx, {
            locationId: location,
            stockableType: d.stockableType,
            stockableId: d.stockableId,
            movementType: "ADJUSTMENT",
            quantity: d.qty,
            unitId: d.unitId,
            referenceType: REFERENCE_TYPE,
            referenceId: oi.id,
            performedById: oi.order.cashierId,
            reason: "Backfill: split custom-mix deduction across both components",
          });
          totalMovementsWritten++;
        }
      });
    } else {
      // Even in dry-run, account for what would be written so the summary is accurate.
      totalMovementsWritten += nonZero.length;
    }
  }

  // 3. Summary
  console.log("--- Sample of changes (first 100 lines) ---");
  console.log(sample.slice(0, 100).join("\n") || "  (nothing to do)");
  if (sample.length > 100) console.log(`  … and ${sample.length - 100} more lines`);
  console.log("");
  console.log(`Movements ${APPLY ? "written" : "would write"}: ${totalMovementsWritten}`);
  console.log(`OrderItems processed: ${todo.length - skipped}`);
  console.log(`OrderItems skipped:   ${skipped}`);
  console.log(`OrderItems already backfilled (skipped):  ${doneSet.size}`);
  if (!APPLY) console.log(`\n(no writes — re-run with --apply to commit)`);
  else        console.log(`\nDone.`);
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
