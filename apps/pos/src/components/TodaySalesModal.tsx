import { useEffect, useState } from "react";
import { api, type TodayOrder } from "../api";
import { ORDERS_CHANGED } from "../lib/events";
import { displayItemName, BOX_LABELS, BOX_COUNT } from "../pos/posState";

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

export function TodaySalesModal({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
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

  const isToday = fromDate === null && toDate === null;

  // Fetch late cash (account payments collected today) — only meaningful for today
  useEffect(() => {
    if (!isToday) { setLateCashReceived(0); setLateDiscount(0); return; }
    let cancelled = false;
    api.todayStats(shiftId).then((s) => {
      if (!cancelled) {
        setLateCashReceived(Number(s.lateCashReceived));
        setLateDiscount(Number(s.lateDiscount));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [shiftId, isToday]);

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

                  {/* Row 2: late cash + late discount + total cash in hand (always shown; late cash/discount = 0 for historical dates) */}
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
                    <div className="col-span-2 rounded-xl border-2 border-teal-300 bg-teal-50 px-3 py-2.5 text-center flex flex-col items-center justify-center">
                      <div className="text-[10px] uppercase tracking-wider text-teal-600 font-bold">Total Cash in Hand</div>
                      <div className="font-mono font-bold text-teal-900 text-xl mt-0.5">PKR {totalCashInHand.toLocaleString("en-PK", { maximumFractionDigits: 0 })}</div>
                      <div className="text-[10px] text-teal-500 mt-0.5">cash − discount + late cash − late discount</div>
                    </div>
                  </div>
                </div>
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
                    <th className="w-28">Time</th>
                    <th>Order #</th>
                    <th className="w-20">Box</th>
                    <th className="w-24">Status</th>
                    <th className="text-right w-24">Discount</th>
                    <th className="text-right w-28">Total</th>
                    <th className="w-32">Payment</th>
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

// ─── One order row + expanded line items ──────────────────────────────────

type OrderLine = { name: string; size: string; qty: string; unitPrice: string; lineTotal: string };

function OrderRow({ order, expanded, items, onToggle }: {
  order: TodayOrder;
  expanded: boolean;
  items: OrderLine[] | undefined;
  onToggle: () => void;
}) {
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
        <td className="text-xs font-mono">{time}</td>
        <td className="font-medium">{order.orderNo}</td>
        <td className="text-xs text-slate-500">{order.waiterBox ? `Box ${order.waiterBox}` : "—"}</td>
        <td><span className={`pill text-[10px] ${statusPill}`}>{order.status}</span></td>
        <td className="text-right font-mono">{Number(order.discountAmount) > 0 ? `−${order.discountAmount}` : "—"}</td>
        <td className="text-right font-mono font-medium">PKR {order.total}</td>
        <td className="text-xs text-slate-600 truncate">{methods}</td>
        <td className="text-slate-400 text-xs">{expanded ? "▾" : "▸"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="bg-slate-50 px-4 py-2">
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
