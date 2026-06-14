import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

/**
 * Daily Branch Close — the reconciliation engine's manager-facing screen.
 *
 * Two phases:
 *   1. OPEN  — morning manager confirms opening stock for each pulp. Pre-filled
 *              from last night's closing; the manager can override + leave a note
 *              if the actual count differs.
 *   2. CLOSE — night manager types the closing count per pulp. System computes
 *              expected vs actual, flags any line where |variancePct| > 5%, and
 *              prompts for a reason chip on those.
 *
 * Status flow:
 *   no reconciliation -> OPEN form
 *   DRAFT             -> CLOSE form
 *   PENDING_REASONS   -> CLOSE form filtered to lines still needing a reason
 *   CLOSED            -> read-only summary
 */

const BRANCH_ID = "2";   // single-branch dev install

type PreviewLine = {
  processedProductId: string;
  pulp: { id: string; name: string; storageUnit: string };
  expectedConsumptionMGE: string;
  glassesPerShoper: string;
  expectedConsumptionShopers: string;
};

type ReconciliationLine = {
  id: string;
  pulp: { id: string; name: string; storageUnit: string };
  openingQty: string;
  openingFromPrevClose: string | null;
  transfersInQty: string;
  glassesPerShoperUsed: string;
  expectedConsumptionMGE: string | null;
  expectedConsumptionShopers: string | null;
  expectedCloseQty: string | null;
  closingQty: string | null;
  varianceQty: string | null;
  variancePct: string | null;
  reasonCode: string | null;
  reasonNotes: string | null;
};

type Reconciliation = {
  id: string;
  businessDate: string;
  status: "DRAFT" | "PENDING_CLOSE" | "PENDING_REASONS" | "CLOSED";
  openingConfirmedBy: string | null;
  openingConfirmedAt: string | null;
  openingOverrideNote: string | null;
  closedBy: string | null;
  closedAt: string | null;
  notes: string | null;
  lines: ReconciliationLine[];
};

const REASON_CHIPS = [
  { code: "WASTAGE",          label: "Wastage" },
  { code: "SPILLED",          label: "Spilled" },
  { code: "BROKEN",           label: "Glass broken" },
  { code: "REPLACEMENT",      label: "Customer replacement" },
  { code: "STAFF_MISTAKE",    label: "Staff mistake" },
  { code: "GIVEAWAY",         label: "Free giveaway" },
  { code: "ROUNDING",         label: "Rounding" },
  { code: "OTHER",            label: "Other" },
];

const SIGNIFICANT_VARIANCE_PCT = 5;

