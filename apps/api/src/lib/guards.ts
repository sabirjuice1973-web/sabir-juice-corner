import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { prisma } from "@sjc/db";
import { extractBearerToken } from "./jwt.js";

/**
 * Requires a valid access token. Attaches `req.auth` for downstream handlers.
 */
export const requireAuth: preHandlerAsyncHookHandler = async (req, reply) => {
  const token = extractBearerToken(req);
  if (!token) {
    return reply.code(401).send({ error: "Missing bearer token" });
  }
  try {
    req.auth = req.server.verifyAccessToken(token);
    if (req.auth.type !== "access") throw new Error("wrong token type");
  } catch {
    return reply.code(401).send({ error: "Invalid or expired token" });
  }
};

/**
 * Requires the authenticated user to have at least one of the given permission codes
 * (resolved via their role assignments). OWNER short-circuits to allow.
 */
export function requirePermission(...required: string[]): preHandlerAsyncHookHandler {
  return async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (req.auth.roles.some((r) => r.code === "OWNER")) return;

    const roleCodes = req.auth.roles.map((r) => r.code);
    if (roleCodes.length === 0) return reply.code(403).send({ error: "No role assigned" });

    const has = await prisma.rolePermission.findFirst({
      where: {
        role: { code: { in: roleCodes } },
        permission: { code: { in: required } },
      },
      select: { roleId: true },
    });
    if (!has) {
      return reply.code(403).send({ error: "Permission denied", required });
    }
  };
}

/**
 * For branch-scoped resources: ensures the authenticated user is either OWNER
 * or has at least one role assignment at the given branchId.
 */
export function requireBranchAccess(getBranchId: (req: FastifyRequest) => string): preHandlerAsyncHookHandler {
  return async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (req.auth.roles.some((r) => r.code === "OWNER")) return;

    const branchId = getBranchId(req);
    const ok = req.auth.roles.some(
      (r) => r.branchId === null || r.branchId === branchId,
    );
    if (!ok) {
      return reply.code(403).send({ error: "Branch access denied", branchId });
    }
  };
}

export async function loadUserRoles(userId: bigint) {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: true },
  });
  return userRoles.map((ur) => ({
    code: ur.role.code,
    branchId: ur.branchId ? ur.branchId.toString() : null,
  }));
}

/** Small helper so route handlers can fail fast on missing auth (TS guard). */
export function assertAuth(req: FastifyRequest): asserts req is FastifyRequest & { auth: NonNullable<FastifyRequest["auth"]> } {
  if (!req.auth) throw new Error("requireAuth must run before this handler");
}
