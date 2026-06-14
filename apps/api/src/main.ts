import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { env } from "./env.js";
import { registerJwt } from "./lib/jwt.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerBranchRoutes } from "./routes/branches.js";
import { registerExpenseRoutes } from "./routes/expenses.js";
import { registerItemRoutes } from "./routes/items.js";
import { registerReconciliationRoutes } from "./routes/reconciliation.js";
import { registerShiftRoutes } from "./routes/shifts.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerRawMaterialRoutes } from "./routes/rawMaterials.js";
import { registerSupplierRoutes } from "./routes/suppliers.js";
import { registerPurchaseRoutes } from "./routes/purchases.js";
import { registerProductionRoutes } from "./routes/production.js";
import { registerCatalogRoutes } from "./routes/recipes.js";
import { registerTransferRoutes } from "./routes/transfers.js";
import { registerStockRoutes } from "./routes/stock.js";
import { registerReportsRoutes } from "./routes/reports.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerLedgerRoutes } from "./routes/ledger.js";

async function bootstrap() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } }
          : undefined,
    },
  });

  await app.register(helmet);
  await app.register(cors, { origin: true, credentials: true });
  // Multipart for menu-xlsx upload (POST /items/import). Limit 5 MB —
  // a menu xlsx is realistically a few KB, this leaves plenty of headroom.
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await registerJwt(app);

  app.register(registerHealthRoutes,        { prefix: "/api/v1" });
  app.register(registerAuthRoutes,          { prefix: "/api/v1/auth" });
  app.register(registerBranchRoutes,        { prefix: "/api/v1/branches" });
  app.register(registerExpenseRoutes,       { prefix: "/api/v1/expenses" });
  app.register(registerItemRoutes,          { prefix: "/api/v1/items" });
  app.register(registerReconciliationRoutes,{ prefix: "/api/v1/reconciliation" });
  app.register(registerAccountRoutes,       { prefix: "/api/v1/accounts" });
  app.register(registerShiftRoutes,         { prefix: "/api/v1/shifts" });
  app.register(registerOrderRoutes,         { prefix: "/api/v1/orders" });
  app.register(registerRawMaterialRoutes,   { prefix: "/api/v1/raw-materials" });
  app.register(registerSupplierRoutes,      { prefix: "/api/v1/suppliers" });
  app.register(registerPurchaseRoutes,      { prefix: "/api/v1/purchases" });
  app.register(registerProductionRoutes,    { prefix: "/api/v1/production" });
  app.register(registerCatalogRoutes,       { prefix: "/api/v1/catalog" });
  app.register(registerTransferRoutes,      { prefix: "/api/v1/transfers" });
  app.register(registerStockRoutes,         { prefix: "/api/v1/stock" });
  app.register(registerReportsRoutes,       { prefix: "/api/v1/reports" });
  app.register(registerAlertRoutes,         { prefix: "/api/v1/alerts" });
  app.register(registerAiRoutes,            { prefix: "/api/v1/ai" });
  app.register(registerLedgerRoutes,        { prefix: "/api/v1/ledger" });

  try {
    await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
    app.log.info(`Sabir Juice Corner API listening on :${env.API_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

bootstrap();
