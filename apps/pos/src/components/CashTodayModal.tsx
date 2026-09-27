import { useEffect, useState } from "react";
import { api } from "../api";
import { getPettyCash, getReserveCash } from "../lib/pettyCash";

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const inputCls = "w-full border border-slate-300 rounded-md px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";

function fmtPKR(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "—";
  return "Rs " + n.toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Cash Today — opening float + cash collected − expenses (± self loan) =
 * current cash that should be in the till. Originally lived behind a button
 * in the Hisaab/Accounts window header; moved to Today's Sales (replacing
 * the old "Cash in Counter" calculator there) so it sits next to the sales
 * figures it's actually reconciling against.
 */
export function CashTodayModal({ branchId, shiftId, businessDate, onClose }: { branchId: string; shiftId: string; businessDate: string | null; onClose: () => void }) {
  // Don't trust the businessDate PROP here — if the caller was already open
  // before the branch's business date rolled over, the prop is frozen at
  // whatever it was when that window/screen mounted and never updates again.
  // Fetch the live value fresh on mount instead, falling back to the prop
  // only until that resolves.
  const [today, setToday] = useState<string>(businessDate ?? todayIso());
  const [openingCash, setOpeningCash] = useState("");
  const [autoFilledFromPetty, setAutoFilledFromPetty] = useState(false);
  const [openingEdited, setOpeningEdited] = useState(false);
  const [reserveCash, setReserveCash] = useState<string | null>(null);
  const [todaySale, setTodaySale] = useState("0");
  const [totalExpenses, setTotalExpenses] = useState("0");
  const [selfLoanNet, setSelfLoanNet] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { businessDate: liveToday } = await api.getBranchBusinessDate(branchId);
        setToday(liveToday);

        const OPENING_KEY = `sjc.openingCash.${branchId}.${liveToday}`;
        const savedOpening = localStorage.getItem(OPENING_KEY);
        const savedPetty = getPettyCash(branchId, liveToday);
        setOpeningCash(savedOpening ?? savedPetty ?? "");
        setAutoFilledFromPetty(savedOpening === null && savedPetty !== null);
        setReserveCash(getReserveCash(branchId, liveToday));

        // partnerAccountsSummary is OWNER-only and 403s for a cashier — caught
        // inline (not left in the same Promise.all) so a non-owner opening
        // this modal still gets Today's Sales/Expenses; the Self Loan row
        // just stays hidden for them.
        const [e, p, ordersRes, lateRes] = await Promise.all([
          api.ledgerCashToday(branchId, liveToday),
          api.partnerAccountsSummary(branchId, { from: liveToday, to: liveToday }).catch(() => null),
          api.todayOrders(shiftId),
          api.latePaymentsSummary(branchId, liveToday, liveToday).catch(() => ({ amount: "0", discount: "0" })),
        ]);
        // "Today's Sales" here must be actual CASH collected, not the total
        // value of everything sold — a credit-sale order is real revenue but
        // no cash for it has landed in the till yet, so including it would
        // overstate what's actually available to reconcile against. Same
        // gross-minus-discount-once logic as the Sales screen's Total Cash.
        const isCashOrder = (o: { status: string; payments: { method: string }[] }) =>
          o.status === "PAID" && o.payments.length > 0 && o.payments.every((pmt) => pmt.method !== "CREDIT");
        const cashOrders = ordersRes.orders.filter(isCashOrder);
        const grossCashSale = cashOrders.reduce((sum, o) => sum + Number(o.subtotal), 0);
        const cashDiscount = cashOrders.reduce((sum, o) => sum + Number(o.discountAmount), 0);
        const totalCashToday = grossCashSale - cashDiscount + Number(lateRes.amount);
        setTodaySale(String(totalCashToday));
        setTotalExpenses(e.totalExpenses);
        setSelfLoanNet(p?.period ? Number(p.period.net) : 0);
      } catch {}
      setLoading(false);
    })();
  }, [branchId, shiftId]);

  function saveOpening(v: string) {
    setOpeningCash(v);
    setOpeningEdited(true);
    localStorage.setItem(`sjc.openingCash.${branchId}.${today}`, v);
  }

  const opening = parseFloat(openingCash) || 0;
  const sale = parseFloat(todaySale) || 0;
  const expenses = parseFloat(totalExpenses) || 0;
  const current = opening + sale - expenses + selfLoanNet;

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-3 border-b bg-green-700 text-white rounded-t-xl">
          <h2 className="font-semibold text-sm">Cash Today — {today}</h2>
          <button type="button" onClick={onClose} className="text-white/70 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          {loading ? (
            <div className="text-slate-400 text-sm text-center py-4">Loading…</div>
          ) : <>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Opening Cash (Rs)</label>
              <input type="number" value={openingCash} onChange={(e) => saveOpening(e.target.value)}
                placeholder="0" min="0" step="any" autoFocus className={inputCls} />
              <p className="text-[10px] text-slate-400 mt-1">
                {autoFilledFromPetty && !openingEdited ? "Auto-filled from yesterday's Petty Cash slip — edit to override" : "Saved automatically per day"}
              </p>
            </div>
            {reserveCash !== null && (
              <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5">
                <div>
                  <div className="text-xs font-medium text-amber-800">Reserve Cash at Shop</div>
                  <div className="text-[10px] text-amber-600">In the locker — separate from the till, not part of Current Cash below</div>
                </div>
                <span className="font-bold tabular-nums text-amber-800">{fmtPKR(reserveCash)}</span>
              </div>
            )}
            <div className="rounded-lg bg-slate-50 border divide-y text-sm">
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-slate-600">Opening Cash</span>
                <span className="font-medium tabular-nums">{fmtPKR(opening.toFixed(2))}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-green-700 font-medium">+ Cash Collected</span>
                <span className="font-medium text-green-700 tabular-nums">+ {fmtPKR(todaySale)}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-red-600 font-medium">− All Expenses</span>
                <span className="font-medium text-red-600 tabular-nums">− {fmtPKR(totalExpenses)}</span>
              </div>
              {selfLoanNet !== 0 && (
                <div className="flex justify-between px-4 py-2.5">
                  <span className={`font-medium ${selfLoanNet > 0 ? "text-green-700" : "text-orange-600"}`}>
                    {selfLoanNet > 0 ? "+ Self Loan (given in)" : "− Self Loan (taken out)"}
                  </span>
                  <span className={`font-medium tabular-nums ${selfLoanNet > 0 ? "text-green-700" : "text-orange-600"}`}>
                    {selfLoanNet > 0 ? "+ " : "− "}{fmtPKR(Math.abs(selfLoanNet).toFixed(2))}
                  </span>
                </div>
              )}
              <div className="flex justify-between px-4 py-2.5 bg-slate-100 rounded-b-lg">
                <span className="font-bold text-slate-800">= Current Cash</span>
                <span className={`font-bold text-lg tabular-nums ${current >= 0 ? "text-green-700" : "text-red-700"}`}>
                  {fmtPKR(current.toFixed(2))}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-slate-400">Cash Collected = cash orders + late payments from credit accounts, net of discounts — excludes today's credit sales not yet paid. Expenses = sum of all Cash Paid in all 10 accounts today. Self Loan = Usman/Naveed cash in/out for today's business date.</p>
          </>}
        </div>
      </div>
    </div>
  );
}
