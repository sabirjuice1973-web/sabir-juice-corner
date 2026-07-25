import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@sjc/db";
import { hashPassword } from "../lib/password.js";
import { requireAuth, assertAuth } from "../lib/guards.js";
import { toJson } from "../lib/serialize.js";

function ownerOnly(req: any, reply: any) {
  if (!req.auth?.roles?.some((r: any) => r.code === "OWNER")) {
    return reply.code(403).send({ error: "Owner access required" });
  }
}

const CreateBody = z.object({
  username: z.string().min(2).max(50),
  fullName: z.string().min(1).max(100),
  password: z.string().min(4).max(100),
  roleCode: z.enum(["CASHIER", "BRANCH_MANAGER", "ACCOUNTANT"]).default("CASHIER"),
  branchId: z.string().optional(),
});

const PasswordBody = z.object({
  password: z.string().min(4).max(100),
});

export async function registerUserRoutes(app: FastifyInstance) {
  // List all users
  app.get("/", { preHandler: requireAuth }, async (req, reply) => {
    assertAuth(req);
    const blocked = ownerOnly(req, reply); if (blocked) return blocked;

    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      select: {
        id: true, username: true, fullName: true,
        status: true, lastLoginAt: true,
        userRoles: {
          include: {
            role: { select: { code: true } },
            branch: { select: { id: true, code: true, name: true } },
          },
        },
      },
      orderBy: { id: "asc" },
    });
    return toJson({ users });
  });

  // Create a new user
  app.post("/", { preHandler: requireAuth }, async (req, reply) => {
    assertAuth(req);
    const blocked = ownerOnly(req, reply); if (blocked) return blocked;

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body" });
    const { username, fullName, password, roleCode, branchId } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return reply.code(409).send({ error: "Username already taken" });

    const role = await prisma.role.findUnique({ where: { code: roleCode } });
    if (!role) return reply.code(400).send({ error: `Role '${roleCode}' not found in database` });

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        username,
        fullName,
        passwordHash,
        status: "ACTIVE",
        userRoles: {
          create: [{
            roleId: role.id,
            branchId: branchId ? BigInt(branchId) : null,
          }],
        },
      },
      select: {
        id: true, username: true, fullName: true, status: true,
        userRoles: {
          include: {
            role: { select: { code: true } },
            branch: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });
    return toJson({ user });
  });

  // Change a user's password
  app.patch("/:id/password", { preHandler: requireAuth }, async (req: any, reply) => {
    assertAuth(req);
    const blocked = ownerOnly(req, reply); if (blocked) return blocked;

    const parsed = PasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Password must be at least 4 characters" });

    await prisma.user.update({
      where: { id: BigInt(req.params.id) },
      data: { passwordHash: await hashPassword(parsed.data.password) },
    });
    return { ok: true };
  });

  // Deactivate a user (soft — sets status=INACTIVE so they can no longer log in)
  app.patch("/:id/deactivate", { preHandler: requireAuth }, async (req: any, reply) => {
    assertAuth(req);
    const blocked = ownerOnly(req, reply); if (blocked) return blocked;
    if (req.auth.sub === req.params.id) return reply.code(400).send({ error: "Cannot deactivate your own account" });

    await prisma.user.update({ where: { id: BigInt(req.params.id) }, data: { status: "INACTIVE" } });
    return { ok: true };
  });

  // Re-activate a deactivated user
  app.patch("/:id/activate", { preHandler: requireAuth }, async (req: any, reply) => {
    assertAuth(req);
    const blocked = ownerOnly(req, reply); if (blocked) return blocked;

    await prisma.user.update({ where: { id: BigInt(req.params.id) }, data: { status: "ACTIVE" } });
    return { ok: true };
  });
}
