import type { FastifyRequest } from "fastify";
import { prisma } from "@sjc/db";

/**
 * Write an audit row. Never throws — audit failures must not block the action.
 * Returns the new audit id (or null on failure) for callers that want a reference.
 */
export async function writeAudit(args: {
  req?: FastifyRequest;
  userId?: bigint | null;
  branchId?: bigint | null;
  action: string;            // dot-namespaced: "order.void", "shift.close", "stock.adjust"
  entityType: string;
  entityId?: string | bigint | null;
  before?: unknown;
  after?: unknown;
}): Promise<bigint | null> {
  try {
    const userId = args.userId ?? (args.req?.auth ? BigInt(args.req.auth.sub) : null);
    const ip = args.req?.ip ?? null;
    const row = await prisma.auditLog.create({
      data: {
        userId,
        branchId: args.branchId ?? null,
        action: args.action,
        entityType: args.entityType,
        entityId: args.entityId ? String(args.entityId) : null,
        before: args.before ? (args.before as object) : undefined,
        after: args.after ? (args.after as object) : undefined,
        ip,
      },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    args.req?.log?.error({ err: e }, "audit log write failed");
    return null;
  }
}
