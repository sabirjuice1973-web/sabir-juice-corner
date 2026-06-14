import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal, Field } from "./RawMaterials";

/**
 * Yield Configuration screen.
 *
 * The owner sets, per fruit pulp, how many MEDIUM glasses one shoper produces.
 * Examples from the owner's spec:
 *   Peach  -> 10 medium glasses / shoper
 *   Plum   -> 12 medium glasses / shoper
 *   Cherry ->  8 medium glasses / shoper
 *
 * Versioning: every "save" closes the previous active row (effectiveTo = today)
 * and inserts a new row (effectiveFrom = today). Historical reports continue
 * to read whatever yield was active on the date being reported. No-op saves
 * (same number) don't write a new row — the API returns `changed: false`.
 *
 * Pulps with NO active yield surface a red "Not set" badge so the owner can spot them.
 */

type YieldRow = {
  pulp: { id: string; name: string; storageUnit: string };
  current: {
    id: string;
    glassesPerShoper: string;
    effectiveFrom: string;
    branchScope: string | null;
    notes: string | null;
    changedBy: { id: string; fullName: string; username: string } | null;
  } | null;
};

type HistoryEntry = {
  id: string;
  scope: string;
  glassesPerShoper: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
  notes: string | null;
  changedBy: { fullName: string; username: string } | null;
};

