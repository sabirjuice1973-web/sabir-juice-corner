import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { toJson } from "../lib/serialize.js";

const IngredientInput = z.object({
  ingredientType: z.enum(["RAW_MATERIAL", "PROCESSED_PRODUCT", "PACKAGING", "OTHER"]),
  rawMaterialId: z.coerce.bigint().optional(),
  processedProductId: z.coerce.bigint().optional(),
  quantity: z.coerce.number().positive(),
  unitCode: z.string().min(1),
  isOptional: z.boolean().optional(),
});

const CreateRecipeBody = z.object({
  itemId: z.coerce.bigint(),
  yieldQty: z.coerce.number().int().positive().default(1),
  notes: z.string().max(500).optional(),
  ingredients: z.array(IngredientInput).min(1),
});

// ─── Processed products ────────────────────────────────────────────────────

const CreateProcessedBody = z.object({
  name: z.string().min(1).max(80),
  storageUnit: z.enum(["shoper", "kg", "liter"]).default("shoper"),
  defaultGlassesPerUnit: z.coerce.number().positive().default(12),
  shelfLifeDays: z.coerce.number().int().positive().default(7),
});

export async function registerCatalogRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ─── Processed products (pulp / shopers) ─────────────────────────────────

  app.get("/processed", async () => {
    const list = await prisma.processedProduct.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });
    return toJson({ processedProducts: list });
  });

  app.post("/processed", { preHandler: requirePermission("INV_PRODUCTION_RECORD", "ADMIN_USER_MGMT") }, async (req, reply) => {
    const parsed = CreateProcessedBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body" });
    const created = await prisma.processedProduct.create({
      data: {
        name: parsed.data.name,
        storageUnit: parsed.data.storageUnit,
        defaultGlassesPerUnit: new Prisma.Decimal(parsed.data.defaultGlassesPerUnit),
        shelfLifeDays: parsed.data.shelfLifeDays,
      },
    });
    return toJson({ processedProduct: created });
  });

  // ─── Recipes ─────────────────────────────────────────────────────────────

  app.get("/recipes/by-item/:itemId", async (req, reply) => {
    const itemId = BigInt((req.params as { itemId: string }).itemId);
    const recipe = await prisma.recipe.findFirst({
      where: { itemId, isActive: true },
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
    if (!recipe) return reply.code(404).send({ error: "No active recipe for this item" });
    return toJson({ recipe });
  });

  app.post("/recipes", { preHandler: requirePermission("ADMIN_USER_MGMT", "INV_PRODUCTION_RECORD") }, async (req, reply) => {
    const parsed = CreateRecipeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    // Sanity: ingredient FK is set according to type
    for (const ing of parsed.data.ingredients) {
      if (ing.ingredientType === "RAW_MATERIAL" && !ing.rawMaterialId) {
        return reply.code(400).send({ error: "rawMaterialId required for RAW_MATERIAL ingredient" });
      }
      if (ing.ingredientType === "PROCESSED_PRODUCT" && !ing.processedProductId) {
        return reply.code(400).send({ error: "processedProductId required for PROCESSED_PRODUCT ingredient" });
      }
    }

    const units = await prisma.unit.findMany({ where: { code: { in: parsed.data.ingredients.map((i) => i.unitCode) } } });
    const unitByCode = new Map(units.map((u) => [u.code, u]));
    for (const ing of parsed.data.ingredients) {
      if (!unitByCode.has(ing.unitCode)) return reply.code(400).send({ error: `Unknown unit code "${ing.unitCode}"` });
    }

    const item = await prisma.item.findUnique({ where: { id: parsed.data.itemId } });
    if (!item) return reply.code(404).send({ error: "Item not found" });

    const created = await prisma.$transaction(async (tx) => {
      // Deactivate any prior active recipe for this item
      await tx.recipe.updateMany({ where: { itemId: parsed.data.itemId, isActive: true }, data: { isActive: false } });

      // Find next version
      const last = await tx.recipe.findFirst({
        where: { itemId: parsed.data.itemId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const nextVersion = (last?.version ?? 0) + 1;

      return tx.recipe.create({
        data: {
          itemId: parsed.data.itemId,
          version: nextVersion,
          isActive: true,
          yieldQty: parsed.data.yieldQty,
          notes: parsed.data.notes,
          ingredients: {
            createMany: {
              data: parsed.data.ingredients.map((ing) => ({
                ingredientType: ing.ingredientType,
                rawMaterialId: ing.ingredientType === "RAW_MATERIAL" ? ing.rawMaterialId! : null,
                processedProductId: ing.ingredientType === "PROCESSED_PRODUCT" ? ing.processedProductId! : null,
                quantity: new Prisma.Decimal(ing.quantity),
                unitId: unitByCode.get(ing.unitCode)!.id,
                isOptional: ing.isOptional ?? false,
              })),
            },
          },
        },
        include: { ingredients: true },
      });
    });

    return toJson({ recipe: created });
  });
}
