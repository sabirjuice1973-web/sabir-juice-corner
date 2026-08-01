import { Fragment, useEffect, useState } from "react";
import { api, type PaymentScheduleEntry, type PaymentScheduleInstallment } from "../api";
import { type SavedSchedule, loadSavedSchedules, writeSavedSchedules } from "../lib/paymentSchedules";

/**
 * Payment Schedule — owner's cash-flow planner (replaces a manual Excel
 * sheet). Lists upcoming/recurring obligations with a running "Average"
 * column: cumulative scheduled amount ÷ calendar days elapsed since the
 * first entry in the loaded range — a daily burn rate to compare against
 * actual sales. See paymentSchedule.ts on the API side for the full model.
 *
 * OWNER-only — enforced server-side too, this UI is just the front door.
 */

const RANGE_KEY_PREFIX = "sjc.paymentSchedule.range.";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthStartIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonthIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
function daysBetweenInclusive(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86400000) + 1;
}
function pkr(n: number): string {
  return `PKR ${n.toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
}
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-08-01" → "1-Aug-26" — compact display format for the table (inputs
// still use native <input type="date"> which requires ISO underneath).
function formatDateDisplay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d}-${MONTH_ABBR[m - 1]}-${String(y).slice(2)}`;
}

type FormState = {
  id: string | null; // null = new entry
  entryDate: string;
  details: string;
  amount: string;
  description: string;
  recurrence: "" | "WEEKLY" | "MONTHLY";
};

const EMPTY_FORM = (): FormState => ({
  id: null, entryDate: todayIso(), details: "", amount: "", description: "", recurrence: "",
});

// Loads the last from/to this branch's window was left on, so reopening the
// popup doesn't require re-picking the same range every time.
function loadSavedRange(branchId: string): { from: string; to: string } {
  try {
    const raw = localStorage.getItem(RANGE_KEY_PREFIX + branchId);
    if (raw) {
      const v = JSON.parse(raw);
      if (v.from && v.to) return v;
    }
  } catch { /* ignore */ }
  return { from: monthStartIso(), to: todayIso() };
}

