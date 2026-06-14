import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { toJson } from "../lib/serialize.js";
import { chat, isAiConfigured } from "../services/aiAssistant.js";

const ChatBody = z.object({
  conversationId: z.coerce.bigint().optional(),
  message: z.string().min(1).max(4000),
});

export async function registerAiRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** GET /ai/status — does the assistant have an API key configured? */
  app.get("/status", async () => {
    return {
      configured: isAiConfigured(),
      message: isAiConfigured()
        ? "AI assistant is online."
        : "ANTHROPIC_API_KEY is not set in .env — the assistant is offline. Get a key at console.anthropic.com.",
    };
  });

  /** POST /ai/chat — send a message; returns the assistant's reply.
   *  Permission: FIN_VIEW_PROFIT because tools expose P&L / sales / variance. */
  app.post("/chat", { preHandler: requirePermission("FIN_VIEW_PROFIT", "ADMIN_AUDIT_VIEW") }, async (req, reply) => {
    if (!isAiConfigured()) {
      return reply.code(503).send({
        error: "AI assistant not configured",
        details: "ANTHROPIC_API_KEY missing in .env. Set it and restart the API.",
      });
    }
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    try {
      const r = await chat({
        userId: BigInt(req.auth!.sub),
        conversationId: parsed.data.conversationId,
        message: parsed.data.message,
      });
      return toJson(r);
    } catch (e: any) {
      req.log.error({ err: e }, "ai chat failed");
      return reply.code(500).send({ error: e.message ?? "Assistant call failed" });
    }
  });

  /** GET /ai/conversations — list this user's conversations */
  app.get("/conversations", async (req) => {
    const list = await prisma.aiConversation.findMany({
      where: { userId: BigInt(req.auth!.sub) },
      orderBy: { startedAt: "desc" },
      take: 30,
      select: { id: true, title: true, startedAt: true, endedAt: true, _count: { select: { messages: true } } },
    });
    return toJson({
      conversations: list.map((c) => ({
        id: c.id,
        title: c.title,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        messageCount: c._count.messages,
      })),
    });
  });

  /** GET /ai/conversations/:id — one conversation with all its messages */
  app.get("/conversations/:id", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const conv = await prisma.aiConversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!conv) return reply.code(404).send({ error: "Conversation not found" });
    if (conv.userId !== BigInt(req.auth!.sub)) {
      const isOwner = req.auth!.roles.some((r) => r.code === "OWNER");
      if (!isOwner) return reply.code(403).send({ error: "Not your conversation" });
    }
    return toJson({
      conversation: {
        id: conv.id,
        title: conv.title,
        startedAt: conv.startedAt,
        messages: conv.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
          createdAt: m.createdAt,
        })),
      },
    });
  });
}
