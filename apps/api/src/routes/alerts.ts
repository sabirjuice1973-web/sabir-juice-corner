import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { toJson } from "../lib/serialize.js";

export async function registerAlertRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (req) => {
    const q = z.object({
      branchId: z.coerce.bigint().optional(),
      includeAcknowledged: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query);
    const list = await prisma.alert.findMany({
      where: {
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.includeAcknowledged ? {} : { acknowledgedAt: null }),
      },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      take: q.limit,
      include: {
        rule: { select: { code: true, name: true } },
        branch: { select: { id: true, code: true, name: true } },
      },
    });
    return toJson({ alerts: list });
  });

  app.post("/:id/acknowledge", { preHandler: requirePermission("ADMIN_AUDIT_VIEW") }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const a = await prisma.alert.findUnique({ where: { id } });
    if (!a) return reply.code(404).send({ error: "Alert not found" });
    if (a.acknowledgedAt) return reply.code(409).send({ error: "Already acknowledged" });
    const updated = await prisma.alert.update({
      where: { id },
      data: { acknowledgedAt: new Date(), acknowledgedBy: BigInt(req.auth!.sub) },
    });
    return toJson({ alert: updated });
  });

  /** GET /alerts/summary?branchId=&days=7  — counts grouped by rule + severity, useful for dashboard */
  app.get("/summary", async (req) => {
    const q = z.object({
      branchId: z.coerce.bigint().optional(),
      days: z.coerce.number().int().min(1).max(90).default(7),
    }).parse(req.query);
    const since = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000);
    const counts = await prisma.alert.groupBy({
      by: ["severity"],
      where: {
        ...(q.branchId ? { branchId: q.branchId } : {}),
        createdAt: { gte: since },
        acknowledgedAt: null,
      },
      _count: { _all: true },
    });
    return toJson({
      open: {
        CRITICAL: counts.find((c) => c.severity === "CRITICAL")?._count._all ?? 0,
        HIGH:     counts.find((c) => c.severity === "HIGH")?._count._all ?? 0,
        MEDIUM:   counts.find((c) => c.severity === "MEDIUM")?._count._all ?? 0,
        LOW:      counts.find((c) => c.severity === "LOW")?._count._all ?? 0,
      },
    });
  });
}
