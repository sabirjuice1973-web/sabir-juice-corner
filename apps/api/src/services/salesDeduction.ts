import { Prisma } from "@prisma/client";
import { stockOut, defaultSaleLocation } from "./stockService.js";

/**
 * On order PAID, walk each line item's active recipe and deduct ingredients from
 * the branch's default sale location.
 *
 * Behaviour:
 *   • If an item has no active recipe → silently skip. Many items (water, coke,
 *     ice cream from supplier) don't have recipes; that's fine.
 *   • If an ingredient has no stock or insufficient stock → still record the
 *     negative movement. We do NOT block sales on data quality issues — the
 *     variance report surfaces them instead. Negative `stockLevel.quantity` is
 *     a real signal: "you sold more than you said you had".
 *   • Custom mixes (POS code+code, e.g. cashier types "7+41"): when
 *     `OrderItem.isCustomMix` is true and `customMixComponents` lists N items,
 *     we walk EACH component's recipe and deduct each at 1/N of the line qty.
 *     A 2-component custom mix therefore deducts 0.5 of each component's recipe.
 *     Prior versions deducted only the anchor (alphabetically first) component —
 *     silently freeing the second component's pulp and inflating the apparent
 *     surplus in the variance report.
 *
 * Returns a list of human-readable deduction events for the response.
 */
export async function deductForOrder(
  tx: Prisma.TransactionClient,
  args: {
    orderId: bigint;
    branchId: bigint;
    performedById: bigint;
  },
): Promise<Array<{ itemName: string; ingredient: string; deducted: string; unit: string; insufficient: boolean }>> {
  const events: Array<{ itemName: string; ingredient: string; deducted: string; unit: string; insufficient: boolean }> = [];

  const location = await defaultSaleLocation(tx, args.branchId);
  if (!location) {
    // No stock location at the branch yet — skip deduction silently.
    return events;
  }

  const orderItems = await tx.orderItem.findMany({
    where: { orderId: args.orderId },
    include: { item: { select: { name: true, size: true } } },
  });

  for (const oi of orderItems) {
    // Resolve which recipes to walk for this line:
    //   • Plain line                → the anchor item's recipe at full qty (ratio = 1).
    //   • Custom mix (POS code+code) → each component's recipe at qty/N (ratio = 1/N).
    //
    // Note: this only covers custom mixes typed at the POS (isCustomMix=true).
    // Regular MENU items with "+" in the name (e.g. Peach+Plum #82,
    // Almond+Banana #123) are NOT custom mixes — they each have their own
    // fixed recipe and go through the default 1-job path.
    const jobs: { itemId: bigint; ratio: Prisma.Decimal }[] = [];
    if (oi.isCustomMix && Array.isArray(oi.customMixComponents) && oi.customMixComponents.length >= 2) {
      const components = oi.customMixComponents as Array<{ itemCode?: number }>;
      const codes = components.map((c) => c.itemCode).filter((n): n is number => typeof n === "number");
      if (codes.length === components.length) {
        const items = await tx.item.findMany({
          where: { itemCode: { in: codes } },
          select: { id: true, itemCode: true },
        });
        const itemByCode = new Map(items.map((it) => [it.itemCode, it.id]));
        const ratio = new Prisma.Decimal(1).dividedBy(components.length);
        for (const c of components) {
          const id = c.itemCode != null ? itemByCode.get(c.itemCode) : undefined;
          if (id) jobs.push({ itemId: id, ratio });
        }
      }
    }
    if (jobs.length === 0) {
      jobs.push({ itemId: oi.itemId, ratio: new Prisma.Decimal(1) });
    }

    for (const job of jobs) {
      const recipe = await tx.recipe.findFirst({
        where: { itemId: job.itemId, isActive: true },
        orderBy: { version: "desc" },
        include: {
          ingredients: {
            include: {
              rawMaterial: { select: { name: true } },
              processedProduct: { select: { name: true } },
              unit: { select: { code: true } },
            },
          },
        },
      });
      if (!recipe) continue; // no recipe → nothing to deduct for this leg

      // Effective qty for this leg = OrderItem.qty × ratio (1 normal, 1/N for custom mix).
      const lineQty = oi.qty.times(job.ratio);
      const yieldQty = new Prisma.Decimal(recipe.yieldQty || 1);

      for (const ing of recipe.ingredients) {
        const ingredientName =
          ing.ingredientType === "RAW_MATERIAL" ? ing.rawMaterial?.name :
          ing.ingredientType === "PROCESSED_PRODUCT" ? ing.processedProduct?.name :
          ing.ingredientType;

        const consumed = ing.quantity.times(lineQty).dividedBy(yieldQty);
        if (consumed.lessThanOrEqualTo(0)) continue;

        const stockableType =
          ing.ingredientType === "RAW_MATERIAL" ? "RAW_MATERIAL" :
          ing.ingredientType === "PROCESSED_PRODUCT" ? "PROCESSED_PRODUCT" :
          ing.ingredientType === "PACKAGING" ? "PACKAGING" :
          null;
        const stockableId =
          ing.ingredientType === "RAW_MATERIAL" ? ing.rawMaterialId :
          ing.ingredientType === "PROCESSED_PRODUCT" ? ing.processedProductId :
          null;

        // OTHER and unconfigured ingredients are tracked at the recipe level but
        // do not flow into stockMovements — they're informational.
        if (!stockableType || !stockableId) continue;

        // Check if there is enough stock; we still post the movement, just flag it.
        const level = await tx.stockLevel.findUnique({
          where: {
            locationId_stockableType_stockableId: {
              locationId: location,
              stockableType: stockableType as any,
              stockableId,
            },
          },
        });
        const insufficient = !level || level.quantity.lessThan(consumed);

        await stockOut(tx, {
          locationId: location,
          stockableType: stockableType as any,
          stockableId,
          movementType: "SALE",
          quantity: consumed,
          unitId: ing.unitId,
          referenceType: "Order",
          referenceId: args.orderId,
          performedById: args.performedById,
          reason: insufficient ? "sale_deduction_insufficient_stock" : null,
        });

        events.push({
          itemName: `${oi.item.name}${oi.item.size !== "NA" ? " " + oi.item.size : ""}`,
          ingredient: ingredientName ?? "(unknown)",
          deducted: consumed.toString(),
          unit: ing.unit.code,
          insufficient,
        });
      }
    }
  }

  return events;
}
