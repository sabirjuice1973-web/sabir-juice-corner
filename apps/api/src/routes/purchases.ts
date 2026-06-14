import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";
import { stockIn } from "../services/stockService.js";

const PoItemInput = z.object({
  rawMaterialId: z.coerce.bigint(),
  qty: z.coerce.number().positive(),
  unitCode: z.string().min(1),
  rate: z.coerce.number().nonnegative(),
});

const CreatePoBody = z.object({
  supplierId: z.coerce.bigint(),
  branchId: z.coerce.bigint(),
  expectedAt: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
  items: z.array(PoItemInput).min(1),
});

const GrnItemInput = z.object({
  rawMaterialId: z.coerce.bigint(),
  qtyReceived: z.coerce.number().positive(),
  unitCode: z.string().min(1),
  rate: z.coerce.number().nonnegative(),
  condition: z.string().max(80).optional(),
});

const CreateGrnBody = z.object({
  poId: z.coerce.bigint().optional(),
  branchId: z.coerce.bigint(),
  locationId: z.coerce.bigint(),       // central store typically
  notes: z.string().max(500).optional(),
  items: z.array(GrnItemInput).min(1),
});

async function nextSequence(prefix: string, model: "PO" | "GRN"): Promise<string> {
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const count = model === "PO"
    ? await prisma.purchaseOrder.count({ where: { createdAt: { gte: start, lt: end } } })
    : await prisma.goodsReceivedNote.count({ where: { createdAt: { gte: start, lt: end } } });
  return `${prefix}-${ymd}-${String(count + 1).padStart(4, "0")}`;
}

const poInclude = {
  supplier: { select: { id: true, name: true, phone: true } },
  branch: { select: { id: true, code: true, name: true } },
  items: {
    include: {
      rawMaterial: { select: { id: true, name: true } },
      unit: { select: { code: true, name: true } },
    },
  },
  grns: { select: { id: true, grnNo: true, receivedAt: true } },
};

