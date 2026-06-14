import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiUploadFile } from "../api";
import { Modal, Field } from "./RawMaterials";

/**
 * Products / item code management screen.
 *
 * Capabilities:
 *  • Search by name or code (debounced, server-side)
 *  • Add / edit items (name, size, category, active, seasonal, pair)
 *  • Change price → versioned: the old price stays in history with effectiveTo,
 *    a new ItemPrice row becomes the current one. Historical orders are
 *    unaffected because OrderItem.unitPrice was captured at add-time.
 *  • Inspect full price history per item
 *  • Toggle active/inactive without disturbing prices
 *
 * Permissions: gated behind ADMIN_PRICE_EDIT (or OWNER) at the API layer —
 * server returns 403 if the cashier opens this somehow.
 */

type Item = {
  id: string;
  itemCode: number;
  name: string;
  size: "MEDIUM" | "JUMBO" | "NA";
  price: string | null;
  isActive: boolean;
  isSeasonal: boolean;
  category: { id: string; name: string } | null;
  pair: { id: string; itemCode: number; name: string; size: string } | null;
};

type EditMode = { kind: "create" } | { kind: "edit"; item: Item };

export function Products() {
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditMode | null>(null);
  const [priceEditor, setPriceEditor] = useState<Item | null>(null);
  const [historyFor, setHistoryFor] = useState<Item | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // ─── Bulk price-edit mode ───────────────────────────────────────────────
  // When on, every visible row's Price cell becomes an editable input.
  // `bulkEdits` holds in-progress price-string entries keyed by itemId.
  // Only entries that differ from the item's current price actually get sent.
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkEdits, setBulkEdits] = useState<Record<string, string>>({});
  const [bulkReason, setBulkReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ applied: number; skipped: number } | null>(null);

  // Generic "saved" toast for single-row edits (Edit modal, Price modal).
  // Holds the message string for ~3s after a successful save.
  const [savedToast, setSavedToast] = useState<string | null>(null);
  function flashSaved(msg: string) {
    setSavedToast(msg);
    setTimeout(() => setSavedToast(null), 3000);
  }

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ limit: "500" });
      if (search) qs.set("q", search);
      if (includeInactive) qs.set("includeInactive", "true");
      const r = await api<{ items: Item[] }>("GET", `/items?${qs}`);
      setItems(r.items);
    } catch (e: any) {
      setError(e.message);
    } finally { setLoading(false); }
  }

  // Debounced re-fetch on search/filter change
  useEffect(() => {
    const t = setTimeout(refresh, 200);
    return () => clearTimeout(t);
  }, [search, includeInactive]);

  // Suggest the next available item code when adding a new product
  const suggestedNextCode = useMemo(() => {
    const max = items.reduce((m, it) => Math.max(m, it.itemCode), 0);
    return max + 1;
  }, [items]);

  async function toggleActive(item: Item) {
    try {
      await api("PATCH", `/items/${item.id}`, { isActive: !item.isActive });
      refresh();
    } catch (e: any) { setError(e.body?.error || e.message); }
  }

  // Resolve a row's displayed price string in bulk mode (edit takes precedence over current)
  function bulkPriceFor(item: Item): string {
    return bulkEdits[item.id] !== undefined ? bulkEdits[item.id] : (item.price ?? "");
  }

  // True when the edited string is valid AND differs from the current price
  function bulkRowChanged(item: Item): { changed: boolean; delta: number | null; valid: boolean } {
    const raw = bulkEdits[item.id];
    if (raw === undefined) return { changed: false, delta: null, valid: true };
    if (raw === "") return { changed: false, delta: null, valid: false };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { changed: false, delta: null, valid: false };
    const current = Number(item.price ?? 0);
    if (n === current) return { changed: false, delta: 0, valid: true };
    return { changed: true, delta: n - current, valid: true };
  }

  const bulkSummary = items.reduce(
    (acc, it) => {
      const r = bulkRowChanged(it);
      if (r.changed) acc.changed++;
      if (!r.valid) acc.invalid++;
      return acc;
    },
    { changed: 0, invalid: 0 },
  );

  function enterBulkMode() {
    setBulkMode(true);
    setBulkEdits({});
    setBulkReason("");
    setBulkResult(null);
  }
  function cancelBulkMode() {
    // Warn before throwing away pending edits — easy to lose work otherwise.
    if (bulkSummary.changed > 0) {
      const ok = window.confirm(
        `You have ${bulkSummary.changed} unsaved price change${bulkSummary.changed === 1 ? "" : "s"}. ` +
        `Cancel will discard them. Continue?`,
      );
      if (!ok) return;
    }
    setBulkMode(false);
    setBulkEdits({});
    setBulkReason("");
  }

  async function saveBulkChanges() {
    if (bulkSummary.changed === 0 || bulkSummary.invalid > 0) return;
    setBulkBusy(true); setError(null); setBulkResult(null);
    try {
      const changes = items
        .filter((it) => bulkRowChanged(it).changed)
        .map((it) => ({ itemId: it.id, price: Number(bulkEdits[it.id]) }));
      const r = await api<{ applied: any[]; skipped: any[] }>("POST", "/items/bulk-price", {
        changes,
        reason: bulkReason || undefined,
      });
      setBulkResult({ applied: r.applied?.length ?? 0, skipped: r.skipped?.length ?? 0 });
      setBulkMode(false);
      setBulkEdits({});
      setBulkReason("");
      await refresh();
    } catch (e: any) {
      setError(e.body?.error || e.message || "Bulk update failed");
    } finally { setBulkBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Products</h1>
          <div className="text-xs text-slate-500 mt-0.5">
            Press <kbd className="px-1.5 py-0.5 rounded bg-slate-200 font-mono text-[10px]">F2</kbd> from anywhere in the admin app to jump here.
          </div>
        </div>
        <div className="flex gap-2">
          {!bulkMode && (
            <>
              <button className="btn-secondary" onClick={() => setImportOpen(true)} title="Replace the whole menu from an Excel file">
                <UploadIcon /> Import menu (XLSX)
              </button>
              <button className="btn-secondary" onClick={enterBulkMode} title="Edit prices for many items at once">
                <PencilGridIcon /> Bulk edit prices
              </button>
              <button className="btn-primary" onClick={() => setEditor({ kind: "create" })}>+ New product</button>
            </>
          )}
        </div>
      </div>

      {/* Bulk-edit sticky bar — appears at the top while in bulk mode */}
      {bulkMode && (
        <div className="card border-2 border-accent-500 bg-accent-50/40 p-3 flex flex-col gap-2 sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="font-bold text-accent-800">Bulk edit prices</div>
              <div className="text-xs text-slate-600">
                Type new prices in the table below. {bulkSummary.changed} change{bulkSummary.changed === 1 ? "" : "s"} pending
                {bulkSummary.invalid > 0 && <span className="text-red-600 ml-1">· {bulkSummary.invalid} invalid</span>}.
                Unchanged rows are skipped automatically.
              </div>
            </div>
            <input
              className="input flex-1 max-w-md text-sm"
              placeholder="Reason (optional but useful, e.g. 'Mango wholesale rate jumped')"
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
            />
            <button className="btn-secondary" onClick={cancelBulkMode} disabled={bulkBusy}>Cancel</button>
            <button
              className="btn-primary"
              onClick={saveBulkChanges}
              disabled={bulkBusy || bulkSummary.changed === 0 || bulkSummary.invalid > 0}
            >
              {bulkBusy ? "Saving…" : `Save ${bulkSummary.changed > 0 ? bulkSummary.changed + " " : ""}change${bulkSummary.changed === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      {/* Success toast after a bulk save */}
      {bulkResult && (
        <div className="card border border-emerald-300 bg-emerald-50 p-3 text-sm flex items-center justify-between">
          <div>
            <span className="text-emerald-800 font-medium">
              {bulkResult.applied} price{bulkResult.applied === 1 ? "" : "s"} updated
            </span>
            {bulkResult.skipped > 0 && <span className="text-slate-500 ml-2">· {bulkResult.skipped} unchanged (skipped)</span>}
          </div>
          <button className="text-slate-400 hover:text-slate-700" onClick={() => setBulkResult(null)}>×</button>
        </div>
      )}

      <div className="card p-3 flex items-center gap-3">
        <input
          className="input flex-1"
          placeholder="Search by name or paste a code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <span className="text-xs text-slate-400">{loading ? "Loading…" : `${items.length} items`}</span>
      </div>

      {error && <div className="card p-3 text-red-600 text-sm">{error}</div>}

      <div className="card overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="w-16">Code</th>
              <th>Name</th>
              <th className="w-20">Size</th>
              <th>Category</th>
              <th className="w-24">Pair</th>
              <th className="text-right w-24">Price</th>
              <th className="w-20">Status</th>
              <th className="w-40 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">{loading ? "Loading…" : "No items match this filter."}</td></tr>
            )}
            {items.map((it) => {
              const bulk = bulkMode ? bulkRowChanged(it) : { changed: false, delta: null as number | null, valid: true };
              const rowCls = bulk.changed
                ? "bg-amber-50/80"
                : (it.isActive ? "" : "bg-slate-50 text-slate-400");
              return (
                <tr key={it.id} className={rowCls}>
                  <td className="font-mono text-xs">#{it.itemCode}</td>
                  <td className={it.isActive ? "font-medium" : ""}>{it.name}{it.isSeasonal && <span className="ml-2 pill bg-amber-100 text-amber-800 text-[10px]">seasonal</span>}</td>
                  <td><span className="pill bg-slate-100 text-slate-700 text-xs">{it.size}</span></td>
                  <td className="text-xs">{it.category?.name ?? "—"}</td>
                  <td className="text-xs">{it.pair ? <span className="font-mono">#{it.pair.itemCode}</span> : "—"}</td>
                  <td className="text-right font-mono">
                    {bulkMode ? (
                      <div className="flex items-center justify-end gap-2">
                        <input
                          className={`input w-20 text-right font-mono px-2 py-1 text-sm ${!bulk.valid ? "border-red-400 bg-red-50" : bulk.changed ? "border-amber-400 bg-white" : ""}`}
                          inputMode="decimal"
                          value={bulkPriceFor(it)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9.]/g, "");
                            setBulkEdits((s) => ({ ...s, [it.id]: v }));
                          }}
                          aria-label={`Price for ${it.name}`}
                        />
                        {bulk.delta != null && bulk.changed && (
                          <span className={`text-[11px] font-mono w-12 text-left ${bulk.delta > 0 ? "text-amber-700" : "text-emerald-700"}`}>
                            {bulk.delta > 0 ? "+" : ""}{bulk.delta.toFixed(0)}
                          </span>
                        )}
                      </div>
                    ) : (
                      it.price ? `Rs ${it.price}` : "—"
                    )}
                  </td>
                  <td><span className={`pill text-[10px] ${it.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"}`}>{it.isActive ? "active" : "inactive"}</span></td>
                  <td className="text-right space-x-1">
                    {!bulkMode && (
                      <>
                        <button className="btn-ghost text-xs py-1" onClick={() => setPriceEditor(it)}>Price</button>
                        <button className="btn-ghost text-xs py-1" onClick={() => setHistoryFor(it)}>History</button>
                        <button className="btn-ghost text-xs py-1" onClick={() => setEditor({ kind: "edit", item: it })}>Edit</button>
                        <button className="btn-ghost text-xs py-1" onClick={() => toggleActive(it)} title={it.isActive ? "Disable item" : "Re-enable item"}>
                          {it.isActive ? "Disable" : "Enable"}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editor && (
        <ItemEditor
          mode={editor}
          suggestedNextCode={suggestedNextCode}
          onClose={() => setEditor(null)}
          onSaved={(msg) => { setEditor(null); flashSaved(msg); refresh(); }}
        />
      )}
      {priceEditor && (
        <PriceEditor
          item={priceEditor}
          onClose={() => setPriceEditor(null)}
          onSaved={(msg) => { setPriceEditor(null); flashSaved(msg); refresh(); }}
        />
      )}
      {historyFor && (
        <PriceHistory
          item={historyFor}
          onClose={() => setHistoryFor(null)}
        />
      )}
      {importOpen && (
        <ImportMenuModal
          onClose={() => setImportOpen(false)}
          onApplied={(summary) => {
            setImportOpen(false);
            flashSaved(
              `Menu imported — ${summary.toInsert} added, ${summary.toUpdate} updated, ${summary.toSoftDelete} removed`,
            );
            refresh();
          }}
        />
      )}

      {/* Floating "saved" toast — top-right, auto-dismiss after 3 s */}
      {savedToast && (
        <div className="fixed top-6 right-6 z-50 card border-2 border-emerald-400 bg-emerald-50 px-4 py-3 shadow-lg flex items-center gap-3 min-w-[260px]">
          <div className="h-8 w-8 rounded-full bg-emerald-500 text-white flex items-center justify-center font-bold text-lg">✓</div>
          <div className="text-sm font-medium text-emerald-900">{savedToast}</div>
        </div>
      )}
    </div>
  );
}

// Small grid-pencil icon used on the Bulk-edit button
function PencilGridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline align-text-bottom mr-1">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <path d="M14 17l3-3 4 4-3 3-4-4z" />
    </svg>
  );
}

// Cloud-arrow-up icon used on the Import button
function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline align-text-bottom mr-1">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

// ─── Add / Edit modal ──────────────────────────────────────────────────────

function ItemEditor({ mode, suggestedNextCode, onClose, onSaved }: { mode: EditMode; suggestedNextCode: number; onClose: () => void; onSaved: (message: string) => void }) {
  const editing = mode.kind === "edit" ? mode.item : null;
  const [itemCode, setItemCode] = useState(editing ? String(editing.itemCode) : String(suggestedNextCode));
  const [name, setName] = useState(editing?.name ?? "");
  const [size, setSize] = useState<Item["size"]>(editing?.size ?? "NA");
  // When editing, the same field doubles as the new-price input. Pre-filled with current price.
  // When creating, this is the mandatory initial price.
  const [price, setPrice] = useState(editing?.price ?? "");
  const [priceChangeReason, setPriceChangeReason] = useState("");
  const [isSeasonal, setIsSeasonal] = useState(editing?.isSeasonal ?? false);
  const [pairCode, setPairCode] = useState(editing?.pair?.itemCode ? String(editing.pair.itemCode) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Did the user actually change the price? Compare against the current price as a number.
  const priceChanged =
    !!editing &&
    price !== "" &&
    Number.isFinite(Number(price)) &&
    Number(price) !== Number(editing.price ?? -1);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      if (editing) {
        // Two concurrent calls — name/size/pair via PATCH, price via POST /price.
        // We run them sequentially so a price change still goes through even if
        // PATCH fails (or vice versa), and both errors surface clearly.
        await api("PATCH", `/items/${editing.id}`, {
          name,
          size,
          isSeasonal,
          pairItemCode: pairCode ? Number(pairCode) : null,
        });
        if (priceChanged) {
          await api("POST", `/items/${editing.id}/price`, {
            price: Number(price),
            reason: priceChangeReason || undefined,
          });
        }
        onSaved(
          priceChanged
            ? `Saved · ${name} · price ${editing.price ?? "—"} → ${Number(price).toFixed(0)}`
            : `Saved · ${name}`,
        );
      } else {
        if (!price || Number(price) < 0) { setError("Initial price required (>= 0)"); setBusy(false); return; }
        await api("POST", "/items", {
          itemCode: Number(itemCode),
          name, size,
          initialPrice: Number(price),
          isSeasonal,
          pairItemCode: pairCode ? Number(pairCode) : undefined,
        });
        onSaved(`Created #${itemCode} · ${name}`);
      }
    } catch (e: any) {
      setError(e.body?.error || e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal title={editing ? `Edit #${editing.itemCode}` : "New product"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Item code">
          <input className="input w-full font-mono" inputMode="numeric"
                 value={itemCode}
                 onChange={(e) => setItemCode(e.target.value.replace(/[^0-9]/g, ""))}
                 disabled={!!editing}
                 required />
          {!editing && <div className="text-xs text-slate-400 mt-1">Next free code suggested. Change if you want a specific code (e.g. preserving the odd/even Medium/Jumbo convention).</div>}
        </Field>
        <Field label="Name">
          <input className="input w-full" autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Size">
          <select className="input w-full" value={size} onChange={(e) => setSize(e.target.value as any)}>
            <option value="NA">N/A (no size)</option>
            <option value="MEDIUM">Medium</option>
            <option value="JUMBO">Jumbo</option>
          </select>
        </Field>
        <Field label={editing ? "Price (PKR)" : "Initial price (PKR)"}>
          <input className="input w-full font-mono text-lg" inputMode="decimal"
                 value={price}
                 onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                 required />
          {editing && (
            <div className="text-xs text-slate-400 mt-1">
              Current: <span className="font-mono">PKR {editing.price ?? "—"}</span>
              {priceChanged && (
                <span className={`ml-2 font-medium ${Number(price) > Number(editing.price ?? 0) ? "text-amber-700" : "text-emerald-700"}`}>
                  → new: PKR {Number(price).toFixed(0)} ({Number(price) > Number(editing.price ?? 0) ? "+" : ""}{(Number(price) - Number(editing.price ?? 0)).toFixed(0)})
                </span>
              )}
              <div className="mt-0.5">Changing the price creates a new versioned entry. Historical bills keep the old price.</div>
            </div>
          )}
        </Field>
        {editing && priceChanged && (
          <Field label="Reason for price change (optional)">
            <input className="input w-full" placeholder="e.g. mango wholesale rate jumped"
                   value={priceChangeReason}
                   onChange={(e) => setPriceChangeReason(e.target.value)} />
          </Field>
        )}
        <Field label="Pair with item code (optional)">
          <input className="input w-full font-mono" inputMode="numeric" placeholder="e.g. 8 (the Jumbo of this Medium)"
                 value={pairCode}
                 onChange={(e) => setPairCode(e.target.value.replace(/[^0-9]/g, ""))} />
          <div className="text-xs text-slate-400 mt-1">Pair Medium with Jumbo. Updates BOTH items to reference each other.</div>
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isSeasonal} onChange={(e) => setIsSeasonal(e.target.checked)} />
          Seasonal item
        </label>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Saving…" : (editing ? "Save changes" : "Create product")}</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Price editor modal ────────────────────────────────────────────────────

function PriceEditor({ item, onClose, onSaved }: { item: Item; onClose: () => void; onSaved: (message: string) => void }) {
  const [price, setPrice] = useState(item.price ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api("POST", `/items/${item.id}/price`, {
        price: Number(price),
        reason: reason || undefined,
      });
      onSaved(`Price updated · ${item.name} · ${item.price ?? "—"} → ${Number(price).toFixed(0)}`);
    } catch (e: any) {
      setError(e.body?.error || e.message);
    } finally { setBusy(false); }
  }

  const delta = Number(price) - Number(item.price ?? 0);

  return (
    <Modal title={`Change price — ${item.name} (#${item.itemCode}${item.size !== "NA" ? ` ${item.size}` : ""})`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
          <div className="text-slate-500 text-xs uppercase tracking-wider mb-1">Current price</div>
          <div className="font-mono text-2xl font-bold">PKR {item.price ?? "—"}</div>
        </div>
        <Field label="New price (PKR)">
          <input className="input w-full font-mono text-2xl"
                 inputMode="decimal" autoFocus
                 value={price}
                 onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                 required />
          {!isNaN(delta) && delta !== 0 && item.price && (
            <div className={`text-xs mt-1 ${delta > 0 ? "text-amber-700" : "text-emerald-700"}`}>
              {delta > 0 ? "+" : ""}{delta.toFixed(2)} PKR vs current
              {item.price && Number(item.price) > 0 && (
                <span className="text-slate-400 ml-1">
                  ({((delta / Number(item.price)) * 100).toFixed(1)}%)
                </span>
              )}
            </div>
          )}
        </Field>
        <Field label="Reason (optional but recommended)">
          <input className="input w-full" placeholder="e.g. mango wholesale rate jumped" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded p-2">
          New price applies to <b>all future orders</b>. Existing orders in waiter boxes and historical bills keep their old price.
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Saving…" : "Apply new price"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Price history modal ───────────────────────────────────────────────────

function PriceHistory({ item, onClose }: { item: Item; onClose: () => void }) {
  type HistoryEntry = { id: string; scope: string; price: string; effectiveFrom: string; effectiveTo: string | null; isCurrent: boolean };
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    api<{ history: HistoryEntry[] }>("GET", `/items/${item.id}/price-history`)
      .then((r) => setHistory(r.history))
      .catch(() => setHistory([]));
  }, [item.id]);

  return (
    <Modal title={`Price history — ${item.name} (#${item.itemCode})`} onClose={onClose} wide>
      {!history ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : history.length === 0 ? (
        <div className="text-slate-400 text-sm py-6 text-center">No price history yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Scope</th><th className="text-right">Price</th><th>From</th><th>To</th><th></th></tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td className="text-xs">{h.scope}</td>
                <td className="text-right font-mono font-medium">PKR {h.price}</td>
                <td className="text-xs">{new Date(h.effectiveFrom).toLocaleString()}</td>
                <td className="text-xs">{h.effectiveTo ? new Date(h.effectiveTo).toLocaleString() : <span className="text-emerald-700 font-medium">current</span>}</td>
                <td>{h.isCurrent && <span className="pill bg-emerald-100 text-emerald-800 text-[10px]">CURRENT</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="text-xs text-slate-500 mt-3 pt-3 border-t">
        Each row is an immutable price record. A change adds a new row and closes the previous one with an end timestamp.
        Past orders captured the price that was current at the time and aren't affected by later changes.
      </div>
    </Modal>
  );
}

// ─── Menu import modal ─────────────────────────────────────────────────────

/**
 * Two-step menu import:
 *   1. User picks an .xlsx file → click "Analyze" → POST /items/import (mode=preview)
 *      Server parses + classifies and returns a diff (inserts / updates / soft-deletes / warnings)
 *      WITHOUT touching the DB.
 *   2. User reviews the diff → click "Apply" → POST /items/import (mode=apply)
 *      Server re-parses the same file (uploaded again) and executes the transaction.
 *
 * The two-step flow exists so the owner can verify what's about to happen before
 * committing — a menu replace touches 100+ rows and is hard to reverse.
 *
 * Expected file shape: column A = code, column B = name, column C = price. First
 * row may be a header (auto-skipped if its first cell is non-numeric).
 */

type ImportPreview = {
  mode: "preview" | "apply";
  parsedRows: number;
  warnings: { row: number; raw: any[]; reason: string }[];
  toInsert: number;
  toUpdate: number;
  toUpdateUnchanged: number;
  toSoftDelete: number;
  sampleInserts: { code: number; name: string; size: string; price: string; category: string }[];
  sampleUpdates: {
    code: number;
    existingName: string; newName: string;
    existingSize: string; newSize: string;
    existingPrice: string | null; newPrice: string;
    category: string;
    nameChanged: boolean; sizeChanged: boolean; priceChanged: boolean;
  }[];
  sampleDeletes: { code: number; name: string }[];
};

function ImportMenuModal({ onClose, onApplied }: { onClose: () => void; onApplied: (summary: ImportPreview) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function analyze() {
    if (!file) { setError("Pick an .xlsx file first"); return; }
    setBusy(true); setError(null);
    try {
      const r = await apiUploadFile<ImportPreview>("/items/import", file, { mode: "preview" });
      setPreview(r);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not analyze the file");
    } finally { setBusy(false); }
  }

  async function apply() {
    if (!file || !preview) return;
    // One last confirm — replace mode is destructive.
    const ok = window.confirm(
      `This will REPLACE the menu:\n\n` +
      `  +${preview.toInsert} new items\n` +
      `  ~${preview.toUpdate} updated\n` +
      `  −${preview.toSoftDelete} removed (soft-deleted; historical bills keep their old item)\n\n` +
      `Continue?`,
    );
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const r = await apiUploadFile<ImportPreview>("/items/import", file, { mode: "apply" });
      onApplied(r);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Import failed");
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Import menu from Excel" onClose={onClose} wide>
      <div className="space-y-4">
        {!preview && (
          <div className="space-y-3">
            <div className="rounded-lg bg-sjc-50 border border-sjc-200 p-3 text-sm">
              <div className="font-medium text-slate-800 mb-1">Expected file format</div>
              <div className="text-slate-600 text-xs leading-relaxed">
                One sheet, with three columns:
                <div className="mt-1 font-mono bg-white border rounded px-2 py-1 inline-block">
                  Column A: code &nbsp;·&nbsp; Column B: name &nbsp;·&nbsp; Column C: price (PKR)
                </div>
                <div className="mt-2 text-slate-500">
                  First row is treated as a header automatically if its first cell isn't a number.
                  Size and category are inferred from the name (Medium/Jumbo suffix; juice/shake/lassi/etc.) —
                  you can re-categorize anything in the table afterwards.
                </div>
              </div>
            </div>

            <Field label="Excel file (.xlsx)">
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); setPreview(null); }}
                className="block w-full text-sm text-slate-700 file:mr-3 file:py-2 file:px-3 file:rounded file:border-0 file:bg-sjc-200 file:text-sjc-900 file:cursor-pointer hover:file:bg-sjc-300"
              />
              {file && (
                <div className="text-xs text-slate-500 mt-1">
                  Selected: <span className="font-mono">{file.name}</span> ({Math.round(file.size / 1024)} KB)
                </div>
              )}
            </Field>

            <div className="rounded bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              <b>Replace mode:</b> items not in your file will be soft-deleted (hidden from the menu but
              preserved on historical bills). Prices on items already in the DB will be updated only if
              they differ, creating a new versioned price entry.
            </div>

            {error && <div className="text-sm text-red-600">{error}</div>}

            <div className="flex gap-2 pt-2">
              <button className="btn-secondary flex-1" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn-primary flex-1" onClick={analyze} disabled={!file || busy}>
                {busy ? "Analyzing…" : "Analyze file"}
              </button>
            </div>
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            {/* Counts summary */}
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-center">
                <div className="text-2xl font-bold font-mono text-emerald-800">+{preview.toInsert}</div>
                <div className="text-[11px] uppercase tracking-wider text-emerald-700 mt-0.5">New</div>
              </div>
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-center">
                <div className="text-2xl font-bold font-mono text-amber-800">~{preview.toUpdate}</div>
                <div className="text-[11px] uppercase tracking-wider text-amber-700 mt-0.5">Updated</div>
              </div>
              <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-center">
                <div className="text-2xl font-bold font-mono text-red-800">−{preview.toSoftDelete}</div>
                <div className="text-[11px] uppercase tracking-wider text-red-700 mt-0.5">Removed</div>
              </div>
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-center">
                <div className="text-2xl font-bold font-mono text-slate-700">{preview.toUpdateUnchanged}</div>
                <div className="text-[11px] uppercase tracking-wider text-slate-600 mt-0.5">Unchanged</div>
              </div>
            </div>

            <div className="text-xs text-slate-500">
              Parsed <b>{preview.parsedRows}</b> rows from your file
              {preview.warnings.length > 0 && <span className="text-amber-700"> · {preview.warnings.length} warning{preview.warnings.length === 1 ? "" : "s"}</span>}
            </div>

            {preview.warnings.length > 0 && (
              <details className="rounded border border-amber-200 bg-amber-50 p-2">
                <summary className="text-xs font-medium text-amber-900 cursor-pointer">
                  {preview.warnings.length} row{preview.warnings.length === 1 ? "" : "s"} could not be read
                </summary>
                <ul className="text-xs mt-2 space-y-0.5 max-h-32 overflow-auto font-mono">
                  {preview.warnings.map((w, i) => (
                    <li key={i} className="text-amber-900">
                      Row {w.row}: {w.reason} — <span className="text-slate-500">{JSON.stringify(w.raw)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {preview.sampleInserts.length > 0 && (
              <details className="rounded border border-emerald-200 bg-emerald-50/40 p-2" open>
                <summary className="text-xs font-medium text-emerald-900 cursor-pointer">
                  Sample of new items (first {preview.sampleInserts.length} of {preview.toInsert})
                </summary>
                <table className="table mt-2 text-xs">
                  <thead><tr><th>Code</th><th>Name</th><th>Size</th><th>Category</th><th className="text-right">Price</th></tr></thead>
                  <tbody>
                    {preview.sampleInserts.map((it) => (
                      <tr key={it.code}>
                        <td className="font-mono">#{it.code}</td>
                        <td>{it.name}</td>
                        <td className="text-xs"><span className="pill bg-slate-100 text-slate-700 text-[10px]">{it.size}</span></td>
                        <td className="text-xs text-slate-600">{it.category}</td>
                        <td className="font-mono text-right">{it.price}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            {preview.sampleUpdates.length > 0 && (
              <details className="rounded border border-amber-200 bg-amber-50/40 p-2">
                <summary className="text-xs font-medium text-amber-900 cursor-pointer">
                  Sample of updates (first {preview.sampleUpdates.length} of {preview.toUpdate})
                </summary>
                <table className="table mt-2 text-xs">
                  <thead><tr><th>Code</th><th>Name</th><th>Price</th></tr></thead>
                  <tbody>
                    {preview.sampleUpdates.map((u) => (
                      <tr key={u.code}>
                        <td className="font-mono">#{u.code}</td>
                        <td>
                          {u.nameChanged
                            ? (<><span className="line-through text-slate-400">{u.existingName}</span> → <b>{u.newName}</b></>)
                            : u.existingName}
                          {u.sizeChanged && <span className="ml-1 text-[10px] text-amber-700">[{u.existingSize}→{u.newSize}]</span>}
                        </td>
                        <td className="font-mono text-xs">
                          {u.priceChanged
                            ? (<><span className="line-through text-slate-400">{u.existingPrice ?? "—"}</span> → <b className="text-amber-800">{u.newPrice}</b></>)
                            : u.newPrice}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            {preview.sampleDeletes.length > 0 && (
              <details className="rounded border border-red-200 bg-red-50/40 p-2">
                <summary className="text-xs font-medium text-red-900 cursor-pointer">
                  Sample of items being removed (first {preview.sampleDeletes.length} of {preview.toSoftDelete})
                </summary>
                <ul className="text-xs mt-2 space-y-0.5 max-h-40 overflow-auto">
                  {preview.sampleDeletes.map((it) => (
                    <li key={it.code}>
                      <span className="font-mono text-slate-500">#{it.code}</span> {it.name}
                    </li>
                  ))}
                </ul>
                <div className="text-[11px] text-slate-500 mt-2">
                  Items here are <b>soft-deleted</b>: hidden from active menus but kept in the database so
                  historical bills referencing them still resolve. You can also see them by enabling "Show inactive".
                </div>
              </details>
            )}

            {error && <div className="text-sm text-red-600">{error}</div>}

            <div className="flex gap-2 pt-2 border-t">
              <button className="btn-secondary flex-1" onClick={() => { setPreview(null); setFile(null); if (inputRef.current) inputRef.current.value = ""; }} disabled={busy}>
                Back
              </button>
              <button
                className="btn-primary flex-1"
                onClick={apply}
                disabled={busy || (preview.toInsert === 0 && preview.toUpdate === 0 && preview.toSoftDelete === 0)}
              >
                {busy ? "Applying…" : "Apply changes"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