export function PaymentScheduleModal({ branchId, onClose, standalone = false }: {
  branchId: string; onClose: () => void;
  /** Rendered as the sole content of its own popup window (see PaymentScheduleWindow) —
   * skips the centered-card/backdrop treatment since there's no POS behind it. */
  standalone?: boolean;
}) {
  const saved = loadSavedRange(branchId);
  const [fromDate, setFromDate] = useState(saved.from);
  const [toDate, setToDate] = useState(saved.to);
  // The branch's business date — used to default the "Date paid" field when
  // recording a payment. Falls back to the raw calendar date until it loads.
  const [businessToday, setBusinessToday] = useState(todayIso());
  useEffect(() => {
    api.getBranchBusinessDate(branchId).then((r) => setBusinessToday(r.businessDate)).catch(() => {});
  }, [branchId]);
  const [savedSchedules, setSavedSchedules] = useState<SavedSchedule[]>(() => loadSavedSchedules(branchId));
  const [entries, setEntries] = useState<PaymentScheduleEntry[] | null>(null);
  const [actualSales, setActualSales] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM());
  const [busy, setBusy] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [editingInstId, setEditingInstId] = useState<string | null>(null);
  const [editInstAmount, setEditInstAmount] = useState("");
  const [editInstDate, setEditInstDate] = useState("");
  const [editInstNote, setEditInstNote] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(todayIso());
  const [payNewDate, setPayNewDate] = useState("");
  const [payNote, setPayNote] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleName, setScheduleName] = useState("");
  // Editable override for "Actual Avg Sale / Day" — auto-seeded from real PAID
  // order data once loaded, but the owner can type over it (e.g. when actual
  // sales aren't recorded yet, or to model a hypothetical) to see the
  // deficit/surplus math update against a number they choose.
  const [actualAvgInput, setActualAvgInput] = useState("");

  // Remember this branch's date range across window opens/closes.
  useEffect(() => {
    try { localStorage.setItem(RANGE_KEY_PREFIX + branchId, JSON.stringify({ from: fromDate, to: toDate })); } catch { /* ignore */ }
  }, [branchId, fromDate, toDate]);

  // Named saved schedules — e.g. "August 2026" → jump straight to that
  // from/to with one click instead of re-picking both date fields each time.
  // Uses an on-screen panel rather than window.prompt() — prompt() is
  // unreliable inside these popup-style windows and was silently failing
  // (no dialog ever appeared, so nothing ever actually got saved).
  function confirmSaveSchedule() {
    const name = scheduleName.trim();
    if (!name) return;
    setSavedSchedules((prev) => {
      const next = [...prev.filter((s) => s.name !== name), { name, from: fromDate, to: toDate }]
        .sort((a, b) => a.from.localeCompare(b.from));
      writeSavedSchedules(branchId, next);
      return next;
    });
    setSavingSchedule(false);
    setScheduleName("");
  }
  function loadSchedule(s: SavedSchedule) {
    setFromDate(s.from);
    setToDate(s.to);
  }
  function deleteSchedule(name: string) {
    setSavedSchedules((prev) => {
      const next = prev.filter((s) => s.name !== name);
      writeSavedSchedules(branchId, next);
      return next;
    });
  }

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const { entries: es } = await api.paymentSchedule(branchId, fromDate, toDate);
      setEntries(es);
      if (es.length > 0) {
        // Same span as the Average column below — first entry's date through
        // the last — so "actual sales" and "scheduled need" are measured
        // over the exact same days.
        const first = es[0].entryDate, last = es[es.length - 1].entryDate;
        const { totalSales } = await api.paymentScheduleSalesSummary(branchId, first, last);
        setActualSales(Number(totalSales));
      } else {
        setActualSales(null);
      }
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not load payment schedule");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [branchId, fromDate, toDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Running "Average" column — cumulative amount ÷ days elapsed since the
  // FIRST entry currently in the loaded list, through to each row's own
  // date. Shown ONLY on the last row of each date group: the average
  // represents "cash needed by this date," a per-DATE checkpoint, not a
  // per-row one — showing it on every row of a shared date implied a
  // different (wrong) threshold for each entry made that same day.
  const rows = (() => {
    if (!entries || entries.length === 0) return [];
    let cumulative = 0;
    const firstDate = entries[0].entryDate;
    return entries.map((e, i) => {
      // Outstanding, not the original amount — a partly-paid entry needs
      // less cash gathered going forward, so already-paid portions shouldn't
      // inflate the running "cash still needed" figure.
      cumulative += Number(e.outstanding);
      const days = daysBetweenInclusive(firstDate, e.entryDate);
      const isLastOfDate = i === entries.length - 1 || entries[i + 1].entryDate !== e.entryDate;
      return { ...e, average: isLastOfDate ? cumulative / days : null };
    });
  })();

  const scheduledTotal = rows.reduce((s, r) => s + Number(r.amount), 0);
  const lastAverage = [...rows].reverse().find((r) => r.average !== null)?.average ?? 0;
  const spanDays = rows.length > 0 ? daysBetweenInclusive(rows[0].entryDate, rows[rows.length - 1].entryDate) : 0;
  const actualAvgPerDay = actualSales !== null && spanDays > 0 ? actualSales / spanDays : null;

  // Seed the editable field from real sales data once it's loaded — but only
  // while the owner hasn't typed their own number in, so a reload never
  // clobbers a manual override.
  useEffect(() => {
    if (actualAvgPerDay !== null && actualAvgInput.trim() === "") {
      setActualAvgInput(String(Math.round(actualAvgPerDay)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualAvgPerDay]);

  const effectiveActualAvgPerDay = actualAvgInput.trim() !== "" ? (parseFloat(actualAvgInput) || 0) : (actualAvgPerDay ?? 0);
  const shortfallPerDay = lastAverage - effectiveActualAvgPerDay;
  const totalDeficit = shortfallPerDay * spanDays;

  function resetForm() { setForm(EMPTY_FORM()); }

  function startEdit(e: PaymentScheduleEntry) {
    setForm({
      id: e.id, entryDate: e.entryDate, details: e.details,
      amount: e.amount, description: e.description ?? "", recurrence: e.recurrence ?? "",
    });
  }

  function repeatEntry(e: PaymentScheduleEntry) {
    const nextDate = e.recurrence === "MONTHLY" ? addMonthIso(e.entryDate) : addDaysIso(e.entryDate, 7);
    setForm({
      id: null, entryDate: nextDate, details: e.details,
      amount: e.amount, description: e.description ?? "", recurrence: e.recurrence ?? "",
    });
  }

  async function handleSubmit() {
    if (!form.details.trim()) { setError("Details is required"); return; }
    const amt = parseFloat(form.amount);
    if (!Number.isFinite(amt) || amt < 0) { setError("Enter a valid amount"); return; }
    setBusy(true); setError(null);
    try {
      const payload = {
        entryDate: form.entryDate,
        details: form.details.trim(),
        amount: amt,
        description: form.description.trim() || null,
        recurrence: (form.recurrence || null) as "WEEKLY" | "MONTHLY" | null,
      };
      if (form.id) {
        await api.updatePaymentScheduleEntry(form.id, payload);
      } else if (form.recurrence) {
        // New + recurring: generate every occurrence through the end of the
        // currently viewed range in one shot, anchored to this start date.
        await api.createRecurringPaymentSchedule({ branchId, ...payload, recurrence: form.recurrence, until: toDate });
      } else {
        await api.createPaymentScheduleEntry({ branchId, ...payload });
      }
      resetForm();
      await load();
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not save entry");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAllocPaid(e: PaymentScheduleEntry) {
    try {
      await api.updatePaymentScheduleEntry(e.id, { isPaid: !e.isPaid });
      await load();
    } catch (err: any) {
      setError(err.body?.error || err.message || "Could not update entry");
    }
  }

  async function removeEntry(id: string) {
    setBusy(true);
    try {
      await api.deletePaymentScheduleEntry(id);
      await load();
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not delete entry");
    } finally {
      setBusy(false);
    }
  }

  function startPay(e: PaymentScheduleEntry) {
    setPayingId(e.id); setPayAmount(""); setPayDate(businessToday); setPayNewDate(""); setPayNote("");
  }

  async function submitPay(e: PaymentScheduleEntry) {
    const amt = parseFloat(payAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setError("Enter a valid paid amount"); return; }
    setBusy(true); setError(null);
    try {
      await api.addPaymentScheduleInstallment(e.id, {
        amount: amt, paidDate: payDate,
        newEntryDate: payNewDate || null,
        note: payNote.trim() || null,
      });
      setPayingId(null);
      await load();
    } catch (err: any) {
      setError(err.body?.error || err.message || "Could not record payment");
    } finally {
      setBusy(false);
    }
  }

  function startEditInstallment(inst: PaymentScheduleInstallment) {
    setEditingInstId(inst.id);
    setEditInstAmount(inst.amount);
    setEditInstDate(inst.paidDate);
    setEditInstNote(inst.note ?? "");
  }

  async function submitEditInstallment(entryId: string) {
    if (!editingInstId) return;
    const amt = parseFloat(editInstAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setError("Enter a valid amount"); return; }
    setBusy(true); setError(null);
    try {
      await api.updatePaymentScheduleInstallment(entryId, editingInstId, {
        amount: amt, paidDate: editInstDate, note: editInstNote.trim() || null,
      });
      setEditingInstId(null);
      await load();
    } catch (err: any) {
      setError(err.body?.error || err.message || "Could not update this payment");
    } finally {
      setBusy(false);
    }
  }

  async function removeInstallment(entryId: string, instId: string) {
    setBusy(true); setError(null);
    try {
      await api.deletePaymentScheduleInstallment(entryId, instId);
      await load();
    } catch (err: any) {
      setError(err.body?.error || err.message || "Could not remove this payment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`fixed inset-0 flex items-center justify-center z-50 ${standalone ? "bg-white p-0" : "bg-black/40 p-4"}`}>
      <div className={`card p-0 flex flex-col ${standalone ? "w-full h-full max-w-none max-h-none rounded-none border-0" : "w-full max-w-5xl max-h-[90vh]"}`}>
        {/* Header */}
        <div className="px-5 py-3 border-b flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-bold">Payment Schedule</h2>
            <div className="text-xs text-slate-500 mt-0.5">Plan upcoming payments and compare against actual sales</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-slate-500">From</label>
            <input type="date" className="input text-sm py-1 px-2 w-36" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            <label className="text-xs text-slate-500">To</label>
            <input type="date" className="input text-sm py-1 px-2 w-36" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            <button onClick={() => { setScheduleName(""); setSavingSchedule(true); }} title="Save this date range as a named schedule" className="btn-secondary text-xs px-3 py-1.5">
              + Save Schedule
            </button>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none flex-shrink-0">×</button>
        </div>

        {/* Save-schedule panel — shows exactly which dates will be saved, and asks for a name */}
        {savingSchedule && (
          <div className="px-5 py-3 border-b bg-emerald-50 flex items-center gap-2 flex-wrap">
            <span className="text-sm text-emerald-800">
              Save <b>{fromDate}</b> → <b>{toDate}</b> as:
            </span>
            <input
              type="text" autoFocus placeholder="e.g. August 2026" value={scheduleName}
              onChange={(e) => setScheduleName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmSaveSchedule(); if (e.key === "Escape") setSavingSchedule(false); }}
              className="input text-sm py-1 px-2 w-48"
            />
            <button onClick={confirmSaveSchedule} disabled={!scheduleName.trim()} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50">Save</button>
            <button onClick={() => setSavingSchedule(false)} className="btn-secondary text-xs px-3 py-1.5">Cancel</button>
          </div>
        )}

        {/* Saved schedules — click one to jump straight to its date range */}
        {savedSchedules.length > 0 && (
          <div className="px-5 py-2 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Saved:</span>
            {savedSchedules.map((s) => (
              <span key={s.name} className={`inline-flex items-center gap-1 rounded-full pl-3 pr-1.5 py-1 text-xs font-medium border ${
                s.from === fromDate && s.to === toDate ? "bg-emerald-100 border-emerald-300 text-emerald-800" : "bg-white border-slate-200 text-slate-600 hover:border-emerald-300"
              }`}>
                <button onClick={() => loadSchedule(s)} title={`${s.from} → ${s.to}`}>{s.name}</button>
                <button onClick={() => deleteSchedule(s.name)} title="Remove this saved schedule" className="text-slate-300 hover:text-red-500 leading-none px-0.5">×</button>
              </span>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-auto p-5">
          {error && <div className="card border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-3">{error}</div>}

          {/* Summary: scheduled vs actual */}
          {rows.length > 0 && (
            <div className="grid grid-cols-4 gap-3 rounded-xl bg-slate-900 px-3 py-3 mb-4">
              <div className="text-center">
                <div className="text-[10px] uppercase tracking-wider text-teal-300 font-bold">Scheduled Total</div>
                <div className="font-mono font-bold text-white text-xl mt-0.5">{pkr(scheduledTotal)}</div>
              </div>
              <div className="text-center border-x border-white/10">
                <div className="text-[10px] uppercase tracking-wider text-amber-300 font-bold">Scheduled Avg / Day</div>
                <div className="font-mono font-bold text-white text-xl mt-0.5">{pkr(lastAverage)}</div>
              </div>
              <div className="text-center border-r border-white/10">
                <div className={`text-[10px] uppercase tracking-wider font-bold ${shortfallPerDay > 0 ? "text-red-400" : "text-emerald-300"}`}>
                  Actual Avg Sale / Day
                </div>
                <input
                  type="number" min="0" value={actualAvgInput}
                  onChange={(e) => setActualAvgInput(e.target.value)}
                  title="Auto-filled from real sales — edit to try a different number"
                  className={`w-full bg-transparent text-center font-mono font-bold text-xl mt-0.5 border-b border-dashed border-white/30 focus:border-white/70 focus:outline-none ${shortfallPerDay > 0 ? "text-red-400" : "text-white"}`}
                />
              </div>
              <div className="text-center">
                <div className={`text-[10px] uppercase tracking-wider font-bold ${shortfallPerDay > 0 ? "text-red-400" : "text-emerald-300"}`}>
                  {shortfallPerDay > 0 ? "Total Deficit" : "Total Surplus"}
                </div>
                <div className={`font-mono font-bold text-xl mt-0.5 ${shortfallPerDay > 0 ? "text-red-400" : "text-white"}`}>
                  {pkr(Math.abs(totalDeficit))}
                </div>
                <div className={`text-[10px] mt-0.5 ${shortfallPerDay > 0 ? "text-red-300" : "text-emerald-300"}`}>
                  {pkr(Math.abs(shortfallPerDay))}/day over {spanDays} days
                </div>
              </div>
            </div>
          )}

          {/* Add / edit form */}
          <div className={`border-2 rounded-lg px-3 py-2 mb-4 bg-white ${form.id ? "border-blue-400" : "border-emerald-400"}`}>
            {form.id
              ? <div className="text-[10px] text-blue-600 font-semibold mb-1.5">✎ Editing entry</div>
              : form.recurrence && <div className="text-[10px] text-emerald-600 font-semibold mb-1.5">Will create every {form.recurrence === "WEEKLY" ? "week" : "month"} from this date through {toDate}</div>}
            <div className="flex gap-2 items-end flex-wrap">
              <div className="shrink-0">
                <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Date</label>
                <input type="date" value={form.entryDate} onChange={(e) => setForm((p) => ({ ...p, entryDate: e.target.value }))} className="input text-sm w-36" />
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Details *</label>
                <input type="text" placeholder="e.g. AKAI Electronics" value={form.details}
                  onChange={(e) => setForm((p) => ({ ...p, details: e.target.value }))} className="input text-sm w-full" />
              </div>
              <div className="shrink-0">
                <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Amount</label>
                <input type="number" min="0" placeholder="0" value={form.amount}
                  onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))} className="input text-sm w-28 text-right" />
              </div>
              <div className="shrink-0">
                <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Recurrence</label>
                <select value={form.recurrence} disabled={!!form.id}
                  onChange={(e) => setForm((p) => ({ ...p, recurrence: e.target.value as FormState["recurrence"] }))}
                  className="input text-sm w-32 disabled:opacity-50" title={form.id ? "Recurrence only applies when creating a new entry" : undefined}>
                  <option value="">One-time</option>
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                </select>
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Description</label>
                <input type="text" placeholder="optional" value={form.description}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} className="input text-sm w-full" />
              </div>
              <div className="flex gap-2 shrink-0">
                {form.id && <button onClick={resetForm} className="btn-secondary text-xs px-3 py-1.5">Cancel</button>}
                <button onClick={() => void handleSubmit()} disabled={busy} className="btn-primary text-xs px-4 py-1.5 disabled:opacity-50">
                  {busy ? "Saving…" : form.id ? "Update" : "Add"}
                </button>
              </div>
            </div>
          </div>

          {loading && <div className="text-slate-400 text-sm text-center py-8">Loading…</div>}

          {!loading && rows.length === 0 && (
            <div className="text-slate-400 text-sm text-center py-12">No scheduled entries in this range yet.</div>
          )}

          {!loading && rows.length > 0 && (
            <table className="table w-full border-collapse">
              <thead>
                <tr>
                  <th className="px-3 py-1.5 w-24">Date</th>
                  <th className="px-3 py-1.5 text-left">Details</th>
                  <th className="px-3 py-1.5 text-right w-28">Amount</th>
                  <th className="px-3 py-1.5 text-right w-32">Average</th>
                  <th className="px-3 py-1.5 pl-5 border-l border-slate-200 text-left">Description</th>
                  <th className="px-3 py-1.5 w-16 text-center">Paid</th>
                  <th className="px-3 py-1.5 w-40 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-300">
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className={[
                      r.isPaid ? "opacity-50" : "",
                      !r.isPaid && r.average !== null && r.average > effectiveActualAvgPerDay ? "bg-red-50" : "",
                    ].join(" ")}>
                      <td className="px-3 py-1 text-xs font-mono whitespace-nowrap">{formatDateDisplay(r.entryDate)}</td>
                      <td className={`px-3 py-1 font-medium ${r.isPaid ? "line-through" : ""}`}>
                        {r.details}
                        {r.recurrence && <span className="ml-1.5 text-[9px] uppercase tracking-wide bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{r.recurrence}</span>}
                        {r.installments.length > 0 && (
                          <button
                            onClick={() => setHistoryId(historyId === r.id ? null : r.id)}
                            className={`ml-1.5 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded ${historyId === r.id ? "bg-cyan-600 text-white" : "bg-cyan-50 text-cyan-700 hover:bg-cyan-100"}`}
                          >
                            {r.installments.length} partial payment{r.installments.length > 1 ? "s" : ""}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-1 text-right font-mono whitespace-nowrap">
                        {pkr(Number(r.amount))}
                        {Number(r.outstanding) < Number(r.amount) && (
                          <div className="text-[10px] font-normal text-cyan-600">{pkr(Number(r.outstanding))} left</div>
                        )}
                      </td>
                      <td className={`px-3 py-1 text-right font-mono whitespace-nowrap ${r.average !== null && r.average > effectiveActualAvgPerDay ? "text-red-600 font-semibold" : "text-slate-500"}`}>
                        {r.average !== null ? pkr(r.average) : ""}
                      </td>
                      <td className="px-3 py-1 pl-5 border-l border-slate-200 text-xs text-slate-500 max-w-[200px] truncate" title={r.description ?? ""}>{r.description}</td>
                      <td className="px-3 py-1 text-center">
                        <input type="checkbox" checked={r.isPaid} onChange={() => void toggleAllocPaid(r)} />
                      </td>
                      <td className="px-3 py-1 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button title="Record a partial payment" onClick={() => startPay(r)} className="text-xs px-1.5 py-1 rounded bg-slate-100 hover:bg-cyan-100 text-slate-600 hover:text-cyan-700">Pay</button>
                          <button title="Edit" onClick={() => startEdit(r)} className="text-xs px-1.5 py-1 rounded bg-slate-100 hover:bg-blue-100 text-slate-600 hover:text-blue-700">Edit</button>
                          <button title="Repeat (clone forward)" onClick={() => repeatEntry(r)} className="text-xs px-1.5 py-1 rounded bg-slate-100 hover:bg-emerald-100 text-slate-600 hover:text-emerald-700">↻</button>
                          <button title="Delete" onClick={() => void removeEntry(r.id)} className="text-xs px-1.5 py-1 rounded bg-slate-100 hover:bg-red-100 text-slate-600 hover:text-red-700">Del</button>
                        </div>
                      </td>
                    </tr>
                    {payingId === r.id && (
                      <tr>
                        <td colSpan={7} className="bg-cyan-50 border-y border-cyan-200 px-4 py-2">
                          <div className="flex items-end gap-2 flex-wrap text-xs">
                            <span className="font-semibold text-cyan-800">Record partial payment for {r.details} (outstanding {pkr(Number(r.outstanding))}):</span>
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-0.5">Amount paid</label>
                              <input type="number" min="0" autoFocus value={payAmount} onChange={(e) => setPayAmount(e.target.value)} className="input text-xs w-24 text-right" />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-0.5">Date paid</label>
                              <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className="input text-xs w-32" />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-500 mb-0.5">New date for remainder (optional)</label>
                              <input type="date" value={payNewDate} onChange={(e) => setPayNewDate(e.target.value)} className="input text-xs w-32" />
                            </div>
                            <div className="flex-1 min-w-[120px]">
                              <label className="block text-[10px] text-slate-500 mb-0.5">Note (optional)</label>
                              <input type="text" value={payNote} onChange={(e) => setPayNote(e.target.value)} className="input text-xs w-full" />
                            </div>
                            <button onClick={() => setPayingId(null)} className="btn-secondary text-xs px-3 py-1.5">Cancel</button>
                            <button onClick={() => void submitPay(r)} disabled={busy} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50">
                              {busy ? "Saving…" : "Record"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {historyId === r.id && (
                      <tr>
                        <td colSpan={7} className="bg-slate-50 border-y border-slate-200 px-4 py-2">
                          <div className="text-xs font-semibold text-slate-600 mb-1.5">
                            Partial payments recorded for {r.details} — total original amount {pkr(Number(r.amount))}:
                          </div>
                          <table className="text-xs w-full max-w-lg">
                            <thead>
                              <tr className="text-slate-400">
                                <th className="text-left font-medium pb-1 pr-4">Date</th>
                                <th className="text-right font-medium pb-1 pr-4">Amount</th>
                                <th className="text-left font-medium pb-1">Note</th>
                                <th className="w-20"></th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200">
                              {r.installments.map((inst) => (
                                <Fragment key={inst.id}>
                                  <tr>
                                    <td className="py-1 pr-4 font-mono">{formatDateDisplay(inst.paidDate)}</td>
                                    <td className="py-1 pr-4 text-right font-mono">{pkr(Number(inst.amount))}</td>
                                    <td className="py-1 text-slate-500">{inst.note ?? ""}</td>
                                    <td className="py-1 text-right">
                                      <button onClick={() => startEditInstallment(inst)} className="text-[11px] px-1 text-blue-600 hover:underline">Edit</button>
                                      <button onClick={() => void removeInstallment(r.id, inst.id)} className="text-[11px] px-1 text-red-600 hover:underline">Del</button>
                                    </td>
                                  </tr>
                                  {editingInstId === inst.id && (
                                    <tr>
                                      <td colSpan={4} className="py-1.5">
                                        <div className="flex items-end gap-2 flex-wrap bg-white border border-blue-200 rounded px-2 py-1.5">
                                          <div>
                                            <label className="block text-[10px] text-slate-500 mb-0.5">Amount</label>
                                            <input type="number" min="0" value={editInstAmount} onChange={(e) => setEditInstAmount(e.target.value)} className="input text-xs w-24 text-right" />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] text-slate-500 mb-0.5">Date</label>
                                            <input type="date" value={editInstDate} onChange={(e) => setEditInstDate(e.target.value)} className="input text-xs w-32" />
                                          </div>
                                          <div className="flex-1 min-w-[120px]">
                                            <label className="block text-[10px] text-slate-500 mb-0.5">Note</label>
                                            <input type="text" value={editInstNote} onChange={(e) => setEditInstNote(e.target.value)} className="input text-xs w-full" />
                                          </div>
                                          <button onClick={() => setEditingInstId(null)} className="btn-secondary text-xs px-2 py-1">Cancel</button>
                                          <button onClick={() => void submitEditInstallment(r.id)} disabled={busy} className="btn-primary text-xs px-2 py-1 disabled:opacity-50">Save</button>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
