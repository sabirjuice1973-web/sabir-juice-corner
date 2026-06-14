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
 *   Click "Box N" button below         → same effect (touchscreen / no-keyboard fallback)
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
  onPushToBox: (boxNumber: number) => void;
  // When set, the window operates in EDIT mode: header shows the order being
  // edited and the box buttons say "Move to Box N" instead of "Box N".
  editTarget?: { orderNo: string | null; serverId: string } | null;
};

export function OrderWindow({ draft, onDraftChange, onClose, onClear, onPushToBox, editTarget }: Props) {
  const qtyRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [qtyInput, setQtyInput] = useState("1");
  const [codeInput, setCodeInput] = useState("");
  const [preview, setPreview] = useState<Item | null>(null);
  const [mixPreview, setMixPreview] = useState<MixPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Item[]>([]);
  // Two-step ENTER: first press arms the preview (visual highlight + "press
  // again" hint), second press commits to the draft. Any keystroke that changes
  // the code input resets armed back to false, so the cashier can't accidentally
  // commit a stale preview that no longer matches what's typed.
  const [armed, setArmed] = useState(false);

  // Focus qty input on mount
  useEffect(() => { qtyRef.current?.focus(); qtyRef.current?.select(); }, []);

  // Live preview as the cashier types code or name
  useEffect(() => {
    const v = codeInput.trim();
    setPreview(null);
    setMixPreview(null);
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
      const [first] = mixPreview.components;
      line = {
        itemId: first.id,
        itemCode: first.itemCode,
        name: mixPreview.displayName + ` ${mixPreview.size === "MEDIUM" ? "Medium" : "Jumbo"}`,
        size: mixPreview.size,
        qty: absQty,
        unitPrice: mixPreview.averagedPrice.toFixed(2),
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
    setPreviewErr(null);
    setSearchResults([]);
    setTimeout(() => {
      qtyRef.current?.focus();
      qtyRef.current?.select();
    }, 0);
  }, [preview, mixPreview, qtyInput, draft, onDraftChange]);

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

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[500] p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`card w-full max-w-3xl flex flex-col max-h-[90vh] ${editTarget ? "border-2 border-accent-500" : ""}`}>
        <div className={`px-5 py-3 border-b border-slate-200 flex items-center justify-between ${editTarget ? "bg-accent-50" : "bg-gradient-to-r from-sjc-100 to-white"}`}>
          <div>
            <div className="font-bold text-lg">
              {editTarget ? (<>Editing order <span className="font-mono text-accent-700">{editTarget.orderNo ?? "(local)"}</span></>) : "Order Window"}
            </div>
            <div className="text-xs text-slate-500">
              {editTarget ? (
                <>Edit items, then click a box below to move the order there with updated items.</>
              ) : (
                <>
                  qty → <kbd className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-mono text-[10px]">ENTER</kbd> →
                  item code → <kbd className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-mono text-[10px]">ENTER</kbd>·<kbd className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-mono text-[10px]">ENTER</kbd> →
                  press <kbd className="px-1.5 py-0.5 rounded bg-accent-100 text-accent-800 font-mono text-[10px]">Ctrl+1</kbd>–<kbd className="px-1.5 py-0.5 rounded bg-accent-100 text-accent-800 font-mono text-[10px]">9</kbd> to push to a box
                </>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <div className="p-5 grid grid-cols-12 gap-3">
          <label className="col-span-3">
            <div className="text-xs mb-1">
              <span className="text-slate-500">Qty</span>
              {qtyInput.startsWith("-") && (
                <span className="ml-2 text-red-600 font-medium">subtract mode</span>
              )}
            </div>
            <input
              ref={qtyRef}
              className={`input w-full font-mono text-3xl text-center ${qtyInput.startsWith("-") ? "text-red-600 border-red-300" : ""}`}
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
            <div className="text-xs text-slate-500 mb-1">Item code or name <span className="text-slate-400">— for a custom mix join 2–5 codes with <code className="bg-slate-100 px-1 rounded">+</code> (e.g. <code className="bg-slate-100 px-1 rounded">7+41</code> or <code className="bg-slate-100 px-1 rounded">7+41+5</code>)</span></div>
            <input
              ref={codeRef}
              className="input w-full font-mono text-2xl"
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
              <div className={`rounded-lg border-2 px-4 py-2 transition-colors ${armed ? "border-accent-600 bg-accent-50 ring-2 ring-accent-300" : "border-sjc-500/40 bg-sjc-50"}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs uppercase tracking-wider text-sjc-700 font-bold">Mix</span>
                    <span className="ml-3 font-medium text-slate-800">{mixPreview.displayName} {mixPreview.size === "MEDIUM" ? "Medium" : "Jumbo"}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {armed && <span className="text-[10px] font-bold uppercase tracking-wider text-accent-700 bg-white border border-accent-400 px-2 py-0.5 rounded animate-pulse">Press ENTER again</span>}
                    <span className="font-mono text-lg font-bold">PKR {mixPreview.averagedPrice}</span>
                  </div>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  ({mixPreview.components.map((c) => `${c.name} #${c.itemCode} @ ${c.price}`).join("  +  ")})
                  &nbsp;÷ {mixPreview.components.length} = {mixPreview.rawAverage.toFixed(2)}
                  {mixPreview.averagedPrice !== mixPreview.rawAverage && (
                    <span className="ml-1 text-accent-700 font-medium">→ rounded up to {mixPreview.averagedPrice}</span>
                  )}
                </div>
              </div>
            ) : preview ? (
              <div className={`flex items-center justify-between rounded-lg border-2 px-4 py-2 transition-colors ${armed ? "border-accent-600 bg-accent-50 ring-2 ring-accent-300" : "border-leaf-500/40 bg-leaf-500/5"}`}>
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
              <div className="text-sm text-red-600 px-2 py-2">{previewErr}</div>
            ) : (
              <div className="text-xs text-slate-400 px-2 py-2">Type a code or name. Use <code className="bg-slate-100 px-1 rounded">A+B</code> through <code className="bg-slate-100 px-1 rounded">A+B+C+D+E</code> for a 2–5-way mix. Press <kbd className="px-1.5 py-0.5 rounded bg-slate-200 font-mono text-[10px]">ENTER</kbd> once to confirm, again to add.</div>
            )}
          </div>

          {/* Name-search results (only when name search returns multiple) */}
          {searchResults.length > 1 && (
            <div className="col-span-12 max-h-40 overflow-auto border rounded-lg">
              {searchResults.map((it, i) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setPreview(it)}
                  className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-sjc-50 ${preview?.id === it.id ? "bg-sjc-100" : ""}`}
                >
                  <span className="font-mono text-xs text-slate-400 mr-2">#{it.itemCode}</span>
                  {it.name} {it.size !== "NA" && <span className="text-xs text-slate-500">({it.size})</span>}
                  <span className="float-right font-mono text-slate-700">PKR {it.price}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Current draft — what will be pushed to the box */}
        <div className="flex-1 overflow-auto border-t border-slate-200 px-5 py-3 min-h-[120px]">
          {draft.lines.length === 0 ? (
            <div className="text-center text-slate-400 text-sm py-6">No items yet. Punch a code above.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {draft.lines.map((li) => {
                const key = draftLineKey(li);
                return (
                  <li key={key} className="py-1.5 flex items-center gap-2 text-sm">
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
          )}
        </div>

        {/* Footer: always shows 7 box-push buttons. In edit mode the labels read
            "→ Box N" and a hint explains clicking moves the order. */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-xs text-slate-500">{editTarget ? "Updated total" : "Draft total"}</div>
              <div className="text-2xl font-mono font-bold">PKR {total.toFixed(0)}</div>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              {editTarget ? (
                <span className="text-amber-700 font-medium">Click a box to move this order there</span>
              ) : (
                <>
                  <span>Press</span>
                  <kbd className="px-2 py-1 rounded bg-accent-100 text-accent-800 font-mono">Ctrl+1</kbd>
                  <span>…</span>
                  <kbd className="px-2 py-1 rounded bg-accent-100 text-accent-800 font-mono">Ctrl+7</kbd>
                  <span>or click a box below</span>
                </>
              )}
              <button onClick={onClear} disabled={draft.lines.length === 0} className="btn-secondary text-xs ml-3">
                {editTarget ? "Clear items" : "Clear draft"}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {Array.from({ length: 7 }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onPushToBox(n)}
                disabled={draft.lines.length === 0}
                title={editTarget ? `Move to Box ${n}` : `Push draft to Box ${n} (Ctrl+${n})`}
                className={`rounded-lg border-2 transition py-2 text-center disabled:opacity-40 disabled:cursor-not-allowed ${
                  editTarget
                    ? "border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-500 hover:text-white hover:border-amber-500 disabled:hover:bg-amber-50 disabled:hover:text-amber-800 disabled:hover:border-amber-400"
                    : "border-accent-200 bg-white text-accent-700 hover:bg-accent-600 hover:text-white hover:border-accent-600 disabled:hover:bg-white disabled:hover:text-accent-700 disabled:hover:border-accent-200"
                }`}
              >
                <div className="font-bold text-base leading-tight">{editTarget ? `→${n}` : `Box ${n}`}</div>
                <div className="text-[10px] font-mono opacity-70">Ctrl+{n}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
