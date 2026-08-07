import { useEffect, useState } from "react";
import { api } from "../api";
import { printPettyCashSlip } from "../pos/receipt";
import { getPettyCash, setPettyCash, getReserveCash, setReserveCash } from "../lib/pettyCash";

/**
 * End-of-day petty cash slip — a tiny thermal print (date + amount only) that
 * gets stapled to the cash set aside for tomorrow's opening float. The date
 * on it is deliberately the NEXT business date, not today's, since the slip
 * describes what the cash is *for*, not when it was counted.
 *
 * Saving here (on Print) is what lets the Hisaab "Cash Today" widget
 * auto-fill Opening Cash with this amount the next business day.
 *
 * Reserve Cash is a second, separate figure entered in the same form — cash
 * left in the shop locker rather than the till. It's saved alongside Petty
 * Cash so Cash Today can show both (so whoever reconciles the next morning,
 * e.g. on a shift after an overnight one, sees the full picture) — but it's
 * never printed on the slip and never added into any cash total.
 */
export function PettyCashModal({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const [nextDate, setNextDate] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reserveAmount, setReserveAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getBranchBusinessDate(branchId)
      .then((r) => {
        const d = new Date(`${r.businessDate}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        const nd = d.toISOString().slice(0, 10);
        setNextDate(nd);
        const saved = getPettyCash(branchId, nd);
        if (saved !== null) setAmount(saved);
        const savedReserve = getReserveCash(branchId, nd);
        if (savedReserve !== null) setReserveAmount(savedReserve);
      })
      .catch((e: any) => setError(e.body?.error || e.message || "Could not load business date"));
  }, [branchId]);

  function handlePrint() {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt < 0) { setError("Enter a valid amount"); return; }
    if (!nextDate) return;
    setError(null);
    // Re-saving with a different amount simply overwrites — only the latest
    // value for a given date is kept, matching how Opening Cash itself works.
    setPettyCash(branchId, nextDate, String(amt));
    // Reserve Cash is optional — only save it if something was actually
    // entered, and it never appears on the printed slip.
    const reserve = parseFloat(reserveAmount);
    if (Number.isFinite(reserve) && reserve >= 0) setReserveCash(branchId, nextDate, String(reserve));
    printPettyCashSlip({ forDate: nextDate, amount: amt });
  }

  const nextDateLabel = nextDate
    ? new Date(`${nextDate}T00:00:00Z`).toLocaleDateString("en-PK", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    : "…";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-xs p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold">Petty Cash Slip</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        <div className="text-xs text-slate-500 mb-3">For next business date: <span className="font-semibold text-slate-700">{nextDateLabel}</span></div>
        <label className="block mb-3">
          <span className="text-sm text-slate-600">Total Petty Cash (PKR)</span>
          <input
            type="number" min="0" autoFocus
            className="input w-full mt-1 font-mono text-lg"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handlePrint(); }}
          />
        </label>
        <label className="block mb-3">
          <span className="text-sm text-slate-600">Reserve Cash at Shop (PKR)</span>
          <input
            type="number" min="0"
            className="input w-full mt-1 font-mono text-lg"
            placeholder="0"
            value={reserveAmount}
            onChange={(e) => setReserveAmount(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handlePrint(); }}
          />
          <span className="text-[10px] text-slate-400 mt-1 block">Cash left in the shop locker — shown on Cash Today, not printed on the slip.</span>
        </label>
        {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
        <button onClick={handlePrint} disabled={!nextDate} className="btn-primary w-full disabled:opacity-50">
          Print Slip
        </button>
      </div>
    </div>
  );
}
