import OpenAI from "openai";
import { prisma } from "@sjc/db";
import { env } from "../env.js";
import { executeTool, TOOL_DEFINITIONS } from "./aiTools.js";

/**
 * Owner AI assistant — multi-turn chat with function calling, persisted to
 * AiConversation/AiMessage.
 *
 * Architecture:
 *   • OpenAI Chat Completions API + function calling.
 *   • Manual tool-call loop (not the assistants API) so we can persist every
 *     step and gate iterations on safety bounds.
 *   • Prompt caching is **automatic** on OpenAI — the API matches the longest
 *     identical prefix across recent requests and bills cached input tokens
 *     at ~50% off. We just keep the system prompt and tool defs stable.
 *   • Default model: gpt-4o-mini (cheap and good at function calling).
 *     Configure via OPENAI_MODEL in .env.
 *
 * Schema impact: every chat turn writes rows into AiConversation/AiMessage.
 * Tool calls and results are stored as separate messages so the audit trail
 * matches the wire conversation 1:1.
 */

const MAX_ITERATIONS = 8;     // safety bound on tool-call loop
const MAX_TOKENS = 4096;       // assistant reply ceiling — generous for analytical summaries

const SYSTEM_PROMPT = `You are the **Sabir Juice Corner** business assistant — a senior analyst helping the owner make decisions across the company's juice operation in Multan, Pakistan.

## Business context

- Multi-branch juice & shake business founded 1973 by the owner's late father, Sheikh Sabir Ali.
- Currently runs a central kitchen plus retail branches. Fruit is purchased raw, processed into pulp/shopers at the central kitchen, transferred to branches, and sold via fast counter-service POS.
- All money is in **PKR** (Pakistani Rupees). Quantities use kg for raw, *shopers* for processed pulp (a shoper = one plastic bag of pulp, typically ~12 glasses), and glasses for finished drinks.
- Branches are referenced by ID: 1 = Central Kitchen (no retail sales), 2 = Branch 1, 3 = Branch 2, 4 = Branch 3.

## Your role

- Answer the owner's questions using the read-only tools available to you. Never invent numbers — always call a tool if a number is involved.
- Be concise and direct. The owner is busy; lead with the answer, then the supporting detail.
- Surface signals that matter: leakage (positive variance, negative stock), declining margins, suspicious cashier behaviour, supplier rate jumps.
- Use Pakistani business language naturally: "PKR 3,500" or "Rs. 3,500", "shoper" not "bag", "branch" not "store".
- Today's date for date-relative questions: use the system clock. If the user says "this week", interpret as the last 7 days ending today.

## How to use tools

- Always call \`list_branches\` first if the user names a branch and you don't know its ID. Same for \`list_suppliers\`.
- For "highest variance this week" type questions: call \`get_variance_report\` for each branch (or just the user-named one), then compare.
- For "most profitable items": \`get_item_profitability\` with a sensible \`topN\`.
- When stock shows negative, that means *more was sold than was logged in* — this is the primary leakage signal. Always call it out.
- If a tool returns no data for the period, say so honestly. Don't guess.

## Output style

- Lead with the bottom-line answer in one sentence.
- Follow with the supporting numbers as a short list or sentence.
- For comparisons, include the second-place item so the owner can judge the gap.
- For variance/leakage, always say whether the variance is significant (>10% of received) or within noise.
- Do NOT dump raw tool output. Synthesize.`;

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

export function isAiConfigured(): boolean {
  return !!env.OPENAI_API_KEY;
}

/**
 * Recursively turn BigInts/Dates into JSON-friendly values. Tool results
 * pass through here before being shipped to the model.
 */
function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

export type ChatRequest = {
  conversationId?: bigint | null;
  userId: bigint;
  message: string;
};

export type ChatResponse = {
  conversationId: string;
  reply: string;
  toolCallsMade: { name: string; input: unknown }[];
  iterations: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;   // kept in the response shape for API parity; OpenAI doesn't expose a separate "creation" number
    cacheReadInputTokens: number;       // OpenAI: prompt_tokens_details.cached_tokens
  };
};

