import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "@sjc/db";
import { hashPassword, isLegacyHash, verifyPassword } from "../lib/password.js";
import { loadUserRoles, requireAuth } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";

const LoginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const RefreshBody = z.object({
  refreshToken: z.string().min(1),
});

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/login", async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body" });

    const user = await prisma.user.findUnique({
      where: { username: parsed.data.username },
    });
    if (!user || user.status !== "ACTIVE" || user.deletedAt) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "Invalid credentials" });

    // Transparently upgrade legacy dev$ hashes to bcrypt on first successful login.
    if (isLegacyHash(user.passwordHash)) {
      const newHash = await hashPassword(parsed.data.password);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    }

    const roles = await loadUserRoles(user.id);

    // Create a refresh session so we can revoke at logout.
    const refreshTokenJti = randomUUID();
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken: refreshTokenJti,
        deviceInfo: req.headers["user-agent"] ?? null,
        ip: req.ip,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });

    const accessToken = app.signAccessToken({
      sub: user.id.toString(),
      username: user.username,
      roles,
    });
    const refreshToken = app.signRefreshToken({
      sub: user.id.toString(),
      sid: session.id.toString(),
    });

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await writeAudit({ req, userId: user.id, action: "user.login", entityType: "User", entityId: user.id });

    return toJson({
      user: {
        id: user.id.toString(),
        username: user.username,
        fullName: user.fullName,
        roles,
      },
      accessToken,
      refreshToken,
      expiresIn: 60 * 60,
    });
  });

  app.post("/refresh", async (req, reply) => {
    const parsed = RefreshBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body" });

    let claims;
    try {
      claims = app.verifyRefreshToken(parsed.data.refreshToken);
    } catch {
      return reply.code(401).send({ error: "Invalid refresh token" });
    }
    if (claims.type !== "refresh") return reply.code(401).send({ error: "Wrong token type" });

    const session = await prisma.session.findUnique({ where: { id: BigInt(claims.sid) } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return reply.code(401).send({ error: "Session revoked or expired" });
    }
    const user = await prisma.user.findUnique({ where: { id: BigInt(claims.sub) } });
    if (!user || user.status !== "ACTIVE" || user.deletedAt) {
      return reply.code(401).send({ error: "User not active" });
    }

    const roles = await loadUserRoles(user.id);
    const accessToken = app.signAccessToken({
      sub: user.id.toString(),
      username: user.username,
      roles,
    });
    return { accessToken, expiresIn: 60 * 60 };
  });

  app.post("/logout", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    // Revoke all sessions for the user. Cheap and safe — log them in again to get a new one.
    await prisma.session.updateMany({
      where: { userId: BigInt(req.auth.sub), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit({ req, action: "user.logout", entityType: "User", entityId: req.auth.sub });
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    const user = await prisma.user.findUnique({
      where: { id: BigInt(req.auth.sub) },
      select: { id: true, username: true, fullName: true, email: true, phone: true, lastLoginAt: true },
    });
    return toJson({ user, roles: req.auth.roles });
  });
}
