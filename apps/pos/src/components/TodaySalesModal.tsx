import { useEffect, useState } from "react";
import { api, type TodayOrder, type CashMovement } from "../api";
import { ORDERS_CHANGED } from "../lib/events";
import { displayItemName, BOX_LABELS, BOX_COUNT, type BoxOrder } from "../pos/posState";
import { printReceipt } from "../pos/receipt";
import { PrinterIcon } from "./PrinterIcon";

const LABELS_KEY = "sjc.boxLabels";
function getBoxLabel(boxNumber: number): string {
  try {
    const saved = JSON.parse(localStorage.getItem(LABELS_KEY) ?? "{}") as Record<number, string>;
    return saved[boxNumber] ?? BOX_LABELS[boxNumber] ?? `Box ${boxNumber}`;
  } catch { return BOX_LABELS[boxNumber] ?? `Box ${boxNumber}`; }
}

/**
 * "Today's Sales" panel — invoked from the POS header.
 *
 * Two tabs:
 *   1. Orders — every order on the active shift (PAID by default; toggle to see all)
 *      One row per order with time, #, status, discount, total, payment method(s).
 *      Click a row → fetches full /orders/:id and shows the items inline.
 *
 *   2. Items sold — aggregated qty + revenue per item across all PAID orders this shift.
 *      Sorted by qty desc so the cashier can see which juices are moving.
 *
 * Counts come from the shift's PAID orders only — drafts in waiter boxes and
 * voided/cancelled rows don't inflate the "today's sales" number. Cashier can
 * toggle the Orders tab to "All statuses" if they want to see voids/cancels too.
 */

type Tab = "orders" | "items" | "boxes";

type ItemRow = {
  itemId: string; itemCode: number | null; name: string; size: string;
  qty: string; revenue: string; isMix: boolean;
};

