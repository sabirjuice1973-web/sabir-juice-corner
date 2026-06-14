import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";
import { stockIn, stockOut } from "../services/stockService.js";

/**
 * Production batches: raw fruit → processed pulp/shopers.
 *
 * Domain shape:
 *   • inputs: raw materials consumed (e.g., 100 kg peach, 5 kg sugar)
 *   • outputs: processed products produced (e.g., 80 shopers peach pulp)
 *   • wastage: tracked, with reason
 *
 * Stock effects on completion:
 *   • inputs        → stockOut from source location  (raw material)
 *   • outputs       → stockIn  to destination location (processed product)
 *   • wastage       → stockOut from source location  (raw material, WASTAGE movement)
 *
 * Yield % is informational only; we don't enforce a threshold. The leakage
 * detector reports unusually low yields later.
 */

const InputLine = z.object({
  rawMaterialId: z.coerce.bigint(),
  quantity: z.coerce.number().positive(),
  unitCode: z.string().min(1),
  costAtIntake: z.coerce.number().nonnegative().optional(),
});

const OutputLine = z.object({
  processedProductId: z.coerce.bigint(),
  outputQty: z.coerce.number().positive(),
  outputUnitCode: z.string().min(1),
});

const WastageLine = z.object({
  quantity: z.coerce.number().positive(),
  unitCode: z.string().min(1),
  reason: z.string().max(200).optional(),
});

const StartBody = z.object({
  branchId: z.coerce.bigint(),                  // central kitchen
  sourceLocationId: z.coerce.bigint(),          // where raw materials are drawn from
  destinationLocationId: z.coerce.bigint(),     // where processed products are stored
  inputs: z.array(InputLine).min(1),
  outputs: z.array(OutputLine).min(1),
  wastages: z.array(WastageLine).optional(),
  notes: z.string().max(500).optional(),
});

async function nextBatchNo(): Promise<string> {
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const count = await prisma.productionBatch.count({ where: { startedAt: { gte: start, lt: end } } });
  return `BATCH-${ymd}-${String(count + 1).padStart(4, "0")}`;
}

const batchInclude = {
  branch: { select: { id: true, code: true, name: true } },
  supervisedBy: { select: { id: true, fullName: true } },
  inputs: { include: { rawMaterial: { select: { name: true } }, unit: { select: { code: true } } } },
  outputs: { include: { processedProduct: { select: { name: true, defaultGlassesPerUnit: true } }, outputUnit: { select: { code: true } } } },
  wastages: { include: { unit: { select: { code: true } } } },
};

