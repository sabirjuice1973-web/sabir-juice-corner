import { Prisma, type StockableType, type MovementType } from "@prisma/client";

/**
 * The single chokepoint for stock mutations.
 *
 * Why this exists: StockLevel is denormalised (it's a cache of summed StockMovements).
 * If application code ever writes one without the other, the books drift. So
 * everything goes through StockService.move() — which:
 *   1. inserts a signed StockMovement row,
 *   2. upserts the matching StockLevel (incrementing the cached quantity),
 *   3. returns the new on-hand quantity.
 *
 * All operations require an active Prisma transaction (`tx`) — callers must wrap
 * batches of moves in `prisma.$transaction(...)` so partial failures roll back.
 */

export type MoveArgs = {
  locationId: bigint;
  stockableType: StockableType;
  stockableId: bigint;
  movementType: MovementType;
  quantity: Prisma.Decimal | number | string;   // signed: positive = IN, negative = OUT
  unitId: bigint;
  referenceType?: string | null;
  referenceId?: bigint | null;
  performedById?: bigint | null;
  reason?: string | null;
};

export async function move(tx: Prisma.TransactionClient, args: MoveArgs): Promise<Prisma.Decimal> {
  const qty = new Prisma.Decimal(args.quantity as any);
  if (qty.equals(0)) {
    throw new Error("StockService.move: zero quantity is invalid");
  }

  await tx.stockMovement.create({
    data: {
      locationId: args.locationId,
      stockableType: args.stockableType,
      stockableId: args.stockableId,
      movementType: args.movementType,
      quantity: qty,
      unitId: args.unitId,
      referenceType: args.referenceType ?? null,
      referenceId: args.referenceId ?? null,
      performedById: args.performedById ?? null,
      reason: args.reason ?? null,
    },
  });

  // Upsert StockLevel. Postgres can do this atomically with ON CONFLICT.
  const existing = await tx.stockLevel.findUnique({
    where: {
      locationId_stockableType_stockableId: {
        locationId: args.locationId,
        stockableType: args.stockableType,
        stockableId: args.stockableId,
      },
    },
  });

  if (existing) {
    const updated = await tx.stockLevel.update({
      where: { id: existing.id },
      data: { quantity: { increment: qty }, lastMovementAt: new Date() },
    });
    return updated.quantity;
  } else {
    const created = await tx.stockLevel.create({
      data: {
        locationId: args.locationId,
        stockableType: args.stockableType,
        stockableId: args.stockableId,
        quantity: qty,
        unitId: args.unitId,
        lastMovementAt: new Date(),
      },
    });
    return created.quantity;
  }
}

/**
 * Convenience helpers — they enforce the sign convention so callers don't
 * accidentally pass a positive number for a "consume" operation.
 */

export const stockIn = (tx: Prisma.TransactionClient, args: Omit<MoveArgs, "quantity" | "movementType"> & { quantity: Prisma.Decimal | number | string; movementType: MovementType }) =>
  move(tx, { ...args, quantity: new Prisma.Decimal(args.quantity as any).abs() });

export const stockOut = (tx: Prisma.TransactionClient, args: Omit<MoveArgs, "quantity" | "movementType"> & { quantity: Prisma.Decimal | number | string; movementType: MovementType }) =>
  move(tx, { ...args, quantity: new Prisma.Decimal(args.quantity as any).abs().negated() });

/**
 * Resolve the default sale location for a branch:
 *   COUNTER > DISPLAY > KITCHEN > FREEZER > CENTRAL_STORE.
 * If the branch has no stock locations at all, returns null so callers can fall back gracefully.
 */
export async function defaultSaleLocation(
  tx: Prisma.TransactionClient,
  branchId: bigint,
): Promise<bigint | null> {
  const preferenceOrder = ["COUNTER", "DISPLAY", "KITCHEN", "FREEZER", "CENTRAL_STORE"] as const;
  for (const type of preferenceOrder) {
    const loc = await tx.stockLocation.findFirst({
      where: { branchId, type: type as any, isActive: true },
      select: { id: true },
    });
    if (loc) return loc.id;
  }
  return null;
}
