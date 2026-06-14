import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { toJson } from "../lib/serialize.js";

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  category: z.string().max(40).optional(),       // FRUIT | DAIRY | SUGAR | PACKAGING | OTHER
  defaultUnitCode: z.string().min(1),            // looked up below
  isPerishable: z.boolean().optional(),
  reorderLevel: z.coerce.number().nonnegative().optional(),
  reorderQty: z.coerce.number().nonnegative().optional(),
});

const UpdateBody = CreateBody.partial();

export async function registerRawMaterialRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (req) => {
    const q = z.object({
      category: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query);
    const list = await prisma.rawMaterial.findMany({
      where: { ...(q.category ? { category: q.category } : {}) },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      take: q.limit,
      include: { defaultUnit: true },
    });
    return toJson({ rawMaterials: list });
  });

  app.get("/:id", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const m = await prisma.rawMaterial.findUnique({
      where: { id },
      include: { defaultUnit: true },
    });
    if (!m) return reply.code(404).send({ error: "Not found" });
    return toJson({ rawMaterial: m });
  });

  app.post("/", { preHandler: requirePermission("INV_ADJUST", "ADMIN_USER_MGMT") }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const unit = await prisma.unit.findUnique({ where: { code: parsed.data.defaultUnitCode } });
    if (!unit) return reply.code(400).send({ error: `Unknown unit code "${parsed.data.defaultUnitCode}"` });

    const created = await prisma.rawMaterial.create({
      data: {
        name: parsed.data.name,
        category: parsed.data.category,
        defaultUnitId: unit.id,
        isPerishable: parsed.data.isPerishable ?? true,
        reorderLevel: parsed.data.reorderLevel,
        reorderQty: parsed.data.reorderQty,
      },
      include: { defaultUnit: true },
    });
    return toJson({ rawMaterial: created });
  });

  app.patch("/:id", { preHandler: requirePermission("INV_ADJUST", "ADMIN_USER_MGMT") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body" });
    const data: any = { ...parsed.data };
    if (parsed.data.defaultUnitCode) {
      const unit = await prisma.unit.findUnique({ where: { code: parsed.data.defaultUnitCode } });
      if (!unit) return reply.code(400).send({ error: `Unknown unit code "${parsed.data.defaultUnitCode}"` });
      data.defaultUnitId = unit.id;
      delete data.defaultUnitCode;
    }
    const updated = await prisma.rawMaterial.update({ where: { id }, data, include: { defaultUnit: true } });
    return toJson({ rawMaterial: updated });
  });
}
