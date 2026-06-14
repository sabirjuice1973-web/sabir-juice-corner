import { useEffect, useRef, useState } from "react";
import { api } from "../api";

type Conversation = { id: string; title: string | null; startedAt: string; messageCount: number };
type Message = {
  id: string;
  role: "USER" | "ASSISTANT" | "TOOL" | "SYSTEM";
  content: string;
  toolCalls: { id: string; name: string; input: any }[] | null;
  createdAt: string;
};

type ChatResponse = {
  conversationId: string;
  reply: string;
  toolCallsMade: { name: string; input: any }[];
  iterations: number;
  usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number };
};

const SAMPLE_QUESTIONS = [
  "Which branch had the highest variance this week?",
  "Show me the top 5 most profitable items in the last month.",
  "What's the P&L for Branch 1 this week?",
  "Are there any low-stock items right now?",
  "Which suppliers do we owe the most?",
];

export function Assistant() {
  const [status, setStatus] = useState<{ configured: boolean; message: string } | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<ChatResponse["usage"] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ configured: boolean; message: string }>("GET", "/ai/status").then(setStatus).catch(() => {});
    refreshConversations();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function refreshConversations() {
    const r = await api<{ conversations: Conversation[] }>("GET", "/ai/conversations");
    setConversations(r.conversations);
  }

  async function loadConversation(id: string) {
    const r = await api<{ conversation: { messages: Message[] } }>("GET", `/ai/conversations/${id}`);
    setActiveId(id);
    setMessages(r.conversation.messages);
    setError(null);
  }

  function newChat() {
    setActiveId(null);
    setMessages([]);
    setLastUsage(null);
    setError(null);
  }

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setError(null);
    setBusy(true);

    const userMessage: Message = {
      id: `local-${Date.now()}`,
      role: "USER",
      content: text,
      toolCalls: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, userMessage]);
    setInput("");

    try {
      const r = await api<ChatResponse>("POST", "/ai/chat", { conversationId: activeId, message: text });
      setActiveId(r.conversationId);
      setLastUsage(r.usage);

      // Reload the full conversation so tool-use rows render in order
      const conv = await api<{ conversation: { messages: Message[] } }>("GET", `/ai/conversations/${r.conversationId}`);
      setMessages(conv.conversation.messages);
      refreshConversations();
    } catch (e: any) {
      setError(e.body?.error || e.message);
      // Roll back the optimistic user message on failure
      setMessages((m) => m.filter((x) => x.id !== userMessage.id));
    } finally {
      setBusy(false);
    }
  }

  if (status && !status.configured) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Owner Assistant</h1>
        <div className="card p-6 border-l-4 border-amber-400 bg-amber-50">
          <div className="font-medium text-amber-900 mb-1">Assistant is offline</div>
          <div className="text-sm text-amber-800 mb-3">{status.message}</div>
          <ol className="text-sm text-slate-700 list-decimal pl-5 space-y-1">
            <li>Get an API key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="underline text-sjc-700">platform.openai.com/api-keys</a></li>
            <li>Add <code className="bg-slate-200 px-1.5 py-0.5 rounded">OPENAI_API_KEY=sk-…</code> to the project's <code>.env</code></li>
            <li>Restart the API (it'll auto-reload via tsx watch)</li>
            <li>Refresh this page</li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-[calc(100vh-3rem)]">
      {/* Sidebar — conversation list */}
      <aside className="w-64 shrink-0 flex flex-col gap-2">
        <button className="btn-primary w-full" onClick={newChat}>+ New chat</button>
        <div className="card flex-1 overflow-auto p-2">
          {conversations.length === 0 && <div className="text-xs text-slate-400 text-center py-4">No previous chats yet.</div>}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => loadConversation(c.id)}
              className={`w-full text-left px-2 py-1.5 rounded text-sm truncate ${activeId === c.id ? "bg-sjc-100 text-sjc-800 font-medium" : "hover:bg-slate-100"}`}
              title={c.title ?? ""}
            >
              {c.title || "(untitled)"}
              <div className="text-[10px] text-slate-400">{new Date(c.startedAt).toLocaleDateString()} · {c.messageCount} msgs</div>
            </button>
          ))}
        </div>
      </aside>

      {/* Main panel */}
      <div className="flex-1 flex flex-col gap-3">
        <div className="card flex-1 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h1 className="font-semibold">Owner Assistant</h1>
            {lastUsage && (
              <div className="text-xs text-slate-400 font-mono">
                in:{lastUsage.inputTokens} out:{lastUsage.outputTokens}
                {lastUsage.cacheReadInputTokens > 0 && <span className="text-emerald-600"> · cached:{lastUsage.cacheReadInputTokens}</span>}
              </div>
            )}
          </div>

          <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-center py-10">
                <div className="text-slate-500 mb-4">Ask anything about your business. Try:</div>
                <div className="flex flex-col gap-2 max-w-md mx-auto">
                  {SAMPLE_QUESTIONS.map((q) => (
                    <button key={q} onClick={() => send(q)} className="btn-secondary text-sm py-2 text-left">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => <MessageRow key={m.id} message={m} />)}
            {busy && (
              <div className="text-sm text-slate-400 italic flex items-center gap-2">
                <span className="inline-block h-2 w-2 bg-sjc-500 rounded-full animate-pulse"></span>
                Thinking…
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="border-t border-slate-200 p-3 flex gap-2"
          >
            <input
              className="input flex-1"
              placeholder="Ask about variance, P&L, profitability, stock, alerts…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
              autoFocus
            />
            <button type="submit" className="btn-primary" disabled={busy || !input.trim()}>Send</button>
          </form>
          {error && <div className="px-4 pb-3 text-sm text-red-600">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  if (message.role === "TOOL") {
    let payload: any = {};
    try { payload = JSON.parse(message.content); } catch {}
    return (
      <div className="text-xs text-slate-400 font-mono pl-4">
        → tool: <span className="text-slate-600">{payload.name}</span> returned {String(payload.content ?? "").length} chars
      </div>
    );
  }
  if (message.role === "ASSISTANT") {
    return (
      <div className="flex gap-3">
        <div className="shrink-0 h-8 w-8 rounded-full bg-sjc-600 text-white flex items-center justify-center text-xs font-bold">SJC</div>
        <div className="flex-1 space-y-2">
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="text-xs text-slate-500">
              {message.toolCalls.map((tc, i) => (
                <div key={i} className="font-mono">→ {tc.name}({JSON.stringify(tc.input).slice(0, 80)}{JSON.stringify(tc.input).length > 80 ? "…" : ""})</div>
              ))}
            </div>
          )}
          {message.content && <div className="prose prose-sm max-w-none whitespace-pre-wrap">{message.content}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3 justify-end">
      <div className="bg-sjc-100 text-sjc-900 rounded-lg px-3 py-2 max-w-2xl whitespace-pre-wrap">{message.content}</div>
    </div>
  );
}
