// Phase 4 smoke test: assistant status, tool schema validity, conversation persistence.
// Live chat round-trip is exercised only when ANTHROPIC_API_KEY is set.

import { readFileSync } from "node:fs";

const BASE = "http://localhost:4000/api/v1";
let TOKEN = "";

async function req(method, path, body, opts = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN && !opts.noAuth ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
let n = 0;
const step = (label, status, summary) => {
  n++;
  const ok = status >= 200 && status < 300;
  console.log(`${ok ? "✓" : "✗"} [${String(status).padStart(3)}] step ${String(n).padStart(2)} — ${label}${summary ? "  " + summary : ""}`);
};
const expect = (cond, msg) => { if (!cond) { console.error("   ASSERT FAILED:", msg); process.exitCode = 1; } };

// Detect whether the API has an OpenAI key configured
const env = readFileSync(".env", "utf8");
const m = env.match(/^OPENAI_API_KEY=(.*)$/m);
const HAS_KEY = !!(m && m[1].trim() && !m[1].includes("replace"));

(async () => {
  const login = await req("POST", "/auth/login", { username: "admin", password: "ChangeMe!2026" }, { noAuth: true });
  step("login", login.status);
  TOKEN = login.body.accessToken;

  // 1. /ai/status — should always work, reports configured: true|false
  const status = await req("GET", "/ai/status");
  step("ai status", status.status, `configured=${status.body?.configured}`);
  expect(typeof status.body?.configured === "boolean", "status.configured should be boolean");

  // 2. /ai/conversations — empty for a fresh user
  const convs0 = await req("GET", "/ai/conversations");
  step("list conversations", convs0.status, `count=${convs0.body?.conversations?.length}`);

  if (!HAS_KEY) {
    // 3a. Without key → /ai/chat returns 503 with the helpful message
    const noKey = await req("POST", "/ai/chat", { message: "test" });
    step("chat without key returns 503", noKey.status, `error=${noKey.body?.error}`);
    expect(noKey.status === 503, `expected 503, got ${noKey.status}`);
    console.log("\nNote: OPENAI_API_KEY is not set in .env. The live chat round-trip was skipped.");
    console.log("To exercise the full assistant: add OPENAI_API_KEY=sk-… to .env, restart the API, rerun.");
  } else {
    // 3b. With key → ask a question that should trigger get_alert_summary
    console.log("\n  → Live chat test against OpenAI API…");
    const chat1 = await req("POST", "/ai/chat", { message: "Are there any open alerts I should know about?" });
    step("live chat: 'are there any open alerts'", chat1.status, `iters=${chat1.body?.iterations}, tools=${chat1.body?.toolCallsMade?.map(t=>t.name).join(',')}`);
    console.log(`     reply: ${chat1.body?.reply?.slice(0, 200)}...`);
    expect(chat1.body?.toolCallsMade?.length > 0, "expected at least one tool call");

    // 4. Continue the conversation — exercises history rebuild
    const conversationId = chat1.body?.conversationId;
    const chat2 = await req("POST", "/ai/chat", { conversationId, message: "What's the P&L for Branch 1 this week?" });
    step("live chat: P&L follow-up (same conversation)", chat2.status, `tools=${chat2.body?.toolCallsMade?.map(t=>t.name).join(',')}`);
    console.log(`     reply: ${chat2.body?.reply?.slice(0, 200)}...`);
    expect(chat2.body?.conversationId === conversationId, "conversation id should be reused");

    // 5. Conversation now has multiple messages, including tool messages
    const conv = await req("GET", `/ai/conversations/${conversationId}`);
    step("load full conversation", conv.status, `messages=${conv.body?.conversation?.messages?.length}`);
    expect(conv.body?.conversation?.messages?.length >= 4, "expected ≥4 messages (2 user + 2 assistant + tool calls)");

    // 6. Prompt cache should hit on the 2nd request — verify in usage
    const cacheRead2 = chat2.body?.usage?.cacheReadInputTokens ?? 0;
    step("prompt cache hit on 2nd call", 200, `cacheReadInputTokens=${cacheRead2}`);
    expect(cacheRead2 > 0, `expected cache hit on 2nd call, got cacheReadInputTokens=${cacheRead2}`);
  }

  console.log(process.exitCode ? "\nSOME ASSERTIONS FAILED" : "\nAll Phase 4 assertions passed ✓");
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
