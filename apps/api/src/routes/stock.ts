import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";
import { move } from "../services/stockService.js";
import { Prisma } from "@prisma/client";

const LevelsQuery = z.object({
  branchId: z.coerce.bigint().optional(),
  locationId: z.coerce.bigint().optional(),
  stockableType: z.enum(["RAW_MATERIAL", "PROCESSED_PRODUCT", "PACKAGING", "FINISHED_ITEM"]).optional(),
  lowStockOnly: z.coerce.boolean().optional(),
});

const LocationCreateBody = z.object({
  branchId: z.coerce.bigint(),
  name: z.string().min(1).max(80),
  type: z.enum(["CENTRAL_STORE", "FREEZER", "COUNTER", "DISPLAY", "KITCHEN"]),
});

const AdjustBody = z.object({
  locationId: z.coerce.bigint(),
  stockableType: z.enum(["RAW_MATERIAL", "PROCESSED_PRODUCT", "PACKAGING", "FINISHED_ITEM"]),
  stockableId: z.coerce.bigint(),
  quantity: z.coerce.number(),         // signed
  unitCode: z.string().min(1),
  reason: z.string().min(2).max(200),
});

export async function registerStockRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ─── Locations ───────────────────────────────────────────────────────────
  app.get("/locations", async (req) => {
    const q = z.object({ branchId: z.coerce.bigint().optional() }).parse(req.query);
    const list = await prisma.stockLocation.findMany({
      where: { ...(q.branchId ? { branchId: q.branchId } : {}), isActive: true },
      orderBy: [{ branchId: "asc" }, { type: "asc" }, { name: "asc" }],
      include: { branch: { select: { code: true, name: true } } },
    });
    return toJson({ locations: list });
  });

  app.post("/locations", { preHandler: requirePermission("ADMIN_USER_MGMT") }, async (req, reply) => {
    const parsed = LocationCreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body" });
    const created = await prisma.stockLocation.create({ data: parsed.data });
    return toJson({ location: created });
  });

  // ─── Levels ──────────────────────────────────────────────────────────────

  app.get("/levels", async (req) => {
    const q = LevelsQuery.parse(req.query);

    // Find candidate locations first
    const locations = await prisma.stockLocation.findMany({
      where: {
        isActive: true,
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.locationId ? { id: q.locationId } : {}),
      },
      include: { branch: { select: { id: true, code: true, name: true } } },
    });

    const rows = await prisma.stockLevel.findMany({
      where: {
        locationId: { in: locations.map((l) => l.id) },
        ...(q.stockableType ? { stockableType: q.stockableType } : {}),
      },
      include: { unit: { select: { code: true } } },
    });

    // Hydrate names per stockableType
    const rawIds = rows.filter((r) => r.stockableType === "RAW_MATERIAL").map((r) => r.stockableId);
    const procIds = rows.filter((r) => r.stockableType === "PROCESSED_PRODUCT").map((r) => r.stockableId);
    const [raws, procs] = await Promise.all([
      rawIds.length
        ? prisma.rawMaterial.findMany({ where: { id: { in: rawIds } }, select: { id: true, name: true, reorderLevel: true } })
        : Promise.resolve([]),
      procIds.length
        ? prisma.processedProduct.findMany({ where: { id: { in: procIds } }, select: { id: true, name: true, defaultGlassesPerUnit: true } })
        : Promise.resolve([]),
    ]);
    const rawById = new Map(raws.map((r) => [r.id.toString(), r]));
    const procById = new Map(procs.map((p) => [p.id.toString(), p]));
    const locById = new Map(locations.map((l) => [l.id.toString(), l]));

    let serialized = rows.map((r) => {
      const loc = locById.get(r.locationId.toString())!;
      const name =
        r.stockableType === "RAW_MATERIAL"
          ? rawById.get(r.stockableId.toString())?.name
          : r.stockableType === "PROCESSED_PRODUCT"
          ? procById.get(r.stockableId.toString())?.name
          : `(${r.stockableType} #${r.stockableId})`;
      const reorderLevel = r.stockableType === "RAW_MATERIAL"
        ? rawById.get(r.stockableId.toString())?.reorderLevel ?? null
        : null;
      const glassesPerUnit = r.stockableType === "PROCESSED_PRODUCT"
        ? procById.get(r.stockableId.toString())?.defaultGlassesPerUnit ?? null
        : null;
      return {
        locationId: r.locationId.toString(),
        location: { name: loc.name, type: loc.type, branch: loc.branch },
        stockableType: r.stockableType,
        stockableId: r.stockableId.toString(),
        name,
        quantity: r.quantity.toString(),
        unit: r.unit.code,
        reorderLevel: reorderLevel ? reorderLevel.toString() : null,
        glassesPerUnit: glassesPerUnit ? glassesPerUnit.toString() : null,
        expectedGlasses: glassesPerUnit ? r.quantity.times(glassesPerUnit).toString() : null,
      };
    });

    if (q.lowStockOnly) {
      serialized = serialized.filter((s) => s.reorderLevel && Number(s.quantity) <= Number(s.reorderLevel));
    }
    return toJson({ levels: serialized });
  });

  /** POST /stock/adjust — manual correction with mandatory reason */
  app.post("/adjust", { preHandler: requirePermission("INV_ADJUST") }, async (req, reply) => {
    const parsed = AdjustBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const unit = await prisma.unit.findUnique({ where: { code: parsed.data.unitCode } });
    if (!unit) return reply.code(400).send({ error: `Unknown unit code "${parsed.data.unitCode}"` });

    const newQty = await prisma.$transaction(async (tx) => {
      return move(tx, {
        locationId: parsed.data.locationId,
        stockableType: parsed.data.stockableType,
        stockableId: parsed.data.stockableId,
        movementType: "ADJUSTMENT",
        quantity: new Prisma.Decimal(parsed.data.quantity),
        unitId: unit.id,
        performedById: BigInt(req.auth!.sub),
        reason: parsed.data.reason,
      });
    });

    await writeAudit({
      req,
      action: "stock.adjust", entityType: "StockLevel",
      after: { delta: parsed.data.quantity, reason: parsed.data.reason, newQty: newQty.toString() },
    });
    return toJson({ newQty: newQty.toString() });
  });
}