export async function chat(args: ChatRequest): Promise<ChatResponse> {
  const c = getClient();
  if (!c) {
    throw new Error("OPENAI_API_KEY is not configured. Set it in .env to enable the assistant.");
  }

  // ─── Load or create conversation ──────────────────────────────────────
  let conversation = args.conversationId
    ? await prisma.aiConversation.findUnique({
        where: { id: args.conversationId },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      })
    : null;
  if (!conversation) {
    conversation = await prisma.aiConversation.create({
      data: {
        userId: args.userId,
        title: args.message.slice(0, 80),
      },
      include: { messages: true },
    });
  }
  if (conversation.userId !== args.userId) {
    throw new Error("Conversation does not belong to this user");
  }

  // ─── Rebuild wire history from persisted messages ─────────────────────
  // System prompt is the first message in OpenAI's format. Each subsequent
  // AiMessage row maps to one OpenAI message; tool calls and their results
  // are stored separately so the wire history is faithful.
  const wireMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const m of conversation.messages) {
    if (m.role === "USER") {
      wireMessages.push({ role: "user", content: m.content });
    } else if (m.role === "ASSISTANT") {
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: m.content || null,
      };
      if (m.toolCalls && Array.isArray(m.toolCalls)) {
        const calls = m.toolCalls as any[];
        if (calls.length > 0) {
          msg.tool_calls = calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }));
        }
      }
      wireMessages.push(msg);
    } else if (m.role === "TOOL") {
      const payload = JSON.parse(m.content);
      wireMessages.push({
        role: "tool",
        tool_call_id: payload.tool_use_id,
        content: payload.content,
      });
    }
  }

  // ─── Append the new user message ─────────────────────────────────────
  wireMessages.push({ role: "user", content: args.message });
  await prisma.aiMessage.create({
    data: {
      conversationId: conversation.id,
      role: "USER",
      content: args.message,
    },
  });

  // ─── Manual function-calling loop ────────────────────────────────────
  const toolCallsMade: { name: string; input: unknown }[] = [];
  let iterations = 0;
  let finalText = "";
  const totals = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await c.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: wireMessages,
      tools: TOOL_DEFINITIONS,
      max_tokens: MAX_TOKENS,
    });

    const usage = response.usage;
    if (usage) {
      totals.inputTokens         += usage.prompt_tokens;
      totals.outputTokens        += usage.completion_tokens;
      totals.cacheReadInputTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
    }

    const choice = response.choices[0];
    const msg = choice.message;
    const turnText = msg.content ?? "";
    const toolCalls = msg.tool_calls ?? [];

    // Persist the assistant turn (text + tool_calls shape) as a single row
    await prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: turnText,
        toolCalls: toolCalls.length
          ? (toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              // store parsed input for readability; we re-stringify on rebuild
              input: safeJsonParse(tc.function.arguments),
            })) as any)
          : undefined,
        tokensUsed: usage?.total_tokens,
      },
    });

    // Append the assistant turn to wire history verbatim
    wireMessages.push(msg);

    // Handle finish reasons
    if (choice.finish_reason === "stop") {
      finalText = turnText;
      break;
    }
    if (choice.finish_reason === "tool_calls") {
      // Execute every tool call from this turn, then loop
      for (const tc of toolCalls) {
        const input = safeJsonParse(tc.function.arguments);
        toolCallsMade.push({ name: tc.function.name, input });
        let resultContent: string;
        try {
          const result = await executeTool(tc.function.name, input);
          resultContent = safeJsonStringify(result);
        } catch (e: any) {
          resultContent = safeJsonStringify({ error: e.message ?? "tool execution failed" });
        }
        wireMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultContent,
        });
        // Persist as a TOOL message so the next chat() rebuilds wire history exactly
        await prisma.aiMessage.create({
          data: {
            conversationId: conversation.id,
            role: "TOOL",
            content: JSON.stringify({ tool_use_id: tc.id, name: tc.function.name, content: resultContent }),
          },
        });
      }
      continue;
    }
    if (choice.finish_reason === "length") {
      finalText = turnText + "\n\n(Response truncated — ask me to continue or narrow the question.)";
      break;
    }
    if (choice.finish_reason === "content_filter") {
      finalText = turnText || "I can't help with that.";
      break;
    }
    finalText = turnText;
    break;
  }

  if (iterations >= MAX_ITERATIONS && !finalText) {
    finalText = "I needed too many tool calls to answer that. Try narrowing the question.";
  }

  return {
    conversationId: conversation.id.toString(),
    reply: finalText,
    toolCallsMade,
    iterations,
    usage: totals,
  };
}

function safeJsonParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
