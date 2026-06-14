import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Modal, Field } from "./RawMaterials";

/**
 * Item Participations screen.
 *
 * For every item in JUICE / SHAKE / MIX / SEASONAL, list the fruit pulps it
 * draws from and their percentages. Owner reviews the auto-seeded rows here
 * and fills in the mocktails / branded specials manually.
 *
 * Rules enforced by the API and surfaced in this UI:
 *   - Sum of pcts must be ~100 (tolerance band 99.9..100.1 for 33.33×3 rounding).
 *   - Can't list the same pulp twice on one item.
 *   - Empty list is allowed — clears all participations for an item.
 *
 * UI hints:
 *   - Auto-seeded rows show a small "auto" pill so the owner can spot
 *     them before they're reviewed.
 *   - Rows that don't sum to ~100 surface a red ⚠ on the sum column.
 *   - "Needs setup" filter (default OFF) narrows to items with zero participations.
 */

type Pulp = { id: string; name: string; storageUnit?: string };
type Participation = { id: string; pulp: { id: string; name: string }; pct: string; isAutoSeeded: boolean };
type ItemRow = {
  id: string;
  itemCode: number;
  name: string;
  size: "MEDIUM" | "JUMBO" | "NA";
  category: { id: string; name: string } | null;
  participations: Participation[];
  sumPct: number;
};

