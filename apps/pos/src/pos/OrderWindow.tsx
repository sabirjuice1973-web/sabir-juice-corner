import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Item } from "../api";
import { type Draft, type DraftLine, addDraftLine, adjustDraftLineQty, displayItemName, draftLineKey, draftTotal, removeDraftLine } from "./posState";

/**
 * Mix preview — built when the cashier types "A+B" in the code field.
 * Holds the two resolved items, the alphabetically-ordered names, and the
 * averaged price. Kept separate from the regular `preview` so the commit
 * logic can branch cleanly.
 *
 * Pricing rule for mixes: raw average = sum(price) / N. The result is then
 * rounded UP to the next multiple of 10 (per owner's policy — keeps cashier
 * change-making simple). E.g. 426.67 → 430, 599 → 600, 1021 → 1030.
 * A raw average that's already a multiple of 10 (e.g. 320) stays unchanged.
 */
type MixPreview = {
  components: Item[];           // 2-5 components
  displayName: string;          // "Banana+Peach" or "Banana+Mango+Peach"
  size: "MEDIUM" | "JUMBO";     // all must match (validated)
  rawAverage: number;           // sum(price) / N — shown for transparency
  averagedPrice: number;        // rawAverage rounded UP to next multiple of 10
};

const MAX_MIX_COMPONENTS = 5;

/** Round UP to next multiple of 10. Already-a-multiple-of-10 values pass through. */
function roundUpTo10(n: number): number {
  return Math.ceil(n / 10) * 10;
}

/**
 * The Order Window — modal where the cashier assembles a draft.
 *
 * Keystroke flow (cashier's fingers, in order):
 *   Spacebar (outside any input)      → opens the window. qty input is focused.
 *   2 → ENTER                          → quantity = 2, focus moves to code input
 *   45 → (live preview shows Mango)
 *   ENTER                              → ARMS the preview (visual highlight +
 *                                        "Press ENTER again" hint). Doesn't commit.
 *   ENTER (second time)                → commits the line; qty resets to 1, focus
 *                                        returns to the qty input (selected, so
 *                                        cashier can type a new qty immediately
 *                                        or press ENTER to keep qty=1).
 *                                        Any typing between the two ENTERs cancels
 *                                        the armed state — the second ENTER would
 *                                        re-arm against whatever now matches.
 *   Ctrl+1 … Ctrl+7                    → push draft to corresponding box (1–7)
 *   Esc                                → close window without losing draft
 *
 * Closing without committing is intentional: the cashier might pause, walk away,
 * and come back. The draft sits in state until pushed to a box or explicitly
 * cleared.
 */

type Props = {
  draft: Draft;
  onDraftChange: (d: Draft) => void;
  onClose: () => void;
  onClear: () => void;
  // When set, the window operates in EDIT mode: header shows the order being
  // edited, and the footer's total reads "Updated Total" instead of "Draft Total".
  // openedAt is the order's ORIGINAL punch time — set once at creation (push
  // time, not whenever this window happens to be opened) and never changes,
  // so it must be shown as-is even when editing an order from days ago.
  editTarget?: { orderNo: string | null; serverId: string; openedAt: string } | null;
  // The order number the NEXT order pushed (for the current business date)
  // will receive — shown as a live "Next Order #N" badge. null while loading.
  nextOrderSeq?: number | null;
};