export function TodaySalesModal({ shiftId, branchId, onClose }: { shiftId: string; branchId: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("orders");
  const [orders, setOrders] = useState<TodayOrder[] | null>(null);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [itemTotals, setItemTotals] = useState<{ qty: string; revenue: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"PAID" | "ALL">("PAID");
  const [orderTypeFilter, setOrderTypeFilter] = useState<"ALL" | "CASH" | "CREDIT">("ALL");
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [orderItemsCache, setOrderItemsCache] = useState<Record<string, OrderLine[]>>({});
  // null = today (current business date from server); "YYYY-MM-DD" = specific date
  const [fromDate, setFromDate] = useState<string | null>(null);
  const [toDate, setToDate] = useState<string | null>(null);
  const todayStr = new Date().toISOString().slice(0, 10);
  const [lateCashReceived, setLateCashReceived] = useState(0);
  const [lateDiscount, setLateDiscount] = useState(0);
  const [todayExpense, setTodayExpense] = useState(0);
  const [openingCash, setOpeningCash] = useState(0);
  const [cashMovements, setCashMovements] = useState<CashMovement[]>([]);
  const [openingCashDraft, setOpeningCashDraft] = useState("");
  const [editingOpeningCash, setEditingOpeningCash] = useState(false);
  const [movementType, setMovementType] = useState<"IN" | "OUT">("IN");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");
  const [movementBusy, setMovementBusy] = useState(false);
  const [showCashCounter, setShowCashCounter] = useState(false);
  const [selfLoanPeriodNet, setSelfLoanPeriodNet] = useState(0);

  const isToday = fromDate === null && toDate === null;

  // Fetch late cash, opening cash, and cash in/out — only meaningful for today's (currently open) shift
  const refreshShiftStats = () => {
    if (!isToday) { setLateCashReceived(0); setLateDiscount(0); return; }
    api.todayStats(shiftId).then((s) => {
      setLateCashReceived(Number(s.lateCashReceived));
      setLateDiscount(Number(s.lateDiscount));
      setOpeningCash(Number(s.openingCash));
      setCashMovements(s.cashMovements);
    }).catch(() => {});
  };
  useEffect(refreshShiftStats, [shiftId, isToday]); // eslint-disable-line react-hooks/exhaustive-deps

  // Total Expense — cash paid out across all ledger accounts in the selected
  // period (defaults to today when no range is picked). Uses the ledger report
  // endpoint rather than the single-day cash-today endpoint so this works for
  // any from/to range, not just "today with no filter selected."
  useEffect(() => {
    let cancelled = false;
    const from = fromDate ?? todayStr;
    const to = toDate ?? todayStr;
    api.ledgerReport({ branchId, from, to }).then((r) => {
      if (!cancelled) setTodayExpense(Number(r.grandTotalCashPaid));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [branchId, fromDate, toDate, todayStr]);

  // Self Loan (Usman/Naveed personal cash in/out + online receipts) for the
  // selected period — cash taken out or received online during this period
  // isn't sitting in the shop even though it was earned, and cash given in
  // isn't earnings at all. Folded into Net Earning below so it reflects what
  // actually stayed with the shop, not just sales minus billed expense.
  useEffect(() => {
    let cancelled = false;
    const from = fromDate ?? todayStr;
    const to = toDate ?? todayStr;
    api.partnerAccountsSummary(branchId, { from, to }).then((r) => {
      if (!cancelled) setSelfLoanPeriodNet(r.period ? Number(r.period.net) : 0);
    }).catch(() => { if (!cancelled) setSelfLoanPeriodNet(0); });
    return () => { cancelled = true; };
  }, [branchId, fromDate, toDate, todayStr]);

  async function saveOpeningCash() {
    const v = Number(openingCashDraft);
    if (!Number.isFinite(v) || v < 0) return;
    setMovementBusy(true);
    try {
      await api.setOpeningCash(shiftId, v);
      setOpeningCash(v);
      setEditingOpeningCash(false);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not update opening cash");
    } finally {
      setMovementBusy(false);
    }
  }

  async function addMovement() {
    const amt = Number(movementAmount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    setMovementBusy(true);
    try {
      await api.addCashMovement(shiftId, movementType, amt, movementReason.trim() || undefined);
      setMovementAmount(""); setMovementReason("");
      refreshShiftStats();
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not add entry");
    } finally {
      setMovementBusy(false);
    }
  }

  async function removeMovement(id: string) {
    setMovementBusy(true);
    try {
      await api.deleteCashMovement(shiftId, id);
      refreshShiftStats();
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not remove entry");
    } finally {
      setMovementBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(null);
      try {
        if (tab === "orders" || tab === "boxes") {
          const r = await api.todayOrders(shiftId, fromDate ?? undefined, toDate ?? undefined);
          if (!cancelled) setOrders(r.orders);
        } else {
          const typeParam = orderTypeFilter !== "ALL" ? orderTypeFilter : undefined;
          const r = await api.itemSummary(shiftId, fromDate ?? undefined, toDate ?? undefined, typeParam);
          if (!cancelled) { setItems(r.items); setItemTotals(r.totals); }
        }
      } catch (e: any) {
        if (!cancelled) setError(e.body?.error || e.message || "Could not load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    // Only subscribe to live order events for "today" (no date range selected)
    if (!isToday) return;
    const onChange = () => { setOrderItemsCache({}); void load(); };
    window.addEventListener(ORDERS_CHANGED, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(ORDERS_CHANGED, onChange);
    };
  }, [tab, shiftId, fromDate, toDate, isToday, orderTypeFilter]);

  // Click an order row → fetch its full items (cached) and toggle expansion
  async function toggleExpand(orderId: string) {
    if (expandedOrderId === orderId) { setExpandedOrderId(null); return; }
    setExpandedOrderId(orderId);
    if (orderItemsCache[orderId]) return;        // already cached
    try {
      const data = await api.getOrder(orderId);
      const lines: OrderLine[] = (data.order?.items ?? []).map((it: any) => {
        const mix = it.isCustomMix && Array.isArray(it.customMixComponents) ? it.customMixComponents : null;
        const displayName = mix && mix.length >= 2
          ? `${mix.map((m: any) => m.name).join("+")} ${mix[0].size === "MEDIUM" ? "Medium" : "Jumbo"}`
          : it.item.name;
        return {
          name: displayName,
          size: (mix ? mix[0].size : it.item.size) as string,
          qty: it.qty,
          unitPrice: it.unitPrice,
          lineTotal: it.lineTotal,
        };
      });
      setOrderItemsCache((c) => ({ ...c, [orderId]: lines }));
    } catch (e: any) {
      setError(e.message ?? "Failed to load order items");
    }
  }

  // Reprint a past order's receipt — for when the cashier saved without
  // printing, or the original slip was damaged/misplaced. Fetches the full
  // order fresh (not the cached row) so custom-mix names resolve correctly.
  const [printingId, setPrintingId] = useState<string | null>(null);
  async function reprintOrder(order: TodayOrder) {
    setPrintingId(order.id);
    try {
      const data = await api.getOrder(order.id);
      const o = data.order;
      if (!o) return;
      const lines: BoxOrder["lines"] = (o.items ?? []).map((it: any) => {
        const mix = it.isCustomMix && Array.isArray(it.customMixComponents) ? it.customMixComponents : null;
        const displayName = mix && mix.length >= 2
          ? `${mix.map((m: any) => m.name).join("+")} ${mix[0].size === "MEDIUM" ? "Medium" : "Jumbo"}`
          : it.item.name;
        return {
          itemCode: it.item.itemCode,
          name: displayName,
          size: (mix ? mix[0].size : it.item.size) as "MEDIUM" | "JUMBO" | "NA",
          qty: Number(it.qty),
          lineTotal: it.lineTotal,
          mixOf: mix ? mix.map((m: any) => m.itemCode) : undefined,
        };
      });
      const boxOrder: BoxOrder = {
        serverId: o.id,
        localId: o.id,
        orderNo: o.orderNo,
        subtotal: o.subtotal,
        discountAmount: o.discountAmount,
        total: o.total,
        customerName: o.customerName,
        lines,
        openedAt: o.openedAt,
        deliveredAt: null,
      };
      printReceipt(boxOrder, { branchName: "", cashier: order.cashier?.fullName ?? "" });
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not print this order");
    } finally {
      setPrintingId(null);
    }
  }

  const isCashOrder   = (o: TodayOrder) => o.payments.length > 0 && o.payments.every((p) => p.method !== "CREDIT");
  const isCreditOrder = (o: TodayOrder) => o.payments.some((p) => p.method === "CREDIT");

  // visibleOrders respects BOTH the status filter and the order-type filter
  const visibleOrders = (orders ?? []).filter((o) => {
    const statusOk = statusFilter === "ALL" || o.status === "PAID";
    const typeOk =
      orderTypeFilter === "ALL"    ? true :
      orderTypeFilter === "CASH"   ? isCashOrder(o) :
      /* CREDIT */                   isCreditOrder(o);
    return statusOk && typeOk;
  });

  // Summary stats — always computed from ALL paid orders, never filtered by orderTypeFilter
  const paidOrders    = (orders ?? []).filter((o) => o.status === "PAID");
  const cashOrders    = paidOrders.filter(isCashOrder);
  const creditOrders  = paidOrders.filter(isCreditOrder);
  const cashSale      = cashOrders.reduce((s, o) => s + Number(o.total), 0);
  const creditSale    = creditOrders.reduce((s, o) => s + Number(o.total), 0);
  const totalSale     = paidOrders.reduce((s, o) => s + Number(o.total), 0);
  const totalDiscount = cashOrders.reduce((s, o) => s + Number(o.discountAmount), 0);
  const totalCashInHand = cashSale + lateCashReceived - totalDiscount - lateDiscount;

  // Cash in Counter: opening float + today's net cash + borrow/lend adjustment
  // − today's expense (cash already paid out of the till to suppliers/accounts).
  // "IN" = cash borrowed into the till — still owed back out, so it's subtracted
  // from the true cash position. "OUT" = shop cash loaned to someone — still an
  // asset owed back TO the shop, so it's added back even though it physically left.
  const cashInTotal  = cashMovements.filter((m) => m.type === "IN").reduce((s, m) => s + Number(m.amount), 0);
  const cashOutTotal = cashMovements.filter((m) => m.type === "OUT").reduce((s, m) => s + Number(m.amount), 0);
  const cashInCounter = openingCash + totalCashInHand + (cashOutTotal - cashInTotal) - todayExpense;
  // Self Loan net (gave − took − online, for the selected period) folded in:
  // a partner's withdrawal or online receipt for this period reduces what's
  // actually left with the shop; money they gave in isn't earnings.
  const netEarningToday = totalCashInHand - todayExpense + selfLoanPeriodNet;

  // Averages per day — only meaningful across a multi-day range, not a single date.
  const rangeDays = Math.round(
    (new Date(toDate ?? todayStr).getTime() - new Date(fromDate ?? todayStr).getTime()) / 86400000
  ) + 1;
  const isMultiDay = rangeDays > 1;
  const avgSalePerDay = totalCashInHand / rangeDays;
  const avgExpensePerDay = todayExpense / rangeDays;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-5xl max-h-[90vh] p-0 flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 border-b flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-xl font-bold">
              {isToday
                ? "Today's Sales"
                : fromDate === toDate || !toDate
                ? `Sales — ${fromDate}`
                : `Sales — ${fromDate} to ${toDate}`}
            </h2>
            <div className="text-xs text-slate-500 mt-0.5">Shift #{shiftId}</div>
          </div>
          {/* Date range navigator */}
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            <button
              onClick={() => { setFromDate(null); setToDate(null); setOrders(null); setItems(null); setOrderItemsCache({}); }}
              className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${isToday ? "bg-accent-600 text-white border-accent-600" : "bg-white text-slate-600 border-slate-300 hover:border-accent-400"}`}
            >Today</button>
            <div className="flex items-center gap-1">
              <label className="text-xs text-slate-500">From</label>
              <input
                type="date" max={todayStr}
                value={fromDate ?? todayStr}
                onChange={(e) => {
                  const v = e.target.value || todayStr;
                  setFromDate(v === todayStr && (toDate === null || toDate === todayStr) ? null : v);
                  if (toDate && v > toDate) setToDate(v);
                  setOrders(null); setItems(null); setOrderItemsCache({});
                }}
                className="input text-sm py-1 px-2 w-36"
              />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-slate-500">To</label>
              <input
                type="date" max={todayStr}
                value={toDate ?? todayStr}
                onChange={(e) => {
                  const v = e.target.value || todayStr;
                  setToDate(v === todayStr && (fromDate === null || fromDate === todayStr) ? null : v);
                  if (fromDate && v < fromDate) setFromDate(v);
                  setOrders(null); setItems(null); setOrderItemsCache({});
                }}
                className="input text-sm py-1 px-2 w-36"
              />
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none flex-shrink-0">×</button>
        </div>

        {/* Tab bar */}
        <div className="px-5 pt-3 border-b flex items-center gap-1">
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "orders" ? "border-accent-600 text-accent-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
            onClick={() => setTab("orders")}
          >
            Orders {orders ? <span className="ml-1 text-xs text-slate-400">({visibleOrders.length})</span> : null}
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "items" ? "border-accent-600 text-accent-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
            onClick={() => setTab("items")}
          >
            Items sold {items ? <span className="ml-1 text-xs text-slate-400">({items.length})</span> : null}
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "boxes" ? "border-accent-600 text-accent-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
            onClick={() => setTab("boxes")}
          >
            Boxes
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5">
          {error && <div className="card border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-3">{error}</div>}

          {tab === "orders" && (
            <div>
              {/* Summary cards — always computed from ALL paid orders regardless of type/status filter */}
              {paidOrders.length > 0 && (
                <div className="mb-4 space-y-2">
                  {/* Row 1: cash sale | credit sale | total sale | discount */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 px-3 py-2.5 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-emerald-600 font-bold">Cash Sale</div>
                      <div className="font-mono font-bold text-emerald-900 text-base mt-0.5">PKR {cashSale.toLocaleString("en-PK", { maximumFractionDigits: 0 })}</div>
                      <div className="text-[10px] text-emerald-500 mt-0.5">{cashOrders.length} orders</div>
                    </div>
                    <div className="rounded-xl border-2 border-violet-200 bg-violet-50 px-3 py-2.5 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-violet-500 font-bold">Credit Sale</div>
                      <div className="font-mono font-bold text-violet-900 text-base mt-0.5">{creditSale > 0 ? `PKR ${creditSale.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "—"}</div>
                      <div className="text-[10px] text-violet-400 mt-0.5">{creditOrders.length} orders</div>
                    </div>
                    <div className="rounded-xl border-2 border-blue-200 bg-blue-50 px-3 py-2.5 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-blue-500 font-bold">Total Sale</div>
                      <div className="font-mono font-bold text-blue-900 text-base mt-0.5">PKR {totalSale.toLocaleString("en-PK", { maximumFractionDigits: 0 })}</div>
                      <div className="text-[10px] text-blue-400 mt-0.5">{paidOrders.length} orders</div>
                    </div>
                    <div className="rounded-xl border-2 border-orange-200 bg-orange-50 px-3 py-2.5 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-orange-500 font-bold">Discount</div>
                      <div className="font-mono font-bold text-orange-900 text-base mt-0.5">{totalDiscount > 0 ? `−PKR ${totalDiscount.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "—"}</div>
                      <div className="text-[10px] text-orange-400 mt-0.5">on cash orders</div>
                    </div>
                  </div>

                  {/* Row 2: late cash + late discount (0 for historical dates) + per-day averages (multi-day ranges only) */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className="rounded-xl border-2 border-cyan-200 bg-cyan-50 px-3 py-2.5 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-cyan-600 font-bold">Late Cash</div>
                      <div className="font-mono font-bold text-cyan-900 text-base mt-0.5">{lateCashReceived > 0 ? `PKR ${lateCashReceived.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "—"}</div>
                      <div className="text-[10px] text-cyan-500 mt-0.5">{isToday ? "from credit accounts" : "historical not tracked"}</div>
                    </div>
                    <div className="rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2.5 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-red-500 font-bold">Late Discount</div>
                      <div className="font-mono font-bold text-red-900 text-base mt-0.5">{lateDiscount > 0 ? `−PKR ${lateDiscount.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "—"}</div>
                      <div className="text-[10px] text-red-400 mt-0.5">written off</div>
                    </div>
                    <div className="rounded-xl border-2 border-teal-200 bg-teal-50 px-3 py-2.5 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-teal-600 font-bold">Avg Sale / Day</div>
                      <div className="font-mono font-bold text-teal-900 text-base mt-0.5">
                        {isMultiDay ? `PKR ${avgSalePerDay.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "—"}
                      </div>
                      <div className="text-[10px] text-teal-500 mt-0.5">{isMultiDay ? `over ${rangeDays} days` : "pick a multi-day range"}</div>
                    </div>
                    <div className="rounded-xl border-2 border-rose-200 bg-rose-50 px-3 py-2.5 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-rose-600 font-bold">Avg Expense / Day</div>
                      <div className="font-mono font-bold text-rose-900 text-base mt-0.5">
                        {isMultiDay ? `PKR ${avgExpensePerDay.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "—"}
                      </div>
                      <div className="text-[10px] text-rose-500 mt-0.5">{isMultiDay ? `over ${rangeDays} days` : "pick a multi-day range"}</div>
                    </div>
                  </div>

                  {/* ── The Results: Total Cash, Total Expense, Net Earning — one line, distinct from the breakdown cards above ── */}
                  <div className="grid grid-cols-3 gap-3 rounded-xl bg-slate-900 px-3 py-3">
                    <div className="text-center">
                      <div className="text-[10px] uppercase tracking-wider text-teal-300 font-bold">Total Cash</div>
                      <div className="font-mono font-bold text-white text-xl mt-0.5">PKR {totalCashInHand.toLocaleString("en-PK", { maximumFractionDigits: 0 })}</div>
                    </div>
                    <div className="text-center border-x border-white/10">
                      <div className="text-[10px] uppercase tracking-wider text-rose-300 font-bold">Total Expense</div>
                      <div className="font-mono font-bold text-white text-xl mt-0.5">
                        PKR {todayExpense.toLocaleString("en-PK", { maximumFractionDigits: 0 })}
                      </div>
                    </div>
                    <div className="text-center">
                      <div className={`text-[10px] uppercase tracking-wider font-bold ${netEarningToday < 0 ? "text-red-400" : "text-emerald-300"}`}>Net Earning</div>
                      <div className={`font-mono font-bold text-xl mt-0.5 ${netEarningToday < 0 ? "text-red-400" : "text-white"}`}>
                        PKR {netEarningToday.toLocaleString("en-PK", { maximumFractionDigits: 0 })}
                      </div>
                      {selfLoanPeriodNet !== 0 && (
                        <div className="text-[10px] text-amber-300/80 mt-0.5">
                          {selfLoanPeriodNet < 0 ? "after " : "incl. "}
                          PKR {Math.abs(selfLoanPeriodNet).toLocaleString("en-PK", { maximumFractionDigits: 0 })} self loan
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ── Cash in Counter: tucked behind a button, opens its own popup ── */}
              {isToday && (
                <button
                  className="mb-4 w-full flex items-center justify-between rounded-xl border-2 border-indigo-200 bg-indigo-50 hover:bg-indigo-100 px-4 py-2.5 text-left transition-colors"
                  onClick={() => setShowCashCounter(true)}
                >
                  <span className="text-sm font-semibold text-indigo-800">Want to calculate Cash in Counter?</span>
                  <span className="text-xs text-indigo-500">opening cash · borrow/loan entries →</span>
                </button>
              )}

              {showCashCounter && (
                <CashCounterPopup
                  cashInCounter={cashInCounter}
                  openingCash={openingCash}
                  cashInTotal={cashInTotal}
                  cashOutTotal={cashOutTotal}
                  cashMovements={cashMovements}
                  editingOpeningCash={editingOpeningCash}
                  openingCashDraft={openingCashDraft}
                  setOpeningCashDraft={setOpeningCashDraft}
                  setEditingOpeningCash={setEditingOpeningCash}
                  saveOpeningCash={saveOpeningCash}
                  movementType={movementType}
                  setMovementType={setMovementType}
                  movementAmount={movementAmount}
                  setMovementAmount={setMovementAmount}
                  movementReason={movementReason}
                  setMovementReason={setMovementReason}
                  movementBusy={movementBusy}
                  addMovement={addMovement}
                  removeMovement={removeMovement}
                  onClose={() => setShowCashCounter(false)}
                />
              )}

              {/* Filter row: order-type toggle + status toggle */}
              <div className="flex items-center gap-4 mb-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-500 font-medium">Type:</span>
                  {(["ALL", "CASH", "CREDIT"] as const).map((t) => (
                    <button
                      key={t}
                      className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                        orderTypeFilter === t
                          ? t === "CASH"   ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                          : t === "CREDIT" ? "bg-violet-100 text-violet-800 border-violet-300"
                          :                  "bg-slate-200 text-slate-800 border-slate-300"
                          : "bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300"
                      }`}
                      onClick={() => { setOrderTypeFilter(t); setExpandedOrderId(null); }}
                    >{t === "ALL" ? "All" : t === "CASH" ? "Cash" : "Credit"}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-500 font-medium">Show:</span>
                  <button
                    className={`px-3 py-1 rounded text-xs font-medium border ${statusFilter === "PAID" ? "bg-slate-200 text-slate-800 border-slate-300" : "bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300"}`}
                    onClick={() => setStatusFilter("PAID")}
                  >Paid only</button>
                  <button
                    className={`px-3 py-1 rounded text-xs font-medium border ${statusFilter === "ALL" ? "bg-slate-200 text-slate-800 border-slate-300" : "bg-slate-50 text-slate-500 border-slate-200 hover:border-slate-300"}`}
                    onClick={() => setStatusFilter("ALL")}
                  >All statuses</button>
                </div>
              </div>

              {loading && !orders && <div className="text-slate-400 text-sm">Loading…</div>}
              {orders && visibleOrders.length === 0 && (
                <div className="text-slate-400 text-sm text-center py-12">
                  {isToday
                    ? `No ${orderTypeFilter !== "ALL" ? orderTypeFilter.toLowerCase() + " " : ""}orders ${statusFilter === "PAID" ? "paid" : "yet"} on this shift.`
                    : `No ${orderTypeFilter !== "ALL" ? orderTypeFilter.toLowerCase() + " " : ""}${statusFilter === "PAID" ? "paid " : ""}orders in the selected date range.`}
                </div>
              )}

              <table className="table">
                <thead>
                  <tr>
                    <th className="w-24">Date</th>
                    <th className="w-20">Time</th>
                    <th>Order #</th>
                    <th className="w-20">Box</th>
                    <th className="w-24">Status</th>
                    <th className="text-right w-24">Discount</th>
                    <th className="text-right w-28">Total</th>
                    <th className="w-32">Payment</th>
                    <th className="w-16 text-center">Print</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((o) => (
                    <OrderRow
                      key={o.id}
                      order={o}
                      expanded={expandedOrderId === o.id}
                      items={orderItemsCache[o.id]}
                      onToggle={() => toggleExpand(o.id)}
                      onPrint={() => void reprintOrder(o)}
                      printing={printingId === o.id}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === "boxes" && (() => {
            // Compute per-box stats from all paid orders
            type BoxStat = { boxNumber: number; label: string; sale: number; done: number };
            const boxMap = new Map<number, BoxStat>();
            for (let i = 1; i <= BOX_COUNT; i++) {
              boxMap.set(i, { boxNumber: i, label: getBoxLabel(i), sale: 0, done: 0 });
            }
            for (const o of paidOrders) {
              const box = o.waiterBox;
              if (!box) continue;
              const stat = boxMap.get(box) ?? { boxNumber: box, label: getBoxLabel(box), sale: 0, done: 0 };
              stat.sale += Number(o.total);
              stat.done += 1;
              boxMap.set(box, stat);
            }
            const boxStats = [...boxMap.values()].filter((s) => s.done > 0 || true).sort((a, b) => b.sale - a.sale);
            const activeBoxes = boxStats.filter((s) => s.done > 0);
            const totalBoxSale = boxStats.reduce((s, b) => s + b.sale, 0);

            return (
              <div>
                {loading && !orders && <div className="text-slate-400 text-sm">Loading…</div>}
                {orders && activeBoxes.length === 0 && (
                  <div className="text-slate-400 text-sm text-center py-12">No paid orders yet.</div>
                )}
                {orders && activeBoxes.length > 0 && (
                  <>
                    <div className="mb-3 flex items-center justify-between bg-sjc-50 border border-sjc-200 rounded-lg p-3">
                      <div className="text-sm text-slate-700">
                        <b>{activeBoxes.length}</b> active boxes
                      </div>
                      <div className="text-sm">
                        <span className="text-slate-500">Total: </span>
                        <span className="font-mono font-bold text-slate-900">PKR {totalBoxSale.toLocaleString("en-PK", { maximumFractionDigits: 0 })}</span>
                      </div>
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th className="w-8">#</th>
                          <th>Box Name</th>
                          <th className="text-right w-32">Sale</th>
                          <th className="text-right w-24">Orders Done</th>
                        </tr>
                      </thead>
                      <tbody>
                        {boxStats.map((s) => (
                          <tr key={s.boxNumber} className={s.done === 0 ? "opacity-35" : ""}>
                            <td className="font-mono text-xs text-slate-400">{s.boxNumber}</td>
                            <td className="font-medium">{s.label}</td>
                            <td className="text-right font-mono">{s.done > 0 ? `PKR ${s.sale.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "—"}</td>
                            <td className="text-right font-mono">{s.done > 0 ? s.done : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            );
          })()}

          {tab === "items" && (
            <div>
              {orderTypeFilter !== "ALL" && (
                <div className={`mb-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${
                  orderTypeFilter === "CASH" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-violet-50 text-violet-700 border-violet-200"
                }`}>
                  Showing {orderTypeFilter === "CASH" ? "cash" : "credit"} orders only
                </div>
              )}
              {loading && !items && <div className="text-slate-400 text-sm">Loading…</div>}
              {items && items.length === 0 && (
                <div className="text-slate-400 text-sm text-center py-12">
                  {isToday
                    ? `Nothing sold via ${orderTypeFilter !== "ALL" ? orderTypeFilter.toLowerCase() + " orders" : "any order type"} yet.`
                    : `Nothing sold via ${orderTypeFilter !== "ALL" ? orderTypeFilter.toLowerCase() + " orders" : "any order type"} in the selected range.`}
                </div>
              )}

              {items && items.length > 0 && itemTotals && (
                <>
                  <div className="mb-3 flex items-center justify-between bg-sjc-50 border border-sjc-200 rounded-lg p-3">
                    <div className="text-sm text-slate-700">
                      <b>{items.length}</b> different items sold ·
                      total <b className="font-mono">{itemTotals.qty}</b> units
                    </div>
                    <div className="text-sm">
                      <span className="text-slate-500">Revenue: </span>
                      <span className="font-mono font-bold text-slate-900">PKR {itemTotals.revenue}</span>
                    </div>
                  </div>

                  <table className="table">
                    <thead>
                      <tr>
                        <th className="w-16">Code</th>
                        <th>Item</th>
                        <th className="w-20">Size</th>
                        <th className="text-right w-24">Qty sold</th>
                        <th className="text-right w-32">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((it) => (
                        <tr key={it.itemId} className={it.isMix ? "bg-amber-50/60" : ""}>
                          <td className="font-mono text-xs text-slate-400">{it.itemCode != null ? `#${it.itemCode}` : ""}</td>
                          <td className={it.isMix ? "font-medium text-amber-900" : ""}>
                            {displayItemName(it.name, it.size)}
                          </td>
                          <td>{it.size !== "NA" && <span className={`pill text-[10px] ${it.isMix ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-700"}`}>{it.size}</span>}</td>
                          <td className="text-right font-mono font-medium">{it.qty}</td>
                          <td className="text-right font-mono">PKR {it.revenue}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Cash in Counter popup ──────────────────────────────────────────────────

function CashCounterPopup({
  cashInCounter, openingCash, cashInTotal, cashOutTotal, cashMovements,
  editingOpeningCash, openingCashDraft, setOpeningCashDraft, setEditingOpeningCash, saveOpeningCash,
  movementType, setMovementType, movementAmount, setMovementAmount, movementReason, setMovementReason,
  movementBusy, addMovement, removeMovement, onClose,
}: {
  cashInCounter: number; openingCash: number; cashInTotal: number; cashOutTotal: number;
  cashMovements: CashMovement[];
  editingOpeningCash: boolean; openingCashDraft: string;
  setOpeningCashDraft: (v: string) => void; setEditingOpeningCash: (v: boolean) => void;
  saveOpeningCash: () => void | Promise<void>;
  movementType: "IN" | "OUT"; setMovementType: (v: "IN" | "OUT") => void;
  movementAmount: string; setMovementAmount: (v: string) => void;
  movementReason: string; setMovementReason: (v: string) => void;
  movementBusy: boolean;
  addMovement: () => void | Promise<void>;
  removeMovement: (id: string) => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card w-full max-w-lg p-0 rounded-xl border-2 border-indigo-200 bg-indigo-50">
        <div className="flex items-center justify-between px-4 py-3 border-b border-indigo-200">
          <div className="text-sm font-bold text-indigo-800">Cash in Counter</div>
          <button onClick={onClose} className="text-indigo-400 hover:text-indigo-700 text-xl leading-none">×</button>
        </div>

        <div className="p-4">
          <div className="text-center mb-4">
            <div className="font-mono font-bold text-indigo-900 text-2xl">
              PKR {cashInCounter.toLocaleString("en-PK", { maximumFractionDigits: 0 })}
            </div>
            <div className="text-[10px] text-indigo-400 mt-0.5">opening + total cash in hand + (cash out − cash in) − today's expense</div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            {/* Opening cash */}
            <div className="rounded-lg bg-white border border-indigo-200 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Opening Cash</div>
              {editingOpeningCash ? (
                <div className="flex items-center gap-1">
                  <input
                    type="number" autoFocus
                    className="input text-sm py-1 px-2 w-full"
                    value={openingCashDraft}
                    onChange={(e) => setOpeningCashDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void saveOpeningCash(); if (e.key === "Escape") setEditingOpeningCash(false); }}
                  />
                  <button className="text-xs px-2 py-1 rounded bg-indigo-600 text-white disabled:opacity-50" disabled={movementBusy} onClick={() => void saveOpeningCash()}>Save</button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-slate-900">PKR {openingCash.toLocaleString("en-PK", { maximumFractionDigits: 0 })}</span>
                  <button
                    className="text-xs text-indigo-600 hover:underline"
                    onClick={() => { setOpeningCashDraft(String(openingCash)); setEditingOpeningCash(true); }}
                  >Edit</button>
                </div>
              )}
            </div>
            {/* Cash borrowed in (liability) */}
            <div className="rounded-lg bg-white border border-indigo-200 px-3 py-2 text-center">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Cash Borrowed In</div>
              <div className="font-mono font-bold text-red-600">{cashInTotal > 0 ? `−PKR ${cashInTotal.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "—"}</div>
            </div>
            {/* Cash loaned out (asset) */}
            <div className="rounded-lg bg-white border border-indigo-200 px-3 py-2 text-center">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Cash Loaned Out</div>
              <div className="font-mono font-bold text-emerald-600">{cashOutTotal > 0 ? `+PKR ${cashOutTotal.toLocaleString("en-PK", { maximumFractionDigits: 0 })}` : "—"}</div>
            </div>
          </div>

          {/* Add a Cash In/Out entry */}
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <div className="flex rounded-lg overflow-hidden border border-indigo-300">
              <button
                className={`px-3 py-1.5 text-xs font-semibold ${movementType === "IN" ? "bg-red-600 text-white" : "bg-white text-slate-600"}`}
                onClick={() => setMovementType("IN")}
              >Cash In (borrowed)</button>
              <button
                className={`px-3 py-1.5 text-xs font-semibold ${movementType === "OUT" ? "bg-emerald-600 text-white" : "bg-white text-slate-600"}`}
                onClick={() => setMovementType("OUT")}
              >Cash Out (loaned)</button>
            </div>
            <input
              type="number" placeholder="Amount"
              className="input text-sm py-1 px-2 w-28"
              value={movementAmount}
              onChange={(e) => setMovementAmount(e.target.value)}
            />
            <input
              type="text" placeholder="Reason (optional)"
              className="input text-sm py-1 px-2 flex-1 min-w-[140px]"
              value={movementReason}
              onChange={(e) => setMovementReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void addMovement(); }}
            />
            <button
              className="text-xs px-3 py-1.5 rounded bg-indigo-600 text-white disabled:opacity-50"
              disabled={movementBusy || !movementAmount}
              onClick={() => void addMovement()}
            >Add</button>
          </div>

          {/* Entries list */}
          {cashMovements.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-auto">
              {cashMovements.map((m) => (
                <div key={m.id} className="flex items-center justify-between text-xs bg-white rounded px-2 py-1 border border-indigo-100">
                  <span className={`font-semibold ${m.type === "IN" ? "text-red-600" : "text-emerald-600"}`}>
                    {m.type === "IN" ? "Cash In" : "Cash Out"}
                  </span>
                  <span className="font-mono">PKR {Number(m.amount).toLocaleString("en-PK", { maximumFractionDigits: 0 })}</span>
                  <span className="text-slate-400 truncate flex-1 mx-2">{m.reason ?? ""}</span>
                  <button className="text-slate-400 hover:text-red-600" onClick={() => void removeMovement(m.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── One order row + expanded line items ──────────────────────────────────

type OrderLine = { name: string; size: string; qty: string; unitPrice: string; lineTotal: string };

function OrderRow({ order, expanded, items, onToggle, onPrint, printing }: {
  order: TodayOrder;
  expanded: boolean;
  items: OrderLine[] | undefined;
  onToggle: () => void;
  onPrint: () => void;
  printing: boolean;
}) {
  const date = new Date(order.businessDate).toLocaleDateString("en-PK", { day: "2-digit", month: "short" });
  const time = new Date(order.openedAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
  const statusPill =
    order.status === "PAID"      ? "bg-emerald-100 text-emerald-800" :
    order.status === "OPEN"      ? "bg-amber-100 text-amber-800"     :
    order.status === "CANCELLED" ? "bg-slate-200 text-slate-600"     :
                                   "bg-red-100 text-red-800";
  const methods = order.payments.length > 0
    ? order.payments.map((p) => `${p.method.toLowerCase()} ${p.amount}`).join(" · ")
    : "—";
  return (
    <>
      <tr className="cursor-pointer hover:bg-slate-50" onClick={onToggle}>
        <td className="text-xs font-mono text-slate-500">{date}</td>
        <td className="text-xs font-mono">{time}</td>
        <td className="font-medium">{order.orderNo}</td>
        <td className="text-xs text-slate-500">{order.waiterBox ? `Box ${order.waiterBox}` : "—"}</td>
        <td><span className={`pill text-[10px] ${statusPill}`}>{order.status}</span></td>
        <td className="text-right font-mono">{Number(order.discountAmount) > 0 ? `−${order.discountAmount}` : "—"}</td>
        <td className="text-right font-mono font-medium">PKR {order.total}</td>
        <td className="text-xs text-slate-600 truncate">{methods}</td>
        <td className="text-center">
          <button
            className="inline-flex items-center justify-center p-1.5 rounded bg-slate-200 hover:bg-blue-200 text-slate-700 hover:text-blue-800 disabled:opacity-40"
            disabled={printing}
            title="Reprint receipt"
            onClick={(e) => { e.stopPropagation(); onPrint(); }}
          >{printing ? <span className="text-xs">…</span> : <PrinterIcon className="w-4 h-4" />}</button>
        </td>
        <td className="text-slate-400 text-xs">{expanded ? "▾" : "▸"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={10} className="bg-slate-50 px-4 py-2">
            {!items && <div className="text-xs text-slate-400 py-2">Loading items…</div>}
            {items && items.length === 0 && <div className="text-xs text-slate-400 py-2">No items.</div>}
            {items && items.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-slate-500">
                  <tr><th className="text-left py-1">Item</th><th className="text-right">Qty</th><th className="text-right">Unit</th><th className="text-right">Line</th></tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i} className="border-t border-slate-200">
                      <td className="py-1">{displayItemName(it.name, it.size)}</td>
                      <td className="text-right font-mono">{Number(it.qty)}</td>
                      <td className="text-right font-mono">{it.unitPrice}</td>
                      <td className="text-right font-mono font-medium">{it.lineTotal}</td>
                    </tr>
                  ))}
                  {order.cancelReason && (
                    <tr><td colSpan={4} className="pt-2 text-amber-700">Cancel reason: {order.cancelReason}</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
