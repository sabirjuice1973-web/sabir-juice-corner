import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { toJson } from "../lib/serialize.js";
import { branchPnL, itemProfitability, varianceReport } from "../services/reportsService.js";
import { runAllRules } from "../services/anomalyService.js";

const Range = z.object({
  branchId: z.coerce.bigint().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
});

export async function registerReportsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/variance", { preHandler: requirePermission("FIN_VIEW_PROFIT", "ADMIN_AUDIT_VIEW") }, async (req, reply) => {
    const q = Range.safeParse(req.query);
    if (!q.success || !q.data.branchId) {
      return reply.code(400).send({ error: "branchId, from, to required (YYYY-MM-DD)" });
    }
    const r = await varianceReport({ branchId: q.data.branchId, from: q.data.from, to: q.data.to });
    return toJson(r);
  });

  app.get("/pnl", { preHandler: requirePermission("FIN_VIEW_PROFIT") }, async (req, reply) => {
    const q = Range.safeParse(req.query);
    if (!q.success || !q.data.branchId) {
      return reply.code(400).send({ error: "branchId, from, to required" });
    }
    const r = await branchPnL({ branchId: q.data.branchId, from: q.data.from, to: q.data.to });
    return toJson(r);
  });

  app.get("/item-profitability", { preHandler: requirePermission("FIN_VIEW_PROFIT") }, async (req, reply) => {
    const q = Range.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "from, to required" });
    const r = await itemProfitability({ branchId: q.data.branchId, from: q.data.from, to: q.data.to });
    return toJson(r);
  });

  app.post("/anomalies/scan", { preHandler: requirePermission("ADMIN_AUDIT_VIEW") }, async (req, reply) => {
    const q = z.object({ windowDays: z.coerce.number().int().min(1).max(30).optional() }).safeParse(req.body ?? {});
    if (!q.success) return reply.code(400).send({ error: "Invalid body" });
    const r = await runAllRules({ windowDays: q.data.windowDays });
    return toJson({ created: r.created, total: r.signals.length });
  });
}