export function OrderWindow({ draft, onDraftChange, onClose, onClear, editTarget, nextOrderSeq }: Props) {
  const qtyRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [qtyInput, setQtyInput] = useState("1");
  const [codeInput, setCodeInput] = useState("");
  const [preview, setPreview] = useState<Item | null>(null);
  const [mixPreview, setMixPreview] = useState<MixPreview | null>(null);
  // Cashier override for a mix's auto-averaged price — some combinations
  // (e.g. flavoring powder added on top rather than blended in equal parts)
  // genuinely don't fit a straight average. null = use the computed average.
  // Single-item lines have no equivalent — their price always comes straight
  // from the catalog.
  const [mixPriceOverride, setMixPriceOverride] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Item[]>([]);
  const [armed, setArmed] = useState(false);

  // Drag state: null = default centered position; {x,y} = dragged to coords
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<{ mouseX: number; mouseY: number; cardX: number; cardY: number } | null>(null);

  function onHeaderMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = cardRef.current!.getBoundingClientRect();
    dragOrigin.current = { mouseX: e.clientX, mouseY: e.clientY, cardX: rect.left, cardY: rect.top };
    setDragging(true);

    function onMove(e: MouseEvent) {
      if (!dragOrigin.current) return;
      const x = dragOrigin.current.cardX + (e.clientX - dragOrigin.current.mouseX);
      const y = dragOrigin.current.cardY + (e.clientY - dragOrigin.current.mouseY);
      // Clamp so the card can't be dragged fully off-screen
      const cardW = cardRef.current?.offsetWidth ?? 600;
      const cardH = cardRef.current?.offsetHeight ?? 400;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth  - cardW,  x)),
        y: Math.max(0, Math.min(window.innerHeight - cardH, y)),
      });
    }
    function onUp() {
      dragOrigin.current = null;
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Focus qty input on mount
  useEffect(() => { qtyRef.current?.focus(); qtyRef.current?.select(); }, []);

  // Live preview as the cashier types code or name
  useEffect(() => {
    const v = codeInput.trim();
    setPreview(null);
    setMixPreview(null);
    setMixPriceOverride(null);
    setPreviewErr(null);
    setSearchResults([]);
    // Code input changed → previous arming is invalid (it referred to a
    // different code). Force the cashier to confirm the new preview.
    setArmed(false);
    if (!v) return;

    // ─── Mixed-items syntax: "codeA+codeB", up to 5 components ──────────
    // "7+41"           → 2-way mix
    // "7+41+5"         → 3-way mix
    // "7+41+5+11+2"    → 5-way mix (max)
    // All codes must be valid items, all same size (MEDIUM-with-MEDIUM, JUMBO-with-JUMBO),
    // none NA, and all distinct. Resulting line shows "A+B+C Size" at the averaged price.
    const mixMatch = /^\s*\d+(?:\s*\+\s*\d+)+\s*$/.exec(v);
    if (mixMatch) {
      const codes = v.split("+").map((s) => parseInt(s.trim(), 10));
      if (codes.length > MAX_MIX_COMPONENTS) {
        setPreviewErr(`Mix can have at most ${MAX_MIX_COMPONENTS} items (got ${codes.length})`);
        return;
      }
      if (new Set(codes).size !== codes.length) {
        setPreviewErr(`Mix needs DIFFERENT codes (duplicates: ${codes.join("+")})`);
        return;
      }
      const ctrl = new AbortController();
      Promise.all(codes.map((c) => api.itemByCode(c)))
        .then((items) => {
          if (ctrl.signal.aborted) return;
          const sizes = new Set(items.map((it) => it.size));
          if (sizes.size > 1) {
            setPreviewErr(`Can't mix different sizes: ${items.map((it) => `${it.name} (${it.size})`).join(", ")}`);
            return;
          }
          const size = items[0].size;
          if (size === "NA") {
            setPreviewErr(`Mix only supported for sized items (MEDIUM/JUMBO)`);
            return;
          }
          // Sort alphabetically so display is deterministic regardless of typing order
          const sorted = [...items].sort((x, y) => x.name.localeCompare(y.name));
          const rawAverage = sorted.reduce((s, it) => s + Number(it.price), 0) / sorted.length;
          setMixPreview({
            components: sorted,
            displayName: sorted.map((it) => it.name).join("+"),
            size: size as "MEDIUM" | "JUMBO",
            rawAverage,
            averagedPrice: roundUpTo10(rawAverage),
          });
        })
        .catch((e: any) => {
          if (ctrl.signal.aborted) return;
          setPreviewErr(e.status === 404 ? `One of the codes ${codes.join(", ")} doesn't exist` : (e.message || "Lookup failed"));
        });
      return () => ctrl.abort();
    }

    // ─── Numeric → exact item-code lookup ───────────────────────────────
    if (/^\d+$/.test(v)) {
      const code = parseInt(v, 10);
      const ctrl = new AbortController();
      api.itemByCode(code)
        .then((item) => { if (!ctrl.signal.aborted) setPreview(item); })
        .catch((e: any) => {
          if (ctrl.signal.aborted) return;
          setPreviewErr(e.status === 404 ? `No item with code ${code}` : (e.message || "Lookup failed"));
        });
      return () => ctrl.abort();
    }

    // ─── Non-numeric → name search ──────────────────────────────────────
    const t = setTimeout(async () => {
      try {
        const r = await api.searchItems(v, 8);
        setSearchResults(r.items);
        setPreview(r.items[0] ?? null);
        setPreviewErr(r.items.length ? null : `No items matching "${v}"`);
      } catch {
        setSearchResults([]);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [codeInput]);

  const commitLine = useCallback(() => {
    const rawQty = parseFloat(qtyInput);
    if (!rawQty || rawQty === 0) return;
    const isSubtract = rawQty < 0;
    const absQty = Math.max(0.001, Math.abs(rawQty));

    let line: DraftLine | null = null;
    if (mixPreview) {
      const overridden = mixPriceOverride !== null ? parseFloat(mixPriceOverride) : NaN;
      const effectivePrice = Number.isFinite(overridden) && overridden > 0 ? overridden : mixPreview.averagedPrice;
      const [first] = mixPreview.components;
      line = {
        itemId: first.id,
        itemCode: first.itemCode,
        name: mixPreview.displayName + ` ${mixPreview.size === "MEDIUM" ? "Medium" : "Jumbo"}`,
        size: mixPreview.size,
        qty: absQty,
        unitPrice: effectivePrice.toFixed(2),
        isMix: true,
        mixOf: mixPreview.components.map((c) => c.itemCode),
      };
    } else if (preview) {
      line = {
        itemId: preview.id,
        itemCode: preview.itemCode,
        name: preview.name,
        size: preview.size,
        qty: absQty,
        unitPrice: preview.price ?? "0",
      };
    }
    if (!line) return;

    if (isSubtract) {
      onDraftChange(adjustDraftLineQty(draft, draftLineKey(line), -absQty));
    } else {
      onDraftChange(addDraftLine(draft, line));
    }
    // Reset to fresh-window state: blank code, qty=1 (selected), focus on qty.
    setCodeInput("");
    setQtyInput("1");
    setPreview(null);
    setMixPreview(null);
    setMixPriceOverride(null);
    setPreviewErr(null);
    setSearchResults([]);
    setTimeout(() => {
      qtyRef.current?.focus();
      qtyRef.current?.select();
    }, 0);
  }, [preview, mixPreview, mixPriceOverride, qtyInput, draft, onDraftChange]);

  // Per-input ENTER handlers
  function onQtyKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      codeRef.current?.focus();
      codeRef.current?.select();
    }
  }
  function onCodeKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      // Two-step commit: first ENTER on a valid preview arms the row (visual
      // confirmation appears, "press ENTER again to add" hint shown). Second
      // ENTER actually adds it to the draft. Mirrors how a debit-card PIN pad
      // makes you confirm before charging — small pause, big safety.
      const hasPreview = !!preview || !!mixPreview;
      if (!hasPreview) return;            // nothing to commit yet — wait for typing/lookup
      if (!armed) {
        setArmed(true);
        return;
      }
      commitLine();                       // armed → commit, useEffect on clear input will re-arm to false
    }
  }

  const total = draftTotal(draft);
  const totalQty = draft.lines.reduce((s, li) => s + li.qty, 0);

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[500]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={cardRef}
        className={`absolute w-full max-w-3xl flex flex-col max-h-[90vh] rounded-2xl bg-white overflow-hidden ring-1 ring-black/5 shadow-2xl ${editTarget ? "ring-2 ring-accent-400" : ""} ${dragging ? "shadow-[0_25px_60px_-15px_rgba(0,0,0,0.45)]" : ""}`}
        style={pos
          ? { left: pos.x, top: pos.y }
          : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
        }
      >
        <div
          className={`px-5 py-3.5 flex items-center justify-between select-none ${editTarget ? "bg-gradient-to-r from-accent-600 to-accent-700" : "bg-gradient-to-r from-slate-800 to-slate-900"} ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
          onMouseDown={onHeaderMouseDown}
        >
          <div className="min-w-0">
            <div className="font-bold text-lg text-white flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${editTarget ? "bg-amber-300" : "bg-emerald-400"}`} />
              {editTarget ? (<>Editing order <span className="font-mono text-amber-200">{editTarget.orderNo ?? "(local)"}</span></>) : "Order Window"}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-white/60 mt-1">
              {editTarget ? (
                <>
                  <span>Edit items, then</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 font-mono text-[10px] border border-white/10">Ctrl+1</kbd>
                  <span className="text-white/30">–</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 font-mono text-[10px] border border-white/10">9</kbd>
                  <span>to move it to a box</span>
                </>
              ) : (
                <>
                  <span className="px-1.5 py-0.5 rounded bg-white/10 text-white/80 font-medium">Qty</span>
                  <span className="text-white/30">→</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 font-mono text-[10px] border border-white/10">ENTER</kbd>
                  <span className="text-white/30">→</span>
                  <span className="px-1.5 py-0.5 rounded bg-white/10 text-white/80 font-medium">Item code</span>
                  <span className="text-white/30">→</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 font-mono text-[10px] border border-white/10">ENTER</kbd>
                  <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 font-mono text-[10px] border border-white/10">ENTER</kbd>
                  <span className="text-white/30">→</span>
                  <kbd className="px-1.5 py-0.5 rounded bg-accent-500/90 text-white font-mono text-[10px]">Ctrl+1–9</kbd>
                  <span>push to box</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {!editTarget && nextOrderSeq != null && (
              <div className="text-right leading-tight rounded-lg bg-white/10 px-3 py-1.5" title="Order number this business date, for the next order pushed">
                <div className="text-[9px] uppercase tracking-wide text-white/50 font-semibold">Next Order</div>
                <div className="font-mono font-bold text-lg text-white">#{nextOrderSeq}</div>
              </div>
            )}
            {editTarget && (
              <div className="text-right leading-tight rounded-lg bg-white/10 px-3 py-1.5" title="Original punch time — set once when the order was first pushed, and stays the same no matter when you edit it">
                <div className="text-[9px] uppercase tracking-wide text-white/60 font-semibold">Punched</div>
                <div className="font-mono font-bold text-sm text-white">
                  {new Date(editTarget.openedAt).toLocaleDateString("en-PK", { day: "2-digit", month: "short" })}
                  {" · "}
                  {new Date(editTarget.openedAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true })}
                </div>
              </div>
            )}
            <button onClick={onClose} onMouseDown={(e) => e.stopPropagation()} className="w-7 h-7 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 text-xl leading-none cursor-pointer transition-colors">×</button>
          </div>
        </div>

        {/* Entry zone — qty + item code, visually grouped as its own panel */}
        <div className="p-5 bg-slate-50 border-b border-slate-200">
          <div className="grid grid-cols-12 gap-3">
            <label className="col-span-3">
              <div className="text-[10px] uppercase tracking-wider font-bold mb-1.5">
                <span className="text-slate-400">Qty</span>
                {qtyInput.startsWith("-") && (
                  <span className="ml-2 text-red-600">Subtract mode</span>
                )}
              </div>
              <input
                ref={qtyRef}
                className={`input w-full font-mono text-3xl text-center bg-white shadow-sm ${qtyInput.startsWith("-") ? "text-red-600 border-red-300" : ""}`}
                inputMode="decimal"
                value={qtyInput}
                // Allow decimals + optional leading minus for subtract mode
                onChange={(e) => {
                  const neg = e.target.value.startsWith("-");
                  let v = e.target.value.replace(/[^0-9.]/g, "");
                  const firstDot = v.indexOf(".");
                  if (firstDot !== -1) v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, "");
                  setQtyInput(neg ? "-" + v : v);
                }}
                onKeyDown={onQtyKey}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <label className="col-span-9">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-1.5">
                Item code or name <span className="normal-case font-normal text-slate-400">— for a custom mix join 2–5 codes with <code className="bg-slate-200 px-1 rounded font-mono">+</code> (e.g. <code className="bg-slate-200 px-1 rounded font-mono">7+41</code> or <code className="bg-slate-200 px-1 rounded font-mono">7+41+5</code>)</span>
              </div>
              <input
                ref={codeRef}
                className="input w-full font-mono text-2xl bg-white shadow-sm"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                onKeyDown={onCodeKey}
                placeholder="e.g. 45  ·  Mango  ·  7+41  ·  7+41+5  (up to 5)"
              />
            </label>

            {/* Preview area — shows the resolved single item, the mix preview, or an error.
                When the preview is "armed" (first ENTER pressed), the border thickens and
                a "press ENTER again to add" hint appears next to the price so it's obvious
                the second press is what commits. Typing anything resets armed. */}
            <div className="col-span-12 min-h-[3.5rem]">
              {mixPreview ? (
                <div className={`rounded-xl border-2 px-4 py-2.5 transition-colors shadow-sm ${armed ? "border-accent-600 bg-accent-50 ring-2 ring-accent-300" : "border-sjc-500/40 bg-sjc-50"}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs uppercase tracking-wider text-sjc-700 font-bold bg-white/60 px-1.5 py-0.5 rounded">Mix</span>
                      <span className="ml-3 font-medium text-slate-800">{mixPreview.displayName} {mixPreview.size === "MEDIUM" ? "Medium" : "Jumbo"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {armed && <span className="text-[10px] font-bold uppercase tracking-wider text-accent-700 bg-white border border-accent-400 px-2 py-0.5 rounded animate-pulse">Press ENTER again</span>}
                      <span className="font-mono text-sm text-slate-500">PKR</span>
                      <input
                        type="number" min="0" step="any"
                        value={mixPriceOverride ?? String(mixPreview.averagedPrice)}
                        onChange={(e) => setMixPriceOverride(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        // Editing the price is itself a deliberate act — commits
                        // straight away rather than requiring the usual second
                        // ENTER (that confirmation is for the code field, where a
                        // mistyped code is the risk this is guarding against).
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitLine(); } }}
                        title="Override this mix's price — only affects this line"
                        className={`font-mono text-lg font-bold text-right w-24 rounded px-1.5 py-0.5 border ${
                          mixPriceOverride !== null ? "border-amber-400 bg-amber-50 text-amber-800" : "border-transparent hover:border-slate-300"
                        }`}
                      />
                      {mixPriceOverride !== null && (
                        <button type="button" onClick={() => setMixPriceOverride(null)} title="Reset to the computed average" className="text-slate-400 hover:text-slate-700 text-sm leading-none">↺</button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    ({mixPreview.components.map((c) => `${c.name} #${c.itemCode} @ ${c.price}`).join("  +  ")})
                    &nbsp;÷ {mixPreview.components.length} = {mixPreview.rawAverage.toFixed(2)}
                    {mixPreview.averagedPrice !== mixPreview.rawAverage && (
                      <span className="ml-1 text-accent-700 font-medium">→ rounded up to {mixPreview.averagedPrice}</span>
                    )}
                    {mixPriceOverride !== null && (
                      <span className="ml-1 text-amber-700 font-medium">→ overridden to {mixPriceOverride || "…"}</span>
                    )}
                  </div>
                </div>
              ) : preview ? (
                <div className={`flex items-center justify-between rounded-xl border-2 px-4 py-2.5 transition-colors shadow-sm ${armed ? "border-accent-600 bg-accent-50 ring-2 ring-accent-300" : "border-leaf-500/40 bg-leaf-500/5"}`}>
                  <div>
                    <span className="font-mono text-xs text-slate-400">#{preview.itemCode}</span>
                    <span className="ml-3 font-medium text-slate-800">{displayItemName(preview.name, preview.size)}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {armed && <span className="text-[10px] font-bold uppercase tracking-wider text-accent-700 bg-white border border-accent-400 px-2 py-0.5 rounded animate-pulse">Press ENTER again</span>}
                    <span className="font-mono text-lg font-bold">PKR {preview.price}</span>
                  </div>
                </div>
              ) : previewErr ? (
                <div className="rounded-xl border border-red-200 bg-red-50 text-sm text-red-600 px-4 py-2.5">{previewErr}</div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 text-xs text-slate-400 px-4 py-2.5">Type a code or name. Use <code className="bg-slate-200 px-1 rounded font-mono">A+B</code> through <code className="bg-slate-200 px-1 rounded font-mono">A+B+C+D+E</code> for a 2–5-way mix. Press <kbd className="px-1.5 py-0.5 rounded bg-slate-200 font-mono text-[10px]">ENTER</kbd> once to confirm, again to add.</div>
              )}
            </div>

            {/* Name-search results (only when name search returns multiple) */}
            {searchResults.length > 1 && (
              <div className="col-span-12 max-h-40 overflow-auto border border-slate-200 rounded-xl bg-white shadow-sm divide-y divide-slate-100">
                {searchResults.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => setPreview(it)}
                    className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-sjc-50 transition-colors ${preview?.id === it.id ? "bg-sjc-100" : ""}`}
                  >
                    <span className="font-mono text-xs text-slate-400 mr-2">#{it.itemCode}</span>
                    {it.name} {it.size !== "NA" && <span className="text-xs text-slate-500">({it.size})</span>}
                    <span className="float-right font-mono text-slate-700">PKR {it.price}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Current draft — what will be pushed to the box */}
        <div className="flex-1 overflow-auto px-5 py-3 min-h-[120px] bg-white">
          {draft.lines.length === 0 ? (
            <div className="text-center text-slate-400 text-sm py-8">No items yet. Punch a code above.</div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Items in this order</span>
                <span className="text-[10px] text-slate-400">{draft.lines.length} line{draft.lines.length === 1 ? "" : "s"}</span>
              </div>
              <ul className="divide-y divide-slate-100">
                {draft.lines.map((li) => {
                  const key = draftLineKey(li);
                  return (
                    <li key={key} className="py-2 px-2 -mx-2 rounded-lg flex items-center gap-2 text-sm hover:bg-slate-50 transition-colors">
                      {li.isMix
                        ? <span className="text-[10px] font-bold uppercase text-sjc-700 bg-sjc-100 rounded px-1.5 py-0.5 w-12 text-center shrink-0">MIX</span>
                        : <span className="font-mono text-xs text-slate-400 w-12 shrink-0">#{li.itemCode}</span>
                      }
                      <span className="flex-1 font-medium truncate">{displayItemName(li.name, li.size)}</span>
                      {/* +/− qty controls */}
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => onDraftChange(adjustDraftLineQty(draft, key, -1))}
                          className="w-6 h-6 rounded border border-slate-200 text-slate-400 hover:border-red-400 hover:text-red-600 hover:bg-red-50 text-base font-bold leading-none flex items-center justify-center"
                          title="Decrease qty"
                        >−</button>
                        <span className="font-mono text-slate-700 w-8 text-center">{li.qty}</span>
                        <button
                          type="button"
                          onClick={() => onDraftChange(adjustDraftLineQty(draft, key, 1))}
                          className="w-6 h-6 rounded border border-slate-200 text-slate-400 hover:border-green-500 hover:text-green-700 hover:bg-green-50 text-base font-bold leading-none flex items-center justify-center"
                          title="Increase qty"
                        >+</button>
                      </div>
                      <span className="font-mono text-slate-400 text-xs shrink-0">× PKR {Number(li.unitPrice).toFixed(2)}</span>
                      <span className="font-mono font-bold w-20 text-right shrink-0">PKR {(li.qty * Number(li.unitPrice)).toFixed(0)}</span>
                      <button
                        type="button"
                        onClick={() => onDraftChange(removeDraftLine(draft, key))}
                        className="text-slate-300 hover:text-red-600 text-lg leading-none w-5 shrink-0"
                        title="Remove line"
                      >×</button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {/* Footer: item count + total, both as stat tiles. Pushing to a box is
            keyboard-only now (Ctrl+1–9, per the header hint) — the touchscreen
            button row was removed since there's no touchscreen in use. */}
        <div className="px-5 py-4 border-t border-slate-200 bg-gradient-to-b from-slate-50 to-white">
          <div className="flex justify-end mb-2.5">
            <button onClick={onClear} disabled={draft.lines.length === 0} className="btn-secondary text-xs">
              {editTarget ? "Clear items" : "Clear draft"}
            </button>
          </div>
          <div className="flex items-stretch gap-3">
            <div className="rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 px-5 py-3 flex flex-col items-center justify-center shadow-md min-w-[110px]">
              <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Total Items</div>
              <div className="text-3xl font-mono font-extrabold text-white mt-0.5 tabular-nums">
                {Number.isInteger(totalQty) ? totalQty : totalQty.toFixed(2).replace(/\.?0+$/, "")}
              </div>
            </div>
            <div className={`flex-1 rounded-xl px-6 py-3 flex flex-col items-end justify-center shadow-md bg-gradient-to-br ${
              editTarget ? "from-amber-700 to-amber-900" : "from-accent-700 to-accent-900"
            }`}>
              <div className={`text-[10px] uppercase tracking-wider font-bold ${editTarget ? "text-amber-300" : "text-accent-200"}`}>
                {editTarget ? "Updated Total" : "Draft Total"}
              </div>
              <div className="text-4xl font-mono font-extrabold mt-0.5 tabular-nums text-white">
                PKR {total.toFixed(0)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
