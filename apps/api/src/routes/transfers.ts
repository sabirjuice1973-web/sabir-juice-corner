import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";
import { stockIn, stockOut } from "../services/stockService.js";
import { getBranchBusinessDate } from "../lib/businessDate.js";

/**
 * Stock transfers central → branch.
 *
 * Lifecycle:
 *   DRAFT → DISPATCHED → RECEIVED          (qtyReceived == qtySent on every line)
 *           DISPATCHED → VARIANCE           (any qtyReceived != qtySent)
 *
 * Stock effects:
 *   Dispatch: stockOut from source location (TRANSFER_OUT)
 *   Receive : stockIn to destination location for the RECEIVED qty (TRANSFER_IN)
 *             Variance is logged on the transfer item and surfaced in reports.
 */

const TransferItemInput = z.object({
  stockableType: z.enum(["RAW_MATERIAL", "PROCESSED_PRODUCT", "PACKAGING"]),
  stockableId: z.coerce.bigint(),
  qty: z.coerce.number().positive(),
  unitCode: z.string().min(1),
});

const CreateBody = z.object({
  fromBranchId: z.coerce.bigint(),
  toBranchId: z.coerce.bigint(),
  fromLocationId: z.coerce.bigint(),
  toLocationId: z.coerce.bigint(),
  notes: z.string().max(500).optional(),
  items: z.array(TransferItemInput).min(1),
});

const ReceiveItemInput = z.object({
  transferItemId: z.coerce.bigint(),
  qtyReceived: z.coerce.number().nonnegative(),
  varianceReason: z.string().max(200).optional(),
});

const ReceiveBody = z.object({
  items: z.array(ReceiveItemInput).min(1),
  notes: z.string().max(500).optional(),
});

const transferInclude = {
  fromBranch: { select: { id: true, code: true, name: true } },
  toBranch:   { select: { id: true, code: true, name: true } },
  fromLocation: { select: { id: true, name: true, type: true } },
  toLocation:   { select: { id: true, name: true, type: true } },
  items: { include: { unit: { select: { code: true } } } },
  dispatchedBy: { select: { id: true, fullName: true } },
  receivedBy: { select: { id: true, fullName: true } },
};

async function nextTransferNo(): Promise<string> {
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const n = await prisma.transfer.count({ where: { createdAt: { gte: start, lt: end } } });
  return `TRF-${ymd}-${String(n + 1).padStart(4, "0")}`;
}

