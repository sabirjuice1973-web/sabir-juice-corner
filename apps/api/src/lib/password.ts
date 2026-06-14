import bcrypt from "bcrypt";
import { createHash } from "node:crypto";

const BCRYPT_ROUNDS = 12;

/**
 * Verifies a plaintext password against a stored hash.
 *
 * Supports two formats:
 *   1. bcrypt — the production format. Hashes start with "$2a$", "$2b$", or "$2y$".
 *   2. dev$<salt>$<sha256>  — a transitional format the Phase-0 seed wrote. Any
 *      user still on this format is silently re-hashed to bcrypt on next login.
 *
 * The dev path will be removed in Phase 2 once all seed users have logged in once.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$2")) {
    return bcrypt.compare(plain, stored);
  }
  if (stored.startsWith("dev$")) {
    const [, salt, hash] = stored.split("$");
    const candidate = createHash("sha256").update(salt + plain).digest("hex");
    return candidate === hash;
  }
  return false;
}

export function isLegacyHash(stored: string): boolean {
  return stored.startsWith("dev$");
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