export async function registerProductionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/batches", async (req) => {
    const q = z.object({
      branchId: z.coerce.bigint().optional(),
      status: z.enum(["OPEN","COMPLETED","REJECTED"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query);
    const list = await prisma.productionBatch.findMany({
      where: {
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { startedAt: "desc" },
      take: q.limit,
      include: batchInclude,
    });
    return toJson({ batches: list.map(serializeBatch) });
  });

  app.get("/batches/:id", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const b = await prisma.productionBatch.findUnique({ where: { id }, include: batchInclude });
    if (!b) return reply.code(404).send({ error: "Not found" });
    return toJson({ batch: serializeBatch(b) });
  });

  /**
   * POST /production/batches — one-shot create + complete a batch.
   * For simplicity, every batch is created already-complete. If a multi-step
   * workflow is needed later, add /start and /complete as separate endpoints.
   */
  app.post("/batches", { preHandler: requirePermission("INV_PRODUCTION_RECORD") }, async (req, reply) => {
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    // Validate units
    const allUnitCodes = [
      ...parsed.data.inputs.map((i) => i.unitCode),
      ...parsed.data.outputs.map((o) => o.outputUnitCode),
      ...(parsed.data.wastages?.map((w) => w.unitCode) ?? []),
    ];
    const units = await prisma.unit.findMany({ where: { code: { in: allUnitCodes } } });
    const unitByCode = new Map(units.map((u) => [u.code, u]));
    for (const c of allUnitCodes) {
      if (!unitByCode.has(c)) return reply.code(400).send({ error: `Unknown unit code "${c}"` });
    }

    // Validate locations
    const [sourceLoc, destLoc] = await Promise.all([
      prisma.stockLocation.findFirst({ where: { id: parsed.data.sourceLocationId, branchId: parsed.data.branchId, isActive: true } }),
      prisma.stockLocation.findFirst({ where: { id: parsed.data.destinationLocationId, branchId: parsed.data.branchId, isActive: true } }),
    ]);
    if (!sourceLoc) return reply.code(400).send({ error: "Source location not found at this branch" });
    if (!destLoc) return reply.code(400).send({ error: "Destination location not found at this branch" });

    const batchNo = await nextBatchNo();
    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.productionBatch.create({
        data: {
          batchNo,
          branchId: parsed.data.branchId,
          supervisedById: BigInt(req.auth!.sub),
          status: "COMPLETED",
          completedAt: new Date(),
          notes: parsed.data.notes,
          inputs: {
            createMany: {
              data: parsed.data.inputs.map((i) => ({
                rawMaterialId: i.rawMaterialId,
                quantity: new Prisma.Decimal(i.quantity),
                unitId: unitByCode.get(i.unitCode)!.id,
                costAtIntake: new Prisma.Decimal(i.costAtIntake ?? 0),
              })),
            },
          },
          outputs: {
            createMany: {
              data: parsed.data.outputs.map((o) => ({
                processedProductId: o.processedProductId,
                outputQty: new Prisma.Decimal(o.outputQty),
                outputUnitId: unitByCode.get(o.outputUnitCode)!.id,
              })),
            },
          },
          wastages: parsed.data.wastages
            ? {
                createMany: {
                  data: parsed.data.wastages.map((w) => ({
                    wastageQty: new Prisma.Decimal(w.quantity),
                    unitId: unitByCode.get(w.unitCode)!.id,
                    reason: w.reason,
                  })),
                },
              }
            : undefined,
        },
        include: { inputs: true, outputs: true, wastages: true },
      });

      // Stock effects
      for (const inp of batch.inputs) {
        await stockOut(tx, {
          locationId: parsed.data.sourceLocationId,
          stockableType: "RAW_MATERIAL",
          stockableId: inp.rawMaterialId,
          movementType: "PRODUCTION_CONSUME",
          quantity: inp.quantity,
          unitId: inp.unitId,
          referenceType: "ProductionBatch",
          referenceId: batch.id,
          performedById: BigInt(req.auth!.sub),
        });
      }
      for (const out of batch.outputs) {
        await stockIn(tx, {
          locationId: parsed.data.destinationLocationId,
          stockableType: "PROCESSED_PRODUCT",
          stockableId: out.processedProductId,
          movementType: "PRODUCTION_IN",
          quantity: out.outputQty,
          unitId: out.outputUnitId,
          referenceType: "ProductionBatch",
          referenceId: batch.id,
          performedById: BigInt(req.auth!.sub),
        });
      }
      // Wastage doesn't have a specific raw_material attribution in our schema;
      // we treat it as a write-off at the source location against an UNATTRIBUTED
      // generic "wastage bucket" — record movements without a stockable would
      // need a sentinel. For now, log wastages on the batch only and skip the
      // stock movement; they're reflected via the inputs/outputs delta already.
      return batch;
    });

    await writeAudit({
      req, branchId: parsed.data.branchId,
      action: "production.batch.complete",
      entityType: "ProductionBatch", entityId: result.id,
      after: { batchNo, inputs: parsed.data.inputs.length, outputs: parsed.data.outputs.length },
    });

    const full = await prisma.productionBatch.findUniqueOrThrow({ where: { id: result.id }, include: batchInclude });
    return toJson({ batch: serializeBatch(full) });
  });
}

function serializeBatch(b: any) {
  const totalInputCost = b.inputs.reduce((s: Prisma.Decimal, i: any) => s.plus(i.costAtIntake.times(i.quantity)), new Prisma.Decimal(0));
  return {
    ...b,
    yieldSummary: {
      inputUnits: b.inputs.reduce((s: Prisma.Decimal, i: any) => s.plus(i.quantity), new Prisma.Decimal(0)).toString(),
      outputUnits: b.outputs.reduce((s: Prisma.Decimal, o: any) => s.plus(o.outputQty), new Prisma.Decimal(0)).toString(),
      wastageUnits: (b.wastages ?? []).reduce((s: Prisma.Decimal, w: any) => s.plus(w.wastageQty), new Prisma.Decimal(0)).toString(),
      totalInputCost: totalInputCost.toString(),
    },
  };
}