export async function registerPurchaseRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ─── Purchase Orders ─────────────────────────────────────────────────────

  app.get("/orders", async (req) => {
    const q = z.object({
      supplierId: z.coerce.bigint().optional(),
      status: z.enum(["DRAFT","OPEN","PARTIALLY_RECEIVED","RECEIVED","CANCELLED"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query);
    const list = await prisma.purchaseOrder.findMany({
      where: {
        ...(q.supplierId ? { supplierId: q.supplierId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: poInclude,
    });
    return toJson({ orders: list });
  });

  app.get("/orders/:id", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: poInclude });
    if (!po) return reply.code(404).send({ error: "Not found" });
    return toJson({ order: po });
  });

  app.post("/orders", { preHandler: requirePermission("ADMIN_USER_MGMT", "FIN_SUPPLIER_PAY") }, async (req, reply) => {
    const parsed = CreatePoBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const units = await prisma.unit.findMany({
      where: { code: { in: parsed.data.items.map((i) => i.unitCode) } },
    });
    const unitByCode = new Map(units.map((u) => [u.code, u]));
    for (const item of parsed.data.items) {
      if (!unitByCode.has(item.unitCode)) {
        return reply.code(400).send({ error: `Unknown unit code "${item.unitCode}"` });
      }
    }

    const total = parsed.data.items.reduce(
      (s, it) => s.plus(new Prisma.Decimal(it.qty).times(it.rate)),
      new Prisma.Decimal(0),
    );

    const poNo = await nextSequence("PO", "PO");
    const po = await prisma.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: {
          poNo,
          supplierId: parsed.data.supplierId,
          branchId: parsed.data.branchId,
          status: "OPEN",
          expectedAt: parsed.data.expectedAt,
          notes: parsed.data.notes,
          total,
          items: {
            createMany: {
              data: parsed.data.items.map((it) => {
                const qty = new Prisma.Decimal(it.qty);
                const rate = new Prisma.Decimal(it.rate);
                return {
                  rawMaterialId: it.rawMaterialId,
                  qty,
                  unitId: unitByCode.get(it.unitCode)!.id,
                  rate,
                  amount: qty.times(rate),
                };
              }),
            },
          },
        },
        include: poInclude,
      });
      return created;
    });

    await writeAudit({
      req, branchId: parsed.data.branchId,
      action: "po.create", entityType: "PurchaseOrder", entityId: po.id,
      after: { poNo, total: total.toString(), supplierId: parsed.data.supplierId.toString() },
    });
    return toJson({ order: po });
  });

  // ─── Goods Received Notes (GRN) — receiving = stock-in ───────────────────

  app.post("/grn", { preHandler: requirePermission("INV_ADJUST", "INV_PRODUCTION_RECORD") }, async (req, reply) => {
    const parsed = CreateGrnBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    // Validate units up front
    const units = await prisma.unit.findMany({
      where: { code: { in: parsed.data.items.map((i) => i.unitCode) } },
    });
    const unitByCode = new Map(units.map((u) => [u.code, u]));
    for (const item of parsed.data.items) {
      if (!unitByCode.has(item.unitCode)) {
        return reply.code(400).send({ error: `Unknown unit code "${item.unitCode}"` });
      }
    }

    // Validate location belongs to branch
    const location = await prisma.stockLocation.findFirst({
      where: { id: parsed.data.locationId, branchId: parsed.data.branchId, isActive: true },
    });
    if (!location) return reply.code(400).send({ error: "Stock location not found or not at this branch" });

    const grnNo = await nextSequence("GRN", "GRN");
    const result = await prisma.$transaction(async (tx) => {
      const grn = await tx.goodsReceivedNote.create({
        data: {
          grnNo,
          poId: parsed.data.poId,
          receivedById: BigInt(req.auth!.sub),
          notes: parsed.data.notes,
          items: {
            createMany: {
              data: parsed.data.items.map((it) => ({
                rawMaterialId: it.rawMaterialId,
                qtyReceived: new Prisma.Decimal(it.qtyReceived),
                unitId: unitByCode.get(it.unitCode)!.id,
                rate: new Prisma.Decimal(it.rate),
                condition: it.condition,
              })),
            },
          },
        },
        include: { items: true },
      });

      // For each line: stock-in
      for (const line of grn.items) {
        await stockIn(tx, {
          locationId: parsed.data.locationId,
          stockableType: "RAW_MATERIAL",
          stockableId: line.rawMaterialId,
          movementType: "PURCHASE_IN",
          quantity: line.qtyReceived,
          unitId: line.unitId,
          referenceType: "GoodsReceivedNote",
          referenceId: grn.id,
          performedById: BigInt(req.auth!.sub),
        });
      }

      // Update PO status if linked. The just-created GRN is already present in
      // `po.grns` because we re-query after creating; don't add it again.
      if (parsed.data.poId) {
        const po = await tx.purchaseOrder.findUnique({
          where: { id: parsed.data.poId },
          include: { items: true, grns: { include: { items: true } } },
        });
        if (po) {
          const targetByMat = new Map<string, Prisma.Decimal>();
          for (const i of po.items) {
            const k = i.rawMaterialId.toString();
            targetByMat.set(k, (targetByMat.get(k) ?? new Prisma.Decimal(0)).plus(i.qty));
          }
          const receivedByMat = new Map<string, Prisma.Decimal>();
          for (const g of po.grns) {
            for (const li of g.items) {
              const k = li.rawMaterialId.toString();
              receivedByMat.set(k, (receivedByMat.get(k) ?? new Prisma.Decimal(0)).plus(li.qtyReceived));
            }
          }
          let fullyReceived = true;
          let anyReceived = false;
          for (const [mat, target] of targetByMat) {
            const got = receivedByMat.get(mat) ?? new Prisma.Decimal(0);
            if (got.greaterThan(0)) anyReceived = true;
            if (got.lessThan(target)) fullyReceived = false;
          }
          const newStatus = fullyReceived ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : po.status;
          if (newStatus !== po.status) {
            await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: newStatus } });
          }
        }
      }
      return grn;
    });

    await writeAudit({
      req, branchId: parsed.data.branchId,
      action: "grn.receive", entityType: "GoodsReceivedNote", entityId: result.id,
      after: { grnNo, lines: parsed.data.items.length },
    });
    return toJson({ grn: result, grnNo });
  });

  app.get("/grn", async (req) => {
    const q = z.object({
      poId: z.coerce.bigint().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query);
    const list = await prisma.goodsReceivedNote.findMany({
      where: q.poId ? { poId: q.poId } : undefined,
      orderBy: { receivedAt: "desc" },
      take: q.limit,
      include: {
        items: {
          include: {
            rawMaterial: { select: { name: true } },
            unit: { select: { code: true } },
          },
        },
      },
    });
    return toJson({ grns: list });
  });
}
