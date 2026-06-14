import jwt, { type SignOptions } from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../env.js";

export type AccessTokenPayload = {
  sub: string;          // user id
  username: string;
  roles: { code: string; branchId: string | null }[];
  type: "access";
};

export type RefreshTokenPayload = {
  sub: string;
  sid: string;          // session id
  type: "refresh";
};

declare module "fastify" {
  interface FastifyInstance {
    signAccessToken(payload: Omit<AccessTokenPayload, "type">): string;
    signRefreshToken(payload: Omit<RefreshTokenPayload, "type">): string;
    verifyAccessToken(token: string): AccessTokenPayload;
    verifyRefreshToken(token: string): RefreshTokenPayload;
  }
  interface FastifyRequest {
    // Custom field that holds our verified access-token payload.
    // We use `auth` rather than `user` because @fastify/jwt already
    // declares `user` with a different (generic) shape.
    auth?: AccessTokenPayload;
  }
}

export async function registerJwt(app: FastifyInstance) {
  // Two namespaces so an access token can never be used as a refresh token and vice versa.
  await app.register(jwt, {
    secret: env.JWT_ACCESS_SECRET,
    namespace: "access",
    sign:   { expiresIn: env.JWT_ACCESS_TTL  } as SignOptions,
  });
  await app.register(jwt, {
    secret: env.JWT_REFRESH_SECRET,
    namespace: "refresh",
    sign:   { expiresIn: env.JWT_REFRESH_TTL } as SignOptions,
  });

  // With `namespace: "access"`, the JWT instance is exposed at `app.jwt.access`.
  const access = (app as any).jwt.access;
  const refresh = (app as any).jwt.refresh;

  app.decorate("signAccessToken", (payload: Omit<AccessTokenPayload, "type">) =>
    access.sign({ ...payload, type: "access" }),
  );
  app.decorate("signRefreshToken", (payload: Omit<RefreshTokenPayload, "type">) =>
    refresh.sign({ ...payload, type: "refresh" }),
  );
  app.decorate("verifyAccessToken", (token: string) =>
    access.verify(token) as AccessTokenPayload,
  );
  app.decorate("verifyRefreshToken", (token: string) =>
    refresh.verify(token) as RefreshTokenPayload,
  );
}

export function extractBearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}
