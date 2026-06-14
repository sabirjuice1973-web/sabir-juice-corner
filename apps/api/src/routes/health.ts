import type { FastifyInstance } from "fastify";
import { prisma } from "@sjc/db";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    status: "ok",
    service: "sjc-api",
    time: new Date().toISOString(),
  }));

  app.get("/health/db", async () => {
    const [orgCount, itemCount, branchCount] = await Promise.all([
      prisma.organization.count(),
      prisma.item.count(),
      prisma.branch.count(),
    ]);
    return {
      status: "ok",
      counts: { organizations: orgCount, items: itemCount, branches: branchCount },
    };
  });
}
