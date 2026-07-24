import { useEffect, useState } from "react";
import { api } from "../api";
import type { TodayOrder } from "../api";
import { BOX_LABELS } from "../pos/posState";

type ItemRow = {
  itemId: string; itemCode: number | null; name: string; size: string;
  qty: string; revenue: string; isMix: boolean;
};
type AccSummary = { id: string; name: string; type: string; currentBalance: string };

// Glass-equivalent weights: MEDIUM = 1, JUMBO = 1.5
const GLASS_WT: Record<string, number> = { MEDIUM: 1, JUMBO: 1.5 };

function pkr(n: number) {
  return `PKR ${n.toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
}

function hLabel(h: number) {
  if (h === 0 || h === 24) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function boxName(box: number) {
  return BOX_LABELS[box] ?? `Box ${box}`;
}

// ─── Main component ────────────────────────────────────────────────────────────

export function StatsScreen({ shiftId, branchId, onClose }: {
  shiftId: string;
  branchId: string;
  onClose: () => void;
}) {
  const todayStr = new Date().toISOString().slice(0, 10);

  const [fromDate, setFromDate] = useState<string | null>(null);
  const [toDate, setToDate]     = useState<string | null>(null);
  const isToday = fromDate === null && toDate === null;

  const [orders,    setOrders]    = useState<TodayOrder[] | null>(null);
  const [items,     setItems]     = useState<ItemRow[]    | null>(null);
  const [accounts,  setAccounts]  = useState<AccSummary[] | null>(null);
  const [allDebt,   setAllDebt]   = useState<{ total: number; paid: number } | null>(null);
  const [periodExp, setPeriodExp] = useState<{ total: number; paid: number } | null>(null);
  const [yestRev,   setYestRev]   = useState<number | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  // Main data fetch
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setOrders(null);
    setItems(null);

    const from       = fromDate ?? undefined;
    const to         = toDate   ?? undefined;
    const periodFrom = fromDate ?? todayStr;
    const periodTo   = toDate   ?? todayStr;

    Promise.all([
      api.todayOrders(shiftId, from, to),
      api.itemSummary(shiftId, from, to),
      api.listAccounts(branchId),
      api.ledgerReport({ branchId }),
      api.ledgerReport({ branchId, from: periodFrom, to: periodTo }),
    ])
      .then(([ordRes, itemRes, accRes, debtRes, expRes]) => {
        if (cancelled) return;
        setOrders(ordRes.orders);
        setItems(itemRes.items);
        setAccounts(accRes.accounts as AccSummary[]);
        setAllDebt({ total: Number(debtRes.grandTotalAmount), paid: Number(debtRes.grandTotalCashPaid) });
        setPeriodExp({ total: Number(expRes.grandTotalAmount), paid: Number(expRes.grandTotalCashPaid) });
      })
      .catch((e: any) => {
        if (!cancelled) setError(e.body?.error || e.message || "Failed to load statistics");
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftId, branchId, fromDate, toDate]);

  // Yesterday revenue comparison (only for "Today" view)
  useEffect(() => {
    if (!isToday) { setYestRev(null); return; }
    let cancelled = false;
    const yd = new Date();
    yd.setDate(yd.getDate() - 1);
    const ydStr = yd.toISOString().slice(0, 10);
    api.todayOrders(shiftId, ydStr, ydStr)
      .then((r) => {
        if (!cancelled) {
          const t = r.orders.filter((o) => o.status === "PAID").reduce((s, o) => s + Number(o.total), 0);
          setYestRev(t);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [shiftId, isToday]);

  // ── Derived: Summary ────────────────────────────────────────────────────────
  const paid      = (orders ?? []).filter((o) => o.status === "PAID");
  const revenue   = paid.reduce((s, o) => s + Number(o.total), 0);
  const orderCnt  = paid.length;
  const aov       = orderCnt > 0 ? revenue / orderCnt : 0;
  const pctVsYest = yestRev !== null && yestRev > 0
    ? ((revenue - yestRev) / yestRev) * 100 : null;

  // ── Derived: Chart ──────────────────────────────────────────────────────────
  const dailyRevMap = new Map<string, number>();
  for (const o of paid) {
    const day = o.openedAt.slice(0, 10);
    dailyRevMap.set(day, (dailyRevMap.get(day) ?? 0) + Number(o.total));
  }
  const bestDay = [...dailyRevMap.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const isMultiDay = fromDate !== null && fromDate !== (toDate ?? fromDate);

  const chartData: { label: string; value: number }[] = [];
  if (isMultiDay) {
    for (const [day, rev] of [...dailyRevMap.entries()].sort()) {
      chartData.push({ label: day.slice(5).replace("-", "/"), value: rev });
    }
  } else {
    const hourly = new Array(24).fill(0);
    for (const o of paid) hourly[new Date(o.openedAt).getHours()] += Number(o.total);
    for (let h = 6; h < 24; h++) {
      chartData.push({ label: hLabel(h), value: hourly[h] });
    }
  }

  // ── Derived: Top 5 Items ────────────────────────────────────────────────────
  const glassMap = new Map<string, { name: string; glasses: number; revenue: number; isMix: boolean }>();
  for (const it of items ?? []) {
    const wt = GLASS_WT[it.size];
    if (!wt) continue;
    const g = wt * Number(it.qty);
    const prev = glassMap.get(it.name) ?? { name: it.name, glasses: 0, revenue: 0, isMix: it.isMix };
    glassMap.set(it.name, { ...prev, glasses: prev.glasses + g, revenue: prev.revenue + Number(it.revenue) });
  }
  const top5   = [...glassMap.values()].sort((a, b) => b.glasses - a.glasses).slice(0, 5);
  const maxG   = Math.max(top5[0]?.glasses ?? 1, 1);

  // ── Derived: Box Leaderboard ─────────────────────────────────────────────────
  const boxMap = new Map<number, { rev: number; cnt: number }>();
  for (const o of paid) {
    if (!o.waiterBox) continue;
    const p = boxMap.get(o.waiterBox) ?? { rev: 0, cnt: 0 };
    boxMap.set(o.waiterBox, { rev: p.rev + Number(o.total), cnt: p.cnt + 1 });
  }
  const boxStats  = [...boxMap.entries()].sort((a, b) => b[1].rev - a[1].rev).map(([box, d]) => ({ box, ...d }));
  const maxBoxRev = Math.max(boxStats[0]?.rev ?? 1, 1);

  // ── Derived: Busiest Hours ───────────────────────────────────────────────────
  const hourCnt = new Array(24).fill(0);
  for (const o of paid) hourCnt[new Date(o.openedAt).getHours()]++;
  const busyHours = Array.from({ length: 18 }, (_, i) => i + 6)
    .filter((h) => hourCnt[h] > 0)
    .map((h) => ({ h, cnt: hourCnt[h] as number }));
  const maxBusy = Math.max(...busyHours.map((d) => d.cnt), 1);

  // Alert: no orders in the last 2 business hours
  const nowH = new Date().getHours();
  const emptyAlert = isToday && nowH >= 8 && hourCnt[nowH - 1] === 0 && hourCnt[nowH - 2] === 0;

  // ── Derived: Size Mix ────────────────────────────────────────────────────────
  let medQty = 0, jumboQty = 0;
  for (const it of items ?? []) {
    if (it.size === "MEDIUM") medQty  += Number(it.qty);
    if (it.size === "JUMBO")  jumboQty += Number(it.qty);
  }
  const totalGlass = medQty + jumboQty;

  // ── Derived: Payment Split ───────────────────────────────────────────────────
  let cashRev = 0, creditRev = 0, fpRev = 0;
  for (const o of paid) {
    const isFP = o.waiterBox === 6;
    for (const p of o.payments) {
      const amt = Number(p.amount);
      if (p.method === "CREDIT") {
        if (isFP) fpRev += amt; else creditRev += amt;
      } else {
        cashRev += amt;
      }
    }
  }
  const payTotal = cashRev + creditRev + fpRev;

  // ── Derived: Credit Exposure ─────────────────────────────────────────────────
  const creditAccs = (accounts ?? []).filter((a) => Number(a.currentBalance) > 0);
  const totalCredit = creditAccs.reduce((s, a) => s + Number(a.currentBalance), 0);
  const top3 = [...creditAccs].sort((a, b) => Number(b.currentBalance) - Number(a.currentBalance)).slice(0, 3);

  // ── Derived: Debts ───────────────────────────────────────────────────────────
  const shopDebt     = allDebt   ? allDebt.total   - allDebt.paid   : 0;
  const periodExpOut = periodExp  ? periodExp.total - periodExp.paid : 0;

  // ── Date label ───────────────────────────────────────────────────────────────
  const dateLabel = isToday ? "Today"
    : !toDate || fromDate === toDate ? (fromDate ?? "")
    : `${fromDate} → ${toDate}`;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-3 overflow-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl flex flex-col my-2">

        {/* ── Header ── */}
        <div
          className="px-5 py-3 flex items-center justify-between gap-4 flex-wrap rounded-t-2xl sticky top-2 z-20"
          style={{ background: "linear-gradient(135deg,#022c22 0%,#064e3b 55%,#065f46 100%)" }}
        >
          <div>
            <div className="font-bold text-white text-lg tracking-tight">Statistics & Insights</div>
            <div className="text-xs text-emerald-300/70 mt-0.5">{dateLabel}</div>
          </div>

          {/* Date range selector */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => { setFromDate(null); setToDate(null); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                isToday ? "bg-white text-emerald-900 border-white" : "bg-white/10 text-white border-white/25 hover:bg-white/20"
              }`}
            >Today</button>
            <div className="flex items-center gap-1">
              <label className="text-xs text-white/60">From</label>
              <input
                type="date"
                max={todayStr}
                value={fromDate ?? todayStr}
                onChange={(e) => {
                  const v = e.target.value || todayStr;
                  setFromDate(v === todayStr && (!toDate || toDate === todayStr) ? null : v);
                  if (toDate && v > toDate) setToDate(v);
                }}
                className="input text-sm py-1 px-2 w-36"
              />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-xs text-white/60">To</label>
              <input
                type="date"
                max={todayStr}
                value={toDate ?? todayStr}
                onChange={(e) => {
                  const v = e.target.value || todayStr;
                  setToDate(v === todayStr && (!fromDate || fromDate === todayStr) ? null : v);
                  if (fromDate && v < fromDate) setFromDate(v);
                }}
                className="input text-sm py-1 px-2 w-36"
              />
            </div>
          </div>

          <button onClick={onClose} className="text-white/60 hover:text-white text-2xl leading-none flex-shrink-0">×</button>
        </div>

        {/* ── Body ── */}
        <div className="p-5 bg-slate-50 rounded-b-2xl space-y-5">

          {loading && (
            <div className="text-center text-slate-400 py-16 text-sm">Loading statistics…</div>
          )}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          {!loading && orders && (
            <>
              {/* No-orders-last-2-hours alert */}
              {emptyAlert && (
                <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 flex items-center gap-3">
                  <span className="text-xl">⚠️</span>
                  <div>
                    <div className="font-semibold text-amber-800 text-sm">No orders in the last 2 hours</div>
                    <div className="text-xs text-amber-600 mt-0.5">It's been quiet — check if everything is working normally.</div>
                  </div>
                </div>
              )}

              {/* ── S1: Overview cards ── */}
              <div>
                <SH>Overview</SH>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatCard color="emerald" label="Total Revenue" value={pkr(revenue)}>
                    {pctVsYest !== null
                      ? <span className={pctVsYest >= 0 ? "text-emerald-600 font-semibold" : "text-red-500 font-semibold"}>
                          {pctVsYest >= 0 ? "↑" : "↓"} {Math.abs(pctVsYest).toFixed(1)}% vs yesterday
                        </span>
                      : <span className="text-slate-400">{orderCnt} paid orders</span>}
                  </StatCard>
                  <StatCard color="blue" label="Total Orders" value={String(orderCnt)}>
                    <span className="text-slate-400">paid this period</span>
                  </StatCard>
                  <StatCard color="violet" label="Avg Order Value" value={pkr(aov)}>
                    <span className="text-slate-400">per order</span>
                  </StatCard>
                  {!isToday && bestDay
                    ? <StatCard color="orange" label="Best Day" value={bestDay[0]}>
                        <span className="text-orange-500 font-semibold">{pkr(bestDay[1])}</span>
                      </StatCard>
                    : <StatCard color="orange" label="Yesterday" value={yestRev !== null ? pkr(yestRev) : "—"}>
                        <span className="text-slate-400">total revenue</span>
                      </StatCard>
                  }
                </div>
              </div>

              {/* ── S2: Sales Chart ── */}
              <div>
                <SH>{isMultiDay ? "Daily Sales" : "Hourly Sales"}</SH>
                <div className="card p-4">
                  {chartData.every((d) => d.value === 0)
                    ? <div className="text-slate-400 text-sm text-center py-8">No sales data for this period</div>
                    : <BarChart data={chartData} color="#10b981" />
                  }
                </div>
              </div>

              {/* ── 2-column grid ── */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

                {/* ── S3: Top 5 Items ── */}
                <div>
                  <SH>Top 5 Items <Dim>medium = 1g · jumbo = 1.5g</Dim></SH>
                  <div className="card p-4 space-y-3">
                    {top5.length === 0
                      ? <Empty>No items sold</Empty>
                      : top5.map((it, i) => (
                          <div key={it.name} className="space-y-1">
                            <div className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-1.5 font-medium min-w-0">
                                <span className="text-slate-300 w-5 text-xs font-mono shrink-0">#{i + 1}</span>
                                <span className="truncate">{it.name}</span>
                                {it.isMix && <span className="text-[9px] bg-amber-100 text-amber-700 px-1 rounded shrink-0">mix</span>}
                              </div>
                              <div className="text-right shrink-0 ml-3">
                                <span className="font-bold text-emerald-700">
                                  {it.glasses % 1 === 0 ? it.glasses : it.glasses.toFixed(1)}g
                                </span>
                                <span className="text-xs text-slate-400 ml-1.5">{pkr(it.revenue)}</span>
                              </div>
                            </div>
                            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-emerald-500 rounded-full transition-all"
                                style={{ width: `${(it.glasses / maxG) * 100}%` }}
                              />
                            </div>
                          </div>
                        ))}
                  </div>
                </div>

                {/* ── S4: Box Leaderboard ── */}
                <div>
                  <SH>Box / Waiter Leaderboard</SH>
                  <div className="card p-4 space-y-3">
                    {boxStats.length === 0
                      ? <Empty>No data</Empty>
                      : boxStats.map((b, i) => (
                          <div key={b.box} className="space-y-1">
                            <div className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-1.5 font-medium">
                                <span className="text-slate-300 w-5 text-xs font-mono shrink-0">#{i + 1}</span>
                                <span>{boxName(b.box)}</span>
                              </div>
                              <div className="text-right shrink-0 ml-3">
                                <span className="font-bold text-blue-700">{pkr(b.rev)}</span>
                                <span className="text-xs text-slate-400 ml-1.5">{b.cnt} orders</span>
                              </div>
                            </div>
                            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full transition-all"
                                style={{ width: `${(b.rev / maxBoxRev) * 100}%` }}
                              />
                            </div>
                          </div>
                        ))}
                  </div>
                </div>

                {/* ── S5: Busiest Hours ── */}
                <div>
                  <SH>Busiest Hours <Dim>order count by hour</Dim></SH>
                  <div className="card p-4">
                    {busyHours.length === 0
                      ? <Empty>No orders yet</Empty>
                      : (
                          <div className="space-y-1.5">
                            {busyHours.map(({ h, cnt }) => (
                              <div key={h} className="flex items-center gap-2">
                                <span className="text-xs text-slate-500 w-10 text-right font-mono shrink-0">{hLabel(h)}</span>
                                <div className="flex-1 h-6 bg-slate-100 rounded-lg overflow-hidden">
                                  <div
                                    className="h-full bg-violet-500 rounded-lg flex items-center transition-all"
                                    style={{ width: `${Math.max(14, (cnt / maxBusy) * 100)}%` }}
                                  >
                                    <span className="text-[11px] text-white font-bold pl-2">{cnt}</span>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                  </div>
                </div>

                {/* ── S6: Size Mix ── */}
                <div>
                  <SH>Glass Size Mix</SH>
                  <div className="card p-4">
                    {totalGlass === 0
                      ? <Empty>No juice items sold</Empty>
                      : (
                          <div className="space-y-4">
                            {/* Stacked bar */}
                            <div className="h-9 rounded-xl overflow-hidden flex">
                              <div
                                className="h-full bg-emerald-500 flex items-center justify-center text-xs text-white font-bold transition-all"
                                style={{ width: `${(medQty / totalGlass) * 100}%` }}
                              >
                                {medQty > 0 && totalGlass > 0 && `${((medQty / totalGlass) * 100).toFixed(0)}%`}
                              </div>
                              <div
                                className="h-full bg-orange-500 flex items-center justify-center text-xs text-white font-bold transition-all"
                                style={{ width: `${(jumboQty / totalGlass) * 100}%` }}
                              >
                                {jumboQty > 0 && totalGlass > 0 && `${((jumboQty / totalGlass) * 100).toFixed(0)}%`}
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3 text-center">
                              <div>
                                <div className="flex items-center justify-center gap-1.5 mb-1">
                                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
                                  <span className="text-xs text-slate-500">Medium</span>
                                </div>
                                <div className="text-2xl font-bold text-slate-900">{medQty}</div>
                                <div className="text-xs text-slate-400">{totalGlass > 0 ? ((medQty / totalGlass) * 100).toFixed(0) : 0}% of glasses</div>
                              </div>
                              <div>
                                <div className="flex items-center justify-center gap-1.5 mb-1">
                                  <span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block" />
                                  <span className="text-xs text-slate-500">Jumbo</span>
                                </div>
                                <div className="text-2xl font-bold text-slate-900">{jumboQty}</div>
                                <div className="text-xs text-slate-400">{totalGlass > 0 ? ((jumboQty / totalGlass) * 100).toFixed(0) : 0}% of glasses</div>
                              </div>
                            </div>
                            <div className="text-center text-xs text-slate-400 border-t border-slate-100 pt-2">
                              {totalGlass} total glasses sold in this period
                            </div>
                          </div>
                        )}
                  </div>
                </div>

                {/* ── S7: Payment Split ── */}
                <div>
                  <SH>Payment Split</SH>
                  <div className="card p-4 space-y-3">
                    {payTotal === 0
                      ? <Empty>No payments</Empty>
                      : (
                          <>
                            {[
                              { label: "Cash",             value: cashRev,   color: "bg-emerald-500" },
                              { label: "Credit (Accounts)",value: creditRev, color: "bg-violet-500"  },
                              { label: "Food Panda",       value: fpRev,     color: "bg-orange-500"  },
                            ].filter((p) => p.value > 0).map((p) => (
                              <div key={p.label} className="space-y-1">
                                <div className="flex items-center justify-between text-sm">
                                  <span className="font-medium">{p.label}</span>
                                  <span className="font-mono font-bold shrink-0 ml-3">
                                    {pkr(p.value)}
                                    <span className="text-xs text-slate-400 ml-1">({((p.value / payTotal) * 100).toFixed(0)}%)</span>
                                  </span>
                                </div>
                                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full ${p.color} rounded-full transition-all`}
                                    style={{ width: `${(p.value / payTotal) * 100}%` }}
                                  />
                                </div>
                              </div>
                            ))}
                            <div className="pt-1 border-t border-slate-100 text-xs text-slate-400 text-right">
                              Total collected: {pkr(payTotal)}
                            </div>
                          </>
                        )}
                  </div>
                </div>

                {/* ── S8: Credit Exposure ── */}
                <div>
                  <SH>Credit Exposure <Dim>customers owe us — always live</Dim></SH>
                  <div className="card p-4">
                    {accounts === null
                      ? <div className="text-slate-400 text-sm">Loading…</div>
                      : (
                          <div className="space-y-3">
                            <div className="text-center py-2">
                              <div className={`text-3xl font-bold font-mono ${totalCredit > 0 ? "text-red-600" : "text-emerald-600"}`}>
                                {pkr(totalCredit)}
                              </div>
                              <div className="text-xs text-slate-500 mt-1">total outstanding across all creditor accounts</div>
                            </div>
                            {top3.length > 0 && (
                              <div className="space-y-2 border-t border-slate-100 pt-3">
                                <div className="text-xs text-slate-500 font-semibold">Top 3 by balance owed:</div>
                                {top3.map((acc) => (
                                  <div key={acc.id} className="flex items-center justify-between text-sm">
                                    <span className="text-slate-700 font-medium truncate">{acc.name}</span>
                                    <span className="font-mono font-bold text-red-600 ml-3 shrink-0">{pkr(Number(acc.currentBalance))}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {totalCredit === 0 && (
                              <div className="text-center text-xs text-emerald-600 font-medium">All accounts are settled ✓</div>
                            )}
                          </div>
                        )}
                  </div>
                </div>
              </div>

              {/* ── S9: Period Expenses ── */}
              <div>
                <SH>Expenses in Selected Period</SH>
                <div className="grid grid-cols-3 gap-3">
                  <div className="card p-4 text-center">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1.5">Total Expense</div>
                    <div className="text-xl font-bold text-slate-900 font-mono">{periodExp ? pkr(periodExp.total) : "—"}</div>
                    <div className="text-xs text-slate-400 mt-1">billed in ledger</div>
                  </div>
                  <div className="card p-4 text-center">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1.5">Paid</div>
                    <div className="text-xl font-bold text-emerald-700 font-mono">{periodExp ? pkr(periodExp.paid) : "—"}</div>
                    <div className="text-xs text-slate-400 mt-1">cash paid to suppliers</div>
                  </div>
                  <div className="card p-4 text-center border-2 border-orange-200 bg-orange-50">
                    <div className="text-[10px] text-orange-600 uppercase tracking-wider font-bold mb-1.5">Still to Pay</div>
                    <div className={`text-xl font-bold font-mono ${periodExpOut > 0 ? "text-orange-700" : "text-emerald-700"}`}>
                      {pkr(periodExpOut)}
                    </div>
                    <div className="text-xs text-orange-400 mt-1">from this period's entries</div>
                  </div>
                </div>
              </div>

              {/* ── S10: Total Shop Debt — All-time, always live ── */}
              <div>
                <SH>Total Shop Debt <Dim>all-time · always live · ignores date filter</Dim></SH>
                <div className="rounded-2xl border-2 border-red-200 bg-red-50 p-5">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-800">Total amount payable by shop since accounts were opened</div>
                      <div className="text-xs text-slate-500 mt-1">
                        This is the live outstanding balance across all ledger accounts, regardless of the selected date range.
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`text-4xl font-bold font-mono ${shopDebt > 0 ? "text-red-700" : "text-emerald-700"}`}>
                        {allDebt ? pkr(shopDebt) : "—"}
                      </div>
                      {allDebt && (
                        <div className="text-xs text-slate-500 mt-1">
                          {pkr(allDebt.total)} billed − {pkr(allDebt.paid)} paid
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small helper components ────────────────────────────────────────────────────

function SH({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">{children}</h3>;
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-slate-400 normal-case font-normal text-[10px] ml-1">{children}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-slate-400 text-sm text-center py-6">{children}</div>;
}

function StatCard({ label, value, color, children }: {
  label: string; value: string; color: "emerald" | "blue" | "violet" | "orange"; children?: React.ReactNode;
}) {
  const ring = { emerald: "border-emerald-200 bg-emerald-50", blue: "border-blue-200 bg-blue-50", violet: "border-violet-200 bg-violet-50", orange: "border-orange-200 bg-orange-50" }[color];
  const val  = { emerald: "text-emerald-900", blue: "text-blue-900", violet: "text-violet-900", orange: "text-orange-900" }[color];
  const sub  = { emerald: "text-emerald-600", blue: "text-blue-500", violet: "text-violet-500", orange: "text-orange-500" }[color];
  return (
    <div className={`rounded-xl border-2 px-4 py-3 text-center ${ring}`}>
      <div className={`text-[10px] uppercase tracking-wider font-bold ${sub}`}>{label}</div>
      <div className={`font-mono font-bold text-base mt-0.5 ${val}`}>{value}</div>
      {children && <div className={`text-[11px] mt-0.5 leading-tight ${sub}`}>{children}</div>}
    </div>
  );
}

// SVG bar chart — no external library
function BarChart({ data, color }: { data: { label: string; value: number }[]; color: string }) {
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const W = 800, H = 160, PL = 56, PB = 24, PT = 10, PR = 8;
  const cW = W - PL - PR;
  const cH = H - PB - PT;
  const slotW = cW / data.length;
  const barW  = Math.max(3, slotW * 0.65);

  function short(n: number) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
    return String(Math.round(n));
  }

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: PT + cH - f * cH,
    label: short(maxVal * f),
  }));

  // Show every Nth label when crowded
  const labelEvery = data.length <= 18 ? 1 : Math.ceil(data.length / 18);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
      {/* Gridlines + Y labels */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={PL} y1={t.y} x2={W - PR} y2={t.y} stroke="#e2e8f0" strokeWidth={i === 0 ? 1 : 1} />
          <text x={PL - 4} y={t.y + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{t.label}</text>
        </g>
      ))}

      {/* Bars + X labels */}
      {data.map((d, i) => {
        const barH = Math.max(d.value > 0 ? 2 : 0, (d.value / maxVal) * cH);
        const x    = PL + i * slotW + (slotW - barW) / 2;
        const y    = PT + cH - barH;
        return (
          <g key={i}>
            {d.value > 0 && (
              <rect x={x} y={y} width={barW} height={barH} fill={color} rx="2" opacity="0.82" />
            )}
            {i % labelEvery === 0 && (
              <text x={x + barW / 2} y={H - 5} textAnchor="middle" fontSize="9" fill="#94a3b8">{d.label}</text>
            )}
          </g>
        );
      })}

      {/* X axis line */}
      <line x1={PL} y1={PT + cH} x2={W - PR} y2={PT + cH} stroke="#cbd5e1" strokeWidth="1" />
    </svg>
  );
}