export function Yields() {
  const [rows, setRows] = useState<YieldRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<YieldRow | null>(null);
  const [historyFor, setHistoryFor] = useState<YieldRow | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  function flash(msg: string) {
    setSavedToast(msg);
    setTimeout(() => setSavedToast(null), 2500);
  }

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const r = await api<{ yields: YieldRow[] }>("GET", "/reconciliation/yields");
      setRows(r.yields);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  const unsetCount = rows.filter((r) => !r.current).length;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Yield Configuration</h1>
          <div className="text-xs text-slate-500 mt-0.5">
            How many <b>medium glasses</b> one shoper of each pulp produces. The reconciliation engine uses these to compute expected consumption from sales.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {unsetCount > 0 && (
            <div className="rounded-lg bg-red-50 border-2 border-red-300 px-3 py-2 text-right">
              <div className="text-[10px] uppercase tracking-wider text-red-700">No yield set</div>
              <div className="font-mono font-bold text-base text-red-800">{unsetCount}</div>
            </div>
          )}
          <div className="rounded-lg bg-leaf-50 border-2 border-leaf-300 px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-leaf-700">Configured</div>
            <div className="font-mono font-bold text-base text-leaf-900">{rows.length - unsetCount}</div>
          </div>
        </div>
      </div>

      {error && <div className="card p-3 text-sm text-red-700 bg-red-50 border border-red-200">{error}</div>}

      <div className="card overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Pulp</th>
              <th className="w-28">Storage unit</th>
              <th className="text-right w-44">Glasses / shoper (Medium)</th>
              <th className="w-28">Effective from</th>
              <th>Changed by</th>
              <th>Notes</th>
              <th className="w-40 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-400 py-6">Loading…</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.pulp.id}>
                <td className="font-medium">{r.pulp.name}</td>
                <td className="text-xs text-slate-500">{r.pulp.storageUnit}</td>
                <td className="text-right">
                  {r.current ? (
                    <span className="font-mono font-bold text-lg">{Number(r.current.glassesPerShoper).toLocaleString("en-PK")}</span>
                  ) : (
                    <span className="pill bg-red-100 text-red-800 text-xs">Not set</span>
                  )}
                </td>
                <td className="font-mono text-xs">{r.current?.effectiveFrom ?? "—"}</td>
                <td className="text-xs text-slate-600">{r.current?.changedBy?.fullName ?? "—"}</td>
                <td className="text-xs text-slate-500">{r.current?.notes ?? <span className="text-slate-300">—</span>}</td>
                <td className="text-right space-x-1">
                  <button className="btn-ghost text-xs py-1" onClick={() => setEditing(r)}>{r.current ? "Edit" : "Set"}</button>
                  {r.current && (
                    <button className="btn-ghost text-xs py-1" onClick={() => setHistoryFor(r)}>History</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditYieldModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); flash(msg); refresh(); }}
        />
      )}

      {historyFor && (
        <YieldHistoryModal row={historyFor} onClose={() => setHistoryFor(null)} />
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

function EditYieldModal({ row, onClose, onSaved }: { row: YieldRow; onClose: () => void; onSaved: (message: string) => void }) {
  const [value, setValue] = useState(row.current?.glassesPerShoper ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const numericValue = Number(value);
  const isValid = Number.isFinite(numericValue) && numericValue > 0;
  const old = Number(row.current?.glassesPerShoper ?? NaN);
  const delta = isValid && Number.isFinite(old) ? numericValue - old : 0;

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api<{ changed: boolean; yieldConfig?: { glassesPerShoper: string } }>(
        "POST", "/reconciliation/yields",
        { processedProductId: row.pulp.id, glassesPerShoper: numericValue, notes: notes.trim() || undefined },
      );
      onSaved(r.changed ? `Saved · ${row.pulp.name} = ${r.yieldConfig?.glassesPerShoper} glasses/shoper` : `No change — same value as before`);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Yield — ${row.pulp.name}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {row.current && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
            <div className="text-slate-500 text-xs uppercase tracking-wider mb-1">Current</div>
            <div className="font-mono text-2xl font-bold">{Number(row.current.glassesPerShoper).toLocaleString("en-PK")} <span className="text-sm font-normal text-slate-500">medium glasses / shoper</span></div>
            <div className="text-xs text-slate-500 mt-1">Effective from {row.current.effectiveFrom}</div>
          </div>
        )}
        <Field label="New yield (medium glasses per shoper)">
          <input
            type="text" inputMode="decimal" autoFocus
            className="input w-full font-mono text-2xl"
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
            required
          />
          {isValid && Number.isFinite(old) && delta !== 0 && (
            <div className={`text-xs mt-1 ${delta > 0 ? "text-leaf-700" : "text-amber-700"}`}>
              {delta > 0 ? "+" : ""}{delta.toFixed(2)} vs current
            </div>
          )}
        </Field>
        <Field label="Reason / notes (optional)">
          <input className="input w-full" placeholder="e.g. summer rate — more ice, fewer fruits per glass" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded p-2">
          The new value applies to <b>orders placed from today onwards</b>. Historical reports continue to use whatever yield was active on their business date.
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy || !isValid}>{busy ? "Saving…" : "Apply new yield"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── History modal ──────────────────────────────────────────────────

function YieldHistoryModal({ row, onClose }: { row: YieldRow; onClose: () => void }) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    api<{ history: HistoryEntry[] }>("GET", `/reconciliation/yields/${row.pulp.id}/history`)
      .then((r) => setHistory(r.history))
      .catch(() => setHistory([]));
  }, [row.pulp.id]);

  return (
    <Modal title={`Yield history — ${row.pulp.name}`} onClose={onClose} wide>
      {!history ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : history.length === 0 ? (
        <div className="text-slate-400 text-sm py-6 text-center">No history yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Scope</th><th className="text-right">Glasses/shoper</th><th>From</th><th>To</th><th>Changed by</th><th>Notes</th><th></th></tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td className="text-xs">{h.scope}</td>
                <td className="text-right font-mono font-medium">{Number(h.glassesPerShoper)}</td>
                <td className="text-xs">{h.effectiveFrom}</td>
                <td className="text-xs">{h.effectiveTo ?? <span className="text-leaf-700 font-medium">current</span>}</td>
                <td className="text-xs text-slate-600">{h.changedBy?.fullName ?? "—"}</td>
                <td className="text-xs text-slate-500">{h.notes ?? <span className="text-slate-300">—</span>}</td>
                <td>{h.isCurrent && <span className="pill bg-leaf-100 text-leaf-800 text-[10px]">CURRENT</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="text-xs text-slate-500 mt-3 pt-3 border-t">
        Each row is a permanent versioned record. Changing the yield creates a new row and closes the previous one with an effective-to date.
        Reports for past dates use whichever row was active on that date.
      </div>
    </Modal>
  );
}
