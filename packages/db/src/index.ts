import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __sjcPrisma: PrismaClient | undefined;
}

export const prisma =
  global.__sjcPrisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "production"
        ? ["error", "warn"]
        : ["query", "info", "warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__sjcPrisma = prisma;
}

export * from "@prisma/client";