export function Participations() {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [pulps, setPulps] = useState<Pulp[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [editing, setEditing] = useState<ItemRow | null>(null);

  function flash(msg: string) {
    setSavedToast(msg);
    setTimeout(() => setSavedToast(null), 2500);
  }

  async function loadPulps() {
    try {
      const r = await api<{ pulps: Pulp[] }>("GET", "/reconciliation/pulps");
      setPulps(r.pulps);
    } catch (e: any) { setError(e.body?.error || e.message); }
  }

  async function loadItems() {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ limit: "500" });
      if (search.trim()) qs.set("search", search.trim());
      if (needsSetup) qs.set("needsSetup", "true");
      const r = await api<{ items: ItemRow[] }>("GET", `/reconciliation/participations?${qs}`);
      setItems(r.items);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadPulps(); }, []);
  useEffect(() => {
    const t = setTimeout(loadItems, 200);
    return () => clearTimeout(t);
  }, [search, needsSetup]);

  const needsSetupCount = useMemo(() => items.filter((i) => i.participations.length === 0).length, [items]);
  const badSumCount = useMemo(() => items.filter((i) => i.participations.length > 0 && (i.sumPct < 99.9 || i.sumPct > 100.1)).length, [items]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Item Participations</h1>
          <div className="text-xs text-slate-500 mt-0.5">
            For each item, which pulps it draws from and at what percentage. Auto-seeded from item names — review and tag mocktails/specials.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {needsSetupCount > 0 && (
            <div className="rounded-lg bg-red-50 border-2 border-red-300 px-3 py-2 text-right">
              <div className="text-[10px] uppercase tracking-wider text-red-700">Need setup</div>
              <div className="font-mono font-bold text-base text-red-800">{needsSetupCount}</div>
            </div>
          )}
          {badSumCount > 0 && (
            <div className="rounded-lg bg-amber-50 border-2 border-amber-300 px-3 py-2 text-right">
              <div className="text-[10px] uppercase tracking-wider text-amber-700">Bad sum</div>
              <div className="font-mono font-bold text-base text-amber-800">{badSumCount}</div>
            </div>
          )}
          <div className="rounded-lg bg-leaf-50 border-2 border-leaf-300 px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-leaf-700">Total items</div>
            <div className="font-mono font-bold text-base text-leaf-900">{items.length}</div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-3 flex items-center gap-3">
        <input className="input flex-1" placeholder="Search by code or name…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={needsSetup} onChange={(e) => setNeedsSetup(e.target.checked)} />
          Needs setup only
        </label>
      </div>

      {error && <div className="card p-3 text-sm text-red-700 bg-red-50 border border-red-200">{error}</div>}

      <div className="card overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="w-16">Code</th>
              <th>Name</th>
              <th className="w-20">Size</th>
              <th>Category</th>
              <th>Participations</th>
              <th className="text-right w-20">Sum %</th>
              <th className="w-20 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-400 py-6">Loading…</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-400 py-8">No items match this filter.</td></tr>
            )}
            {items.map((it) => {
              const isEmpty = it.participations.length === 0;
              const isBadSum = !isEmpty && (it.sumPct < 99.9 || it.sumPct > 100.1);
              return (
                <tr key={it.id} className={isEmpty ? "bg-red-50/30" : isBadSum ? "bg-amber-50/30" : ""}>
                  <td className="font-mono text-xs">#{it.itemCode}</td>
                  <td className="font-medium">{it.name}</td>
                  <td><span className="pill bg-slate-100 text-slate-700 text-xs">{it.size}</span></td>
                  <td className="text-xs text-slate-600">{it.category?.name ?? "—"}</td>
                  <td className="text-xs">
                    {isEmpty ? (
                      <span className="pill bg-red-100 text-red-800 text-[10px]">⚠ Not set up</span>
                    ) : (
                      <span className="flex flex-wrap gap-1.5">
                        {it.participations.map((p) => (
                          <span key={p.id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] border ${p.isAutoSeeded ? "bg-slate-50 border-slate-300 text-slate-700" : "bg-leaf-50 border-leaf-300 text-leaf-800"}`} title={p.isAutoSeeded ? "Auto-seeded — owner has not reviewed" : "Owner-confirmed"}>
                            <b>{p.pulp.name}</b> · {Number(p.pct)}%
                            {p.isAutoSeeded && <span className="text-[9px] uppercase tracking-wider text-slate-400">auto</span>}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className={`text-right font-mono font-medium ${isBadSum ? "text-amber-700" : ""}`}>
                    {isEmpty ? "—" : `${it.sumPct.toFixed(2)}%`}
                    {isBadSum && <span className="ml-1">⚠</span>}
                  </td>
                  <td className="text-right">
                    <button className="btn-ghost text-xs py-1" onClick={() => setEditing(it)}>Edit</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditParticipationsModal
          item={editing}
          pulps={pulps}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); flash(msg); loadItems(); }}
        />
      )}

      {savedToast && (
        <div className="fixed top-6 right-6 z-50 card border-2 border-emerald-400 bg-emerald-50 px-4 py-3 shadow-lg flex items-center gap-3 min-w-[260px]">
          <div className="h-8 w-8 rounded-full bg-emerald-500 text-white flex items-center justify-center font-bold text-lg">✓</div>
          <div className="text-sm font-medium text-emerald-900">{savedToast}</div>
        </div>
      )}
    </div>
  );
}

// ─── Edit modal ──────────────────────────────────────────────────────

type DraftRow = { tempKey: string; pulpId: string; pct: string };

function newRow(): DraftRow { return { tempKey: Math.random().toString(36).slice(2), pulpId: "", pct: "" }; }

function EditParticipationsModal({ item, pulps, onClose, onSaved }: { item: ItemRow; pulps: Pulp[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const initial: DraftRow[] = item.participations.length > 0
    ? item.participations.map((p) => ({ tempKey: p.id, pulpId: p.pulp.id, pct: String(Number(p.pct)) }))
    : [newRow()];
  const [draft, setDraft] = useState<DraftRow[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(key: string, patch: Partial<DraftRow>) {
    setDraft((cur) => cur.map((r) => r.tempKey === key ? { ...r, ...patch } : r));
  }
  function addRow() { setDraft((cur) => [...cur, newRow()]); }
  function removeRow(key: string) { setDraft((cur) => cur.filter((r) => r.tempKey !== key)); }

  /** Set every row's percentage to 100/N evenly, last row absorbs rounding. */
  function splitEvenly() {
    const N = draft.length;
    if (N === 0) return;
    const per = Math.floor((100 / N) * 100) / 100;
    setDraft((cur) => cur.map((r, i) => ({ ...r, pct: String(i === N - 1 ? +(100 - per * (N - 1)).toFixed(2) : per) })));
  }

  const sum = +draft.reduce((s, r) => s + (Number(r.pct) || 0), 0).toFixed(2);
  const sumOk = draft.length === 0 || (sum >= 99.9 && sum <= 100.1);
  const allRowsValid = draft.every((r) => r.pulpId && Number(r.pct) > 0 && Number(r.pct) <= 100);
  const pulpIds = draft.map((r) => r.pulpId).filter(Boolean);
  const hasDup = new Set(pulpIds).size !== pulpIds.length;

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const body = {
        participations: draft.length === 0 ? [] : draft.map((r) => ({
          processedProductId: r.pulpId,
          participationPct: Number(r.pct),
        })),
      };
      const r = await api<{ ok: boolean; count: number; sum: number }>("PUT", `/reconciliation/participations/${item.id}`, body);
      onSaved(`Saved · #${item.itemCode} ${item.name} → ${r.count} ${r.count === 1 ? "pulp" : "pulps"} totaling ${r.sum}%`);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Participations — #${item.itemCode} ${item.name}${item.size !== "NA" ? " " + item.size : ""}`} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-3">
        <div className="space-y-2">
          {draft.map((r) => (
            <div key={r.tempKey} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-7">
                <select className="input w-full" value={r.pulpId} onChange={(e) => updateRow(r.tempKey, { pulpId: e.target.value })}>
                  <option value="">— pick a pulp —</option>
                  {pulps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="col-span-3">
                <input type="text" inputMode="decimal" className="input w-full font-mono text-right" placeholder="%" value={r.pct}
                  onChange={(e) => updateRow(r.tempKey, { pct: e.target.value.replace(/[^0-9.]/g, "") })} />
              </div>
              <div className="col-span-2 flex gap-1">
                <button type="button" className="btn-ghost text-xs py-1 px-2 text-red-700 hover:bg-red-50" onClick={() => removeRow(r.tempKey)}>×</button>
              </div>
            </div>
          ))}
          <div className="flex justify-between items-center pt-1">
            <div className="flex gap-2">
              <button type="button" className="btn-secondary text-xs" onClick={addRow}>+ Add pulp</button>
              {draft.length > 1 && (
                <button type="button" className="btn-ghost text-xs" onClick={splitEvenly} title="Set all rows to 100/N evenly (e.g. 33.33% × 3)">
                  Split evenly
                </button>
              )}
            </div>
            <div className={`text-sm font-mono ${sumOk ? "text-slate-700" : "text-red-700 font-bold"}`}>
              Sum: {sum}% {sumOk ? "✓" : "✗"}
            </div>
          </div>
        </div>

        {hasDup && <div className="text-sm text-red-600">Duplicate pulp in list — pick a different one.</div>}
        {error && <div className="text-sm text-red-600">{error}</div>}

        <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded p-2 space-y-1">
          <div>Each pulp + percentage = how much of one glass comes from that fruit's shoper.</div>
          <div>Total must sum to ~100% (small rounding tolerance for 33.33×3). Leave the list empty to mark this item as not-reconciled.</div>
        </div>

        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy || !sumOk || !allRowsValid || hasDup}>{busy ? "Saving…" : "Save participations"}</button>
        </div>
      </form>
    </Modal>
  );
}