export async function registerTransferRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (req) => {
    const q = z.object({
      fromBranchId: z.coerce.bigint().optional(),
      toBranchId: z.coerce.bigint().optional(),
      status: z.enum(["DRAFT","DISPATCHED","RECEIVED","VARIANCE","CLOSED"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query);
    const list = await prisma.transfer.findMany({
      where: {
        ...(q.fromBranchId ? { fromBranchId: q.fromBranchId } : {}),
        ...(q.toBranchId ? { toBranchId: q.toBranchId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: transferInclude,
    });
    return toJson({ transfers: list });
  });

  app.get("/:id", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const t = await prisma.transfer.findUnique({ where: { id }, include: transferInclude });
    if (!t) return reply.code(404).send({ error: "Not found" });
    return toJson({ transfer: t });
  });

  /** POST /transfers/dispatch — creates a transfer and immediately marks it DISPATCHED (stock out) */
  app.post("/dispatch", { preHandler: requirePermission("INV_TRANSFER_DISPATCH") }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    if (parsed.data.fromBranchId === parsed.data.toBranchId) {
      return reply.code(400).send({ error: "fromBranch and toBranch must differ" });
    }

    const units = await prisma.unit.findMany({ where: { code: { in: parsed.data.items.map((i) => i.unitCode) } } });
    const unitByCode = new Map(units.map((u) => [u.code, u]));
    for (const c of parsed.data.items.map((i) => i.unitCode)) {
      if (!unitByCode.has(c)) return reply.code(400).send({ error: `Unknown unit code "${c}"` });
    }

    // Validate locations belong to the branches
    const [fromLoc, toLoc] = await Promise.all([
      prisma.stockLocation.findFirst({ where: { id: parsed.data.fromLocationId, branchId: parsed.data.fromBranchId } }),
      prisma.stockLocation.findFirst({ where: { id: parsed.data.toLocationId, branchId: parsed.data.toBranchId } }),
    ]);
    if (!fromLoc) return reply.code(400).send({ error: "fromLocationId not at fromBranch" });
    if (!toLoc)   return reply.code(400).send({ error: "toLocationId not at toBranch" });

    const transferNo = await nextTransferNo();
    const businessDate = await getBranchBusinessDate(parsed.data.fromBranchId);
    const result = await prisma.$transaction(async (tx) => {
      const t = await tx.transfer.create({
        data: {
          transferNo,
          fromBranchId: parsed.data.fromBranchId,
          toBranchId: parsed.data.toBranchId,
          fromLocationId: parsed.data.fromLocationId,
          toLocationId: parsed.data.toLocationId,
          status: "DISPATCHED",
          dispatchedById: BigInt(req.auth!.sub),
          dispatchedAt: new Date(),
          businessDate,
          notes: parsed.data.notes,
          items: {
            createMany: {
              data: parsed.data.items.map((it) => ({
                stockableType: it.stockableType,
                stockableId: it.stockableId,
                qtySent: new Prisma.Decimal(it.qty),
                unitId: unitByCode.get(it.unitCode)!.id,
              })),
            },
          },
        },
        include: { items: true },
      });

      // Stock OUT from source
      for (const li of t.items) {
        await stockOut(tx, {
          locationId: t.fromLocationId,
          stockableType: li.stockableType,
          stockableId: li.stockableId,
          movementType: "TRANSFER_OUT",
          quantity: li.qtySent,
          unitId: li.unitId,
          referenceType: "Transfer",
          referenceId: t.id,
          performedById: BigInt(req.auth!.sub),
        });
      }
      return t;
    });

    await writeAudit({
      req, branchId: parsed.data.fromBranchId,
      action: "transfer.dispatch", entityType: "Transfer", entityId: result.id,
      after: { transferNo, items: parsed.data.items.length, toBranchId: parsed.data.toBranchId.toString() },
    });
    const full = await prisma.transfer.findUniqueOrThrow({ where: { id: result.id }, include: transferInclude });
    return toJson({ transfer: full });
  });

  /** POST /transfers/:id/receive — branch confirms receipt, marks variance if any line short */
  app.post("/:id/receive", { preHandler: requirePermission("INV_TRANSFER_RECEIVE") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = ReceiveBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const transfer = await prisma.transfer.findUnique({ where: { id }, include: { items: true } });
    if (!transfer) return reply.code(404).send({ error: "Transfer not found" });
    if (transfer.status !== "DISPATCHED") return reply.code(409).send({ error: `Transfer is ${transfer.status}` });

    const itemById = new Map(transfer.items.map((i) => [i.id.toString(), i]));
    for (const r of parsed.data.items) {
      if (!itemById.has(r.transferItemId.toString())) {
        return reply.code(400).send({ error: `Unknown transfer item ${r.transferItemId}` });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      let hasVariance = false;
      for (const r of parsed.data.items) {
        const li = itemById.get(r.transferItemId.toString())!;
        const qtyReceived = new Prisma.Decimal(r.qtyReceived);
        const isShort = qtyReceived.lessThan(li.qtySent);
        const isOver  = qtyReceived.greaterThan(li.qtySent);
        if (isShort || isOver) hasVariance = true;

        await tx.transferItem.update({
          where: { id: li.id },
          data: { qtyReceived, varianceReason: isShort || isOver ? (r.varianceReason ?? null) : null },
        });
        if (qtyReceived.greaterThan(0)) {
          await stockIn(tx, {
            locationId: transfer.toLocationId,
            stockableType: li.stockableType,
            stockableId: li.stockableId,
            movementType: "TRANSFER_IN",
            quantity: qtyReceived,
            unitId: li.unitId,
            referenceType: "Transfer",
            referenceId: transfer.id,
            performedById: BigInt(req.auth!.sub),
          });
        }
      }
      return tx.transfer.update({
        where: { id },
        data: {
          status: hasVariance ? "VARIANCE" : "RECEIVED",
          receivedById: BigInt(req.auth!.sub),
          receivedAt: new Date(),
          notes: parsed.data.notes ?? transfer.notes,
        },
        include: transferInclude,
      });
    });

    await writeAudit({
      req, branchId: transfer.toBranchId,
      action: result.status === "VARIANCE" ? "transfer.receive.variance" : "transfer.receive",
      entityType: "Transfer", entityId: id,
      before: { status: transfer.status },
      after: { status: result.status },
    });
    return toJson({ transfer: result });
  });
}
