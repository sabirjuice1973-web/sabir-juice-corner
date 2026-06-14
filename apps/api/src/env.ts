import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Walk up from this file looking for a .env (handles monorepo: apps/api → root)
const __dirname = dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  resolve(__dirname, "../../../.env"),
  resolve(__dirname, "../../.env"),
  resolve(__dirname, "../.env"),
  resolve(process.cwd(), ".env"),
]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate });
    break;
  }
}

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32).default("dev-access-secret-please-replace-in-production"),
  JWT_REFRESH_SECRET: z.string().min(32).default("dev-refresh-secret-please-replace-in-production"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Empty string in .env should resolve to undefined (not a Zod "too_small" error)
  OPENAI_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  OPENAI_MODEL: z.string().min(1).default("gpt-4o-mini"),
});

export const env = Env.parse(process.env);