export function DailyClose() {
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));
  const [businessDate, setBusinessDate] = useState(todayIso);
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [preview, setPreview] = useState<{ lines: PreviewLine[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  function flash(msg: string) {
    setSavedToast(msg);
    setTimeout(() => setSavedToast(null), 3000);
  }

  // Load the existing reconciliation for this date (if any) + preview consumption.
  async function refresh() {
    setLoading(true); setError(null);
    try {
      const list = await api<{ reconciliations: { id: string; businessDate: string; status: string }[] }>(
        "GET", `/reconciliation/list?branchId=${BRANCH_ID}&limit=60`,
      );
      const existing = list.reconciliations.find((r) => r.businessDate === businessDate);
      if (existing) {
        const full = await api<Reconciliation>("GET", `/reconciliation/${existing.id}`);
        setRecon(full);
      } else {
        setRecon(null);
      }
      const p = await api<{ lines: PreviewLine[] }>(
        "GET", `/reconciliation/preview?branchId=${BRANCH_ID}&businessDate=${businessDate}`,
      );
      setPreview(p);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, [businessDate]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Daily Branch Close</h1>
          <div className="text-xs text-slate-500 mt-0.5">
            Open + close inventory reconciliation. The math engine compares actual closing stock to expected closing computed from today's sales.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-slate-500">Business date:</div>
          <input type="date" className="input font-mono" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
        </div>
      </div>

      {error && <div className="card p-3 text-sm text-red-700 bg-red-50 border border-red-200">{error}</div>}
      {loading && !recon && !preview && <div className="card p-6 text-center text-slate-400">Loading…</div>}

      {/* Status banner */}
      {recon && (
        <div className={`card p-3 flex items-center justify-between border-2 ${
          recon.status === "CLOSED" ? "border-leaf-400 bg-leaf-50" :
          recon.status === "PENDING_REASONS" ? "border-amber-400 bg-amber-50" :
          "border-slate-300 bg-slate-50"
        }`}>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-600">Status</div>
            <div className="font-bold text-lg">{recon.status}</div>
          </div>
          <div className="text-right text-xs text-slate-600 space-y-0.5">
            {recon.openingConfirmedBy && <div>Opening confirmed by <b>{recon.openingConfirmedBy}</b></div>}
            {recon.closedBy && <div>Closed by <b>{recon.closedBy}</b></div>}
            {recon.openingOverrideNote && <div className="text-amber-700 font-medium mt-1">Opening override: {recon.openingOverrideNote}</div>}
          </div>
        </div>
      )}

      {/* Body: either Open form or Close form */}
      {!recon && preview && (
        <OpenForm
          businessDate={businessDate}
          preview={preview}
          onCreated={() => { flash("Reconciliation opened"); refresh(); }}
        />
      )}
      {recon && recon.status !== "CLOSED" && preview && (
        <CloseForm
          recon={recon}
          preview={preview}
          onSaved={(msg) => { flash(msg); refresh(); }}
        />
      )}
      {recon && recon.status === "CLOSED" && (
        <ClosedSummary recon={recon} />
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

// ─── Open form ────────────────────────────────────────────────────────

function OpenForm({ businessDate, preview, onCreated }: { businessDate: string; preview: { lines: PreviewLine[] }; onCreated: () => void }) {
  // Initial opening = whatever the previous close was, or 0 if unknown.
  // We fetch the previous close indirectly: ask the preview server already,
  // but for opening UI we don't have access to per-pulp prev closes here.
  // To keep this lightweight, owner enters opening manually. Pre-fill = 0.
  // (When you eventually want pre-fill, we can add a /reconciliation/last-close endpoint.)
  const initialDraft: Record<string, string> = {};
  for (const l of preview.lines) initialDraft[l.processedProductId] = "";
  const [draft, setDraft] = useState<Record<string, string>>(initialDraft);
  const [overrideNote, setOverrideNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(pulpId: string, value: string) {
    setDraft((cur) => ({ ...cur, [pulpId]: value.replace(/[^0-9.]/g, "") }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const lines = preview.lines
        .filter((l) => draft[l.processedProductId] !== "")
        .map((l) => ({
          processedProductId: l.processedProductId,
          openingQty: Number(draft[l.processedProductId]) || 0,
          overrideNote: overrideNote.trim() || undefined,
        }));
      if (lines.length === 0) { setError("Enter at least one opening quantity"); setBusy(false); return; }
      await api("POST", "/reconciliation/open", { branchId: Number(BRANCH_ID), businessDate, lines });
      onCreated();
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="card p-4 space-y-3">
      <div className="border-b pb-2">
        <div className="font-bold text-lg">Open the day — opening stock</div>
        <div className="text-xs text-slate-500">
          Enter the quantity of each pulp on hand at the start of the business day. Leave blank to skip pulps you don't carry.
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Pulp</th>
            <th className="text-right w-32">Opening (shopers)</th>
            <th className="w-24 text-xs">Storage</th>
          </tr>
        </thead>
        <tbody>
          {preview.lines.map((l) => (
            <tr key={l.processedProductId}>
              <td className="font-medium">{l.pulp.name}</td>
              <td className="text-right">
                <input
                  type="text" inputMode="decimal"
                  className="input w-full font-mono text-right"
                  placeholder="0"
                  value={draft[l.processedProductId]}
                  onChange={(e) => updateRow(l.processedProductId, e.target.value)}
                />
              </td>
              <td className="text-xs text-slate-500">{l.pulp.storageUnit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <div className="text-xs text-slate-600 mb-1">Override note (if opening differs from last night's closing)</div>
        <input className="input w-full" placeholder="e.g. extra delivery overnight; closing was wrong" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} />
      </div>
      {error && <div className="text-sm text-red-600">{error}</div>}
      <button className="btn-primary px-6" disabled={busy}>{busy ? "Saving…" : "Confirm opening + start day"}</button>
    </form>
  );
}

// ─── Close form ───────────────────────────────────────────────────────

function CloseForm({ recon, preview, onSaved }: { recon: Reconciliation; preview: { lines: PreviewLine[] }; onSaved: (msg: string) => void }) {
  const previewByPulp = useMemo(() => new Map(preview.lines.map((l) => [l.processedProductId, l])), [preview]);

  // Build the editable draft from the existing lines + the preview consumption.
  type Draft = { closingQty: string; reasonCode: string | null; reasonNotes: string };
  const initial: Record<string, Draft> = {};
  for (const ln of recon.lines) {
    initial[ln.id] = {
      closingQty: ln.closingQty ?? "",
      reasonCode: ln.reasonCode ?? null,
      reasonNotes: ln.reasonNotes ?? "",
    };
  }
  const [draft, setDraft] = useState<Record<string, Draft>>(initial);
  const [headerNotes, setHeaderNotes] = useState(recon.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(lineId: string, patch: Partial<Draft>) {
    setDraft((cur) => ({ ...cur, [lineId]: { ...cur[lineId], ...patch } }));
  }

  // Compute expected close, variance, variance pct for each line live.
  function compute(ln: ReconciliationLine) {
    const opening = Number(ln.openingQty);
    const transfersIn = Number(ln.transfersInQty);
    const yieldRow = Number(ln.glassesPerShoperUsed) || 1;
    const cm = previewByPulp.get(ln.pulp.id);
    const expectedMGE = cm ? Number(cm.expectedConsumptionMGE) : 0;
    const expectedShopers = expectedMGE / yieldRow;
    const expectedClose = opening + transfersIn - expectedShopers;
    const closingStr = draft[ln.id]?.closingQty ?? "";
    const closing = closingStr === "" ? null : Number(closingStr);
    const variance = closing == null ? null : closing - expectedClose;
    const variancePct = closing != null && expectedClose > 0 ? (variance! / expectedClose) * 100 : null;
    const isSignificant = variancePct != null && Math.abs(variancePct) > SIGNIFICANT_VARIANCE_PCT;
    return { expectedMGE, expectedShopers, expectedClose, closing, variance, variancePct, isSignificant };
  }

  // Identify rows that need a reason but don't have one
  const needsReasonCount = recon.lines.filter((ln) => {
    const r = compute(ln);
    return r.isSignificant && !draft[ln.id]?.reasonCode;
  }).length;

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const lines = recon.lines
        .filter((ln) => draft[ln.id]?.closingQty !== "")
        .map((ln) => ({
          id: ln.id,
          closingQty: Number(draft[ln.id].closingQty),
          reasonCode: draft[ln.id].reasonCode ?? undefined,
          reasonNotes: draft[ln.id].reasonNotes?.trim() || undefined,
        }));
      if (lines.length === 0) { setError("Enter at least one closing quantity"); setBusy(false); return; }
      const r = await api<{ status: string; missingReasonCount: number }>(
        "POST", `/reconciliation/${recon.id}/close`,
        { lines, notes: headerNotes.trim() || undefined },
      );
      onSaved(r.status === "CLOSED"
        ? `Closed · ${lines.length} pulps reconciled`
        : `Saved as PENDING_REASONS · ${r.missingReasonCount} line(s) still need a reason`);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="card p-4 space-y-3">
      <div className="border-b pb-2 flex items-center justify-between">
        <div>
          <div className="font-bold text-lg">Close the day — enter closing stock</div>
          <div className="text-xs text-slate-500">
            For each pulp: type the actual count remaining at end of day. The system computes expected vs actual; significant variance (&gt; {SIGNIFICANT_VARIANCE_PCT}%) requires a reason chip.
          </div>
        </div>
        {needsReasonCount > 0 && (
          <div className="rounded-lg bg-red-50 border-2 border-red-300 px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-red-700">Need reason</div>
            <div className="font-mono font-bold text-base text-red-800">{needsReasonCount}</div>
          </div>
        )}
      </div>
      <div className="overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Pulp</th>
              <th className="text-right w-20">Opening</th>
              <th className="text-right w-20">In</th>
              <th className="text-right w-24">Expected close</th>
              <th className="text-right w-24">Closing</th>
              <th className="text-right w-24">Variance</th>
              <th>Reason (if needed)</th>
            </tr>
          </thead>
          <tbody>
            {recon.lines.map((ln) => {
              const c = compute(ln);
              const variancePct = c.variancePct;
              const flag = c.isSignificant;
              const closingEntered = draft[ln.id]?.closingQty !== "";
              return (
                <tr key={ln.id} className={!closingEntered ? "bg-slate-50/30" : flag ? "bg-red-50/30" : ""}>
                  <td className="font-medium">{ln.pulp.name}</td>
                  <td className="text-right font-mono text-xs">{Number(ln.openingQty).toFixed(2)}</td>
                  <td className="text-right font-mono text-xs">{Number(ln.transfersInQty).toFixed(2)}</td>
                  <td className="text-right font-mono text-xs">{c.expectedClose.toFixed(3)}</td>
                  <td>
                    <input
                      type="text" inputMode="decimal"
                      className="input w-full font-mono text-right"
                      placeholder="0"
                      value={draft[ln.id]?.closingQty ?? ""}
                      onChange={(e) => update(ln.id, { closingQty: e.target.value.replace(/[^0-9.]/g, "") })}
                    />
                  </td>
                  <td className={`text-right font-mono text-xs ${flag ? "text-red-700 font-bold" : ""}`}>
                    {c.variance == null ? "—" : `${c.variance > 0 ? "+" : ""}${c.variance.toFixed(3)}`}
                    {variancePct != null && <div className="text-[10px]">{variancePct > 0 ? "+" : ""}{variancePct.toFixed(1)}%</div>}
                  </td>
                  <td>
                    {flag && (
                      <div className="space-y-1">
                        <div className="flex flex-wrap gap-1">
                          {REASON_CHIPS.map((chip) => {
                            const on = draft[ln.id]?.reasonCode === chip.code;
                            return (
                              <button
                                key={chip.code}
                                type="button"
                                onClick={() => update(ln.id, { reasonCode: on ? null : chip.code })}
                                className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${on ? "bg-accent-600 text-white border-accent-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
                              >
                                {chip.label}
                              </button>
                            );
                          })}
                        </div>
                        {draft[ln.id]?.reasonCode === "OTHER" && (
                          <input
                            className="input w-full text-xs"
                            placeholder="explain"
                            value={draft[ln.id]?.reasonNotes ?? ""}
                            onChange={(e) => update(ln.id, { reasonNotes: e.target.value })}
                          />
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div>
        <div className="text-xs text-slate-600 mb-1">Day notes (optional)</div>
        <input className="input w-full" placeholder="e.g. fridge broke down at 4pm; power cut" value={headerNotes} onChange={(e) => setHeaderNotes(e.target.value)} />
      </div>
      {error && <div className="text-sm text-red-600">{error}</div>}
      <button className="btn-primary px-6" disabled={busy}>{busy ? "Saving…" : (needsReasonCount > 0 ? `Save (${needsReasonCount} reason${needsReasonCount === 1 ? "" : "s"} pending)` : "Close day")}</button>
    </form>
  );
}

// ─── Closed (read-only) ──────────────────────────────────────────────

function ClosedSummary({ recon }: { recon: Reconciliation }) {
  const sumVariance = recon.lines.reduce((s, ln) => s + (Number(ln.varianceQty) || 0), 0);
  return (
    <div className="card p-4 space-y-3">
      <div className="border-b pb-2 flex items-center justify-between">
        <div>
          <div className="font-bold text-lg">Day closed — read-only</div>
          <div className="text-xs text-slate-500">
            This reconciliation is locked. To make a correction, ask the owner to re-open it (audit-logged).
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-slate-600">Net variance (shopers)</div>
          <div className={`font-mono font-bold text-xl ${sumVariance >= 0 ? "text-leaf-700" : "text-red-700"}`}>
            {sumVariance > 0 ? "+" : ""}{sumVariance.toFixed(3)}
          </div>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Pulp</th>
            <th className="text-right">Opening</th>
            <th className="text-right">Expected close</th>
            <th className="text-right">Closing</th>
            <th className="text-right">Variance</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {recon.lines.map((ln) => (
            <tr key={ln.id}>
              <td className="font-medium">{ln.pulp.name}</td>
              <td className="text-right font-mono">{Number(ln.openingQty).toFixed(2)}</td>
              <td className="text-right font-mono">{Number(ln.expectedCloseQty ?? 0).toFixed(3)}</td>
              <td className="text-right font-mono">{Number(ln.closingQty ?? 0).toFixed(3)}</td>
              <td className={`text-right font-mono ${Number(ln.varianceQty) < 0 ? "text-red-700" : Number(ln.varianceQty) > 0 ? "text-leaf-700" : ""}`}>
                {Number(ln.varianceQty) > 0 ? "+" : ""}{Number(ln.varianceQty ?? 0).toFixed(3)}
                {ln.variancePct && <div className="text-[10px]">{Number(ln.variancePct) > 0 ? "+" : ""}{Number(ln.variancePct).toFixed(1)}%</div>}
              </td>
              <td className="text-xs">{ln.reasonCode ? <span className="pill bg-slate-100 text-slate-700 text-[10px]">{ln.reasonCode}{ln.reasonNotes ? ` — ${ln.reasonNotes}` : ""}</span> : <span className="text-slate-300">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {recon.notes && <div className="text-xs text-slate-600 border-t pt-2"><b>Day notes:</b> {recon.notes}</div>}
    </div>
  );
}
