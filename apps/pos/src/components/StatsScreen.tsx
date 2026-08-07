import { useEffect, useState } from "react";
import { api } from "../api";
import type { TodayOrder, PartnerAccount, LedgerEntry } from "../api";
import { BOX_LABELS } from "../pos/posState";
import { printDebtSummary } from "../pos/receipt";
import { PrinterIcon } from "./PrinterIcon";

type ItemRow = {
  itemId: string; itemCode: number | null; name: string; size: string;
  qty: string; revenue: string; isMix: boolean;
};
type AccSummary = { id: string; name: string; type: string; currentBalance: string };
type DebtGroup = { account: { id: string; position: number; name: string }; totalAmount: string; totalCashPaid: string };

// Glass-equivalent weights: MEDIUM = 1, JUMBO = 1.5
const GLASS_WT: Record<string, number> = { MEDIUM: 1, JUMBO: 1.5 };

// Full 24-hour day starting at 6am and wrapping past midnight (6,7,…,23,0,…,5)
// instead of stopping at 11pm — the shop trades until ~3am, so a range that
// dropped hours 0-5 was silently cutting off real late-night sales data.
const HOUR_SEQUENCE = Array.from({ length: 24 }, (_, i) => (i + 6) % 24);

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

export function StatsScreen({ shiftId, branchId, businessDate, onClose, standalone = false }: {
  shiftId: string;
  branchId: string;
  /** Shop's business date at the moment this window was opened — just a
   * fallback until the live value below resolves. */
  businessDate?: string | null;
  onClose: () => void;
  /** Rendered as the sole content of its own popup window (see StatsWindow) —
   * skips the click-outside-to-close backdrop since there's no POS behind it. */
  standalone?: boolean;
}) {
  // "Today"/the date pickers must mean the shop's BUSINESS date, not the raw
  // calendar date — the shop trades past midnight, so those two can differ
  // for a few hours around close. Don't trust the businessDate PROP alone
  // either — if this window was already open before the date rolled over,
  // it's frozen at whatever it was when the URL was built. Fetch the live
  // value fresh on mount, falling back to the prop (then the calendar date)
  // only until that resolves.
  const [todayStr, setTodayStr] = useState<string>(businessDate || new Date().toISOString().slice(0, 10));
  useEffect(() => {
    let cancelled = false;
    api.getBranchBusinessDate(branchId)
      .then((r) => { if (!cancelled) setTodayStr(r.businessDate); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [branchId]);

  const [fromDate, setFromDate] = useState<string | null>(null);
  const [toDate, setToDate]     = useState<string | null>(null);
  const isToday = fromDate === null && toDate === null;

  const [orders,    setOrders]    = useState<TodayOrder[] | null>(null);
  const [items,     setItems]     = useState<ItemRow[]    | null>(null);
  const [accounts,  setAccounts]  = useState<AccSummary[] | null>(null);
  const [allDebt,   setAllDebt]   = useState<{ total: number; paid: number } | null>(null);
  const [debtGroups, setDebtGroups] = useState<DebtGroup[] | null>(null);
  const [partnerSummary, setPartnerSummary] = useState<{
    partners: PartnerAccount[]; totalOwedToPartners: number; totalOwedByPartners: number;
    period: { gave: string; took: string; online: string; net: string } | null;
  } | null>(null);
  const [periodExpGroups, setPeriodExpGroups] = useState<DebtGroup[] | null>(null);
  const [yestRev,   setYestRev]   = useState<number | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [dailyHisaabId, setDailyHisaabId] = useState<string | null>(null);
  const [dailyHisaabEntries, setDailyHisaabEntries] = useState<LedgerEntry[] | null>(null);
  const [salaryAccountId, setSalaryAccountId] = useState<string | null>(null);
  const [salaryAccountEntries, setSalaryAccountEntries] = useState<LedgerEntry[] | null>(null);
  const [latePayments, setLatePayments] = useState<{ amount: string; discount: string } | null>(null);

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
        setDebtGroups(debtRes.groups as DebtGroup[]);
        setPeriodExpGroups(expRes.groups as DebtGroup[]);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e.body?.error || e.message || "Failed to load statistics");
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftId, branchId, fromDate, toDate, todayStr]);

  // Partner Accounts balances — all-time/live like allDebt (unaffected by
  // the date filter) — plus a period-scoped gave/took/online breakdown for
  // the selected range, used to correct Net Earning below. Fetched
  // separately from the main Promise.all so a 403 for a non-owner cashier
  // doesn't blow up the rest of the stats page.
  useEffect(() => {
    let cancelled = false;
    const from = fromDate ?? todayStr;
    const to = toDate ?? todayStr;
    api.partnerAccountsSummary(branchId, { from, to })
      .then((r) => { if (!cancelled) setPartnerSummary(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [branchId, fromDate, toDate, todayStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Daily Hisaab (position 1) and Salary (position 2) account ids — resolved
  // once per branch, then reused to pull each account's entries for whatever
  // period is selected. Two separate accounts: Home/Shop Expense come from
  // Daily Hisaab, but Salaries is its own dedicated account — Daily Hisaab's
  // total is NOT the same figure (it also carries non-salary rows), confirmed
  // against the Salary account's own Account Report total.
  useEffect(() => {
    let cancelled = false;
    api.ledgerAccounts(branchId)
      .then((r) => {
        if (cancelled) return;
        setDailyHisaabId(r.accounts.find((a) => a.position === 1)?.id ?? null);
        setSalaryAccountId(r.accounts.find((a) => a.position === 2)?.id ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [branchId]);

  // Daily Hisaab entries for the selected period — source for the Home/Shop
  // Expense breakdown below. Salary account entries — source for Salaries.
  // And late payments for the same period, needed (alongside `orders`) to
  // compute Total Cash for this period, the denominator for percentages.
  useEffect(() => {
    if (!dailyHisaabId && !salaryAccountId) return;
    let cancelled = false;
    const from = fromDate ?? todayStr;
    const to = toDate ?? todayStr;
    if (dailyHisaabId) {
      api.ledgerEntries(dailyHisaabId, { from, to, limit: 5000 })
        .then((r) => { if (!cancelled) setDailyHisaabEntries(r.entries); })
        .catch(() => { if (!cancelled) setDailyHisaabEntries(null); });
    }
    if (salaryAccountId) {
      api.ledgerEntries(salaryAccountId, { from, to, limit: 5000 })
        .then((r) => { if (!cancelled) setSalaryAccountEntries(r.entries); })
        .catch(() => { if (!cancelled) setSalaryAccountEntries(null); });
    }
    api.latePaymentsSummary(branchId, from, to)
      .then((r) => { if (!cancelled) setLatePayments(r); })
      .catch(() => { if (!cancelled) setLatePayments({ amount: "0", discount: "0" }); });
    return () => { cancelled = true; };
  }, [dailyHisaabId, salaryAccountId, branchId, fromDate, toDate, todayStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Yesterday revenue comparison (only for "Today" view) — one business date
  // before todayStr, not one calendar date before now.
  useEffect(() => {
    if (!isToday) { setYestRev(null); return; }
    let cancelled = false;
    const yd = new Date(`${todayStr}T00:00:00Z`);
    yd.setUTCDate(yd.getUTCDate() - 1);
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
  }, [shiftId, isToday, todayStr]);

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
    for (const h of HOUR_SEQUENCE) {
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
  const busyHours = HOUR_SEQUENCE
    .filter((h) => hourCnt[h] > 0)
    .map((h) => ({ h, cnt: hourCnt[h] as number }));
  const maxBusy = Math.max(...busyHours.map((d) => d.cnt), 1);

  // Alert: no orders in the last 2 business hours. Guarded to roughly the
  // shop's real trading window (~11am to ~3am, i.e. NOT ~4am-8am) — and using
  // modulo so "the last 2 hours" wraps correctly past midnight instead of
  // indexing hourCnt[-1]/[-2] (silently false, since undefined !== 0) right
  // when the shop is normally still open.
  const nowH = new Date().getHours();
  const prevH1 = (nowH + 23) % 24;
  const prevH2 = (nowH + 22) % 24;
  const emptyAlert = isToday && (nowH >= 8 || nowH < 4) && hourCnt[prevH1] === 0 && hourCnt[prevH2] === 0;

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
  // Partner Accounts fold into shop debt: a positive partner balance means
  // the shop owes that partner (they put in more than they took out), which
  // is money payable by the shop just like a supplier's ledger balance.
  const partnerNet = partnerSummary ? partnerSummary.totalOwedToPartners - partnerSummary.totalOwedByPartners : 0;
  const shopDebt     = (allDebt ? allDebt.total - allDebt.paid : 0) + partnerNet;
  // Orders sitting in creditor accounts are money customers still owe the
  // shop — an asset offsetting what the shop itself owes suppliers/partners.
  const netShopPosition = shopDebt - totalCredit;

  // ── Derived: Home/Shop Expense & Salaries ─────────────────────────────────────
  // Home Expense / Shop Expense are singled out by Head within Daily Hisaab.
  // Salaries is a DIFFERENT account entirely (position 2, "Salary") — its own
  // total for the period, confirmed against that account's Account Report.
  const headIs = (e: LedgerEntry, name: string) => (e.headName ?? "").trim().toLowerCase() === name;
  const salariesTotal     = (salaryAccountEntries ?? []).reduce((s, e) => s + Number(e.total), 0);
  const shopExpenseTotal  = (dailyHisaabEntries ?? []).filter((e) => headIs(e, "shop expense")).reduce((s, e) => s + Number(e.total), 0);
  const homeExpenseTotal  = (dailyHisaabEntries ?? []).filter((e) => headIs(e, "home expense")).reduce((s, e) => s + Number(e.total), 0);

  // Total Cash for the selected period — same formula as the Sales screen's
  // Total Cash: gross cash-order subtotal minus discount, plus late payments
  // actually collected from credit accounts. Denominator for the percentages
  // below (e.g. "what share of the cash we took in went to salaries").
  const isCashOrder = (o: TodayOrder) => o.status === "PAID" && o.payments.length > 0 && o.payments.every((p) => p.method !== "CREDIT");
  const cashOrdersPeriod = (orders ?? []).filter(isCashOrder);
  const grossCashSalePeriod = cashOrdersPeriod.reduce((s, o) => s + Number(o.subtotal), 0);
  const cashDiscountPeriod  = cashOrdersPeriod.reduce((s, o) => s + Number(o.discountAmount), 0);
  const totalCashPeriod = grossCashSalePeriod - cashDiscountPeriod + Number(latePayments?.amount ?? 0);

  // ── Derived: Per-account shop debt breakdown ─────────────────────────────────
  const debtBreakdown = (debtGroups ?? [])
    .map((g) => ({ ...g.account, debt: Number(g.totalAmount) - Number(g.totalCashPaid) }))
    .filter((g) => g.debt !== 0)
    .sort((a, b) => a.position - b.position);

  // Partner Accounts rows, appended after ledger accounts so the breakdown
  // reads as one unified "who is the shop's debt owed to/by" list.
  const partnerBreakdown = (partnerSummary?.partners ?? [])
    .map((p) => ({ id: p.id, position: 100 + p.position, name: `${p.name} (Self Loan)`, debt: Number(p.balance) }))
    .filter((p) => p.debt !== 0);
  const fullDebtBreakdown = [...debtBreakdown, ...partnerBreakdown];

  // ── Derived: Expense by account, for the selected period ─────────────────────
  // Cash actually PAID out per account — not the total billed. Billed includes
  // amounts still owed, which isn't money that's left the till yet; paid is
  // the real expense incurred this period.
  const expenseByAccount = (periodExpGroups ?? [])
    .map((g) => ({ ...g.account, amount: Number(g.totalCashPaid) }))
    .filter((g) => g.amount !== 0)
    .sort((a, b) => b.amount - a.amount);

  // ── Date label ───────────────────────────────────────────────────────────────
  const dateLabel = isToday ? "Today"
    : !toDate || fromDate === toDate ? (fromDate ?? "")
    : `${fromDate} → ${toDate}`;

  return (
    <div
      className={`fixed inset-0 flex items-start justify-center z-50 overflow-auto ${standalone ? "bg-white p-0" : "bg-black/50 p-3"}`}
      onClick={standalone ? undefined : (e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`bg-white flex flex-col ${standalone ? "w-full h-full" : "rounded-2xl shadow-2xl w-full max-w-6xl my-2"}`}>

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

              </div>

              {/* ── Total Shop Debt — All-time, always live ── */}
              <div>
                <div className="flex items-center justify-between">
                  <SH>Total Shop Debt <Dim>all-time · always live · ignores date filter</Dim></SH>
                  {allDebt && (
                    <button
                      onClick={() => printDebtSummary({
                        totalBilled: allDebt.total,
                        totalPaid: allDebt.paid,
                        totalDebt: shopDebt,
                        breakdown: fullDebtBreakdown.map((g) => ({ position: g.position, name: g.name, debt: g.debt })),
                      })}
                      title="Print a thermal-slip summary of this debt breakdown"
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 hover:text-red-800 bg-white border border-red-200 hover:border-red-300 rounded-lg px-2.5 py-1 mb-2"
                    >
                      <PrinterIcon className="w-3.5 h-3.5" /> Print
                    </button>
                  )}
                </div>
                <div className="rounded-2xl border-2 border-red-200 bg-red-50 p-5">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-800">Payable by shop (suppliers, salaries, self loan)</div>
                      <div className="text-xs text-slate-500 mt-1">
                        Live outstanding balance across all ledger accounts, regardless of the selected date range.
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

                  {/* Receivable — orders sitting in creditor accounts that customers
                      still owe the shop for. Same live totalCredit as Credit Exposure
                      below, surfaced here too so payable and receivable sit side by side. */}
                  <div className="mt-4 pt-4 border-t border-red-200 flex items-center justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-800">Receivable from customers</div>
                      <div className="text-xs text-slate-500 mt-1">Outstanding balance across all creditor accounts — orders not yet paid for.</div>
                    </div>
                    <div className="text-3xl font-bold font-mono text-emerald-700 shrink-0">
                      {accounts ? pkr(totalCredit) : "—"}
                    </div>
                  </div>

                  <div className="mt-4 pt-4 border-t-2 border-red-300 flex items-center justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-900">Net shop position</div>
                      <div className="text-xs text-slate-500 mt-1">Payable minus receivable.</div>
                    </div>
                    <div className={`text-4xl font-bold font-mono shrink-0 ${netShopPosition > 0 ? "text-red-700" : "text-emerald-700"}`}>
                      {allDebt && accounts ? pkr(Math.abs(netShopPosition)) : "—"}
                      {allDebt && accounts && (
                        <div className="text-xs font-semibold text-right mt-0.5">
                          {netShopPosition > 0 ? "owed BY shop" : netShopPosition < 0 ? "owed TO shop" : "settled"}
                        </div>
                      )}
                    </div>
                  </div>

                  {fullDebtBreakdown.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-red-200 space-y-1.5">
                      {/* Values span too wide a range here (tens of thousands to
                          millions) for a bar's length to stay meaningful — a
                          plain color-coded list reads more honestly than a bar
                          that makes the smaller accounts invisible. */}
                      <div className="text-xs font-semibold text-slate-600 mb-2">Breakdown by account:</div>
                      {fullDebtBreakdown.map((g) => (
                        <div key={g.id} className="flex items-center justify-between text-sm">
                          <span className="text-slate-700 font-medium">{g.position}. {g.name}</span>
                          <span className={`font-mono font-bold ${g.debt > 0 ? "text-red-700" : "text-emerald-700"}`}>
                            {pkr(g.debt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* ── Credit Exposure — detail behind the Receivable figure above ── */}
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

              {/* ── Home/Shop Expense & Salaries ── */}
              <div>
                <SH>Home / Shop Expense &amp; Salaries <Dim>Daily Hisaab + Salary accounts · % of Total Cash this period</Dim></SH>
                <div className="card p-4">
                  {dailyHisaabEntries === null || salaryAccountEntries === null ? (
                    <div className="text-slate-400 text-sm text-center py-6">Loading…</div>
                  ) : homeExpenseTotal === 0 && shopExpenseTotal === 0 && salariesTotal === 0 ? (
                    <Empty>No entries for this period</Empty>
                  ) : (
                    <DonutChart
                      percentOf={totalCashPeriod}
                      // Violet/orange/blue instead of red/orange/blue — red and
                      // orange sit next to each other on the wheel and, as two
                      // big adjacent slices, blurred into one warm mass.
                      data={[
                        { label: "Home Expense", value: homeExpenseTotal, color: CAT_COLORS[6] },
                        { label: "Shop Expense", value: shopExpenseTotal, color: CAT_COLORS[1] },
                        { label: "Salaries",     value: salariesTotal,    color: CAT_COLORS[0] },
                      ]}
                    />
                  )}
                  <div className="pt-3 mt-3 border-t border-slate-100 text-xs text-slate-400">
                    Home Expense / Shop Expense = Daily Hisaab entries with that Head. Salaries = the Salary
                    account's own total for the period. % is each figure against Total Cash collected this
                    period ({pkr(totalCashPeriod)}).
                  </div>
                </div>
              </div>

              {/* ── S9.6: Expense by Account, for the selected period ── */}
              <div>
                <SH>Expense by Account <Dim>cash paid per account · selected period</Dim></SH>
                <div className="card p-4">
                  {periodExpGroups === null ? (
                    <div className="text-slate-400 text-sm text-center py-6">Loading…</div>
                  ) : expenseByAccount.length === 0 ? (
                    <Empty>No expense entries for this period</Empty>
                  ) : (
                    <DonutChart
                      centerLabel="Total paid"
                      data={expenseByAccount.map((g) => ({
                        label: `${g.position}. ${g.name}`,
                        value: g.amount,
                        // Color follows the account's fixed ledger position, not
                        // its rank in this period's sort — so an account keeps
                        // the same color across different date ranges. Position
                        // 9/10 fall back to a neutral gray past the 8 validated slots.
                        color: g.position >= 1 && g.position <= 8 ? CAT_COLORS[g.position - 1] : "#898781",
                      }))}
                    />
                  )}
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

// Fixed categorical hue order (validated: worst adjacent CVD ΔE 9.1, worst
// adjacent normal-vision ΔE 19.6 — see the dataviz skill's palette.md).
// Assigned by POSITION, never re-cycled/re-sorted by value.
const CAT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

// Donut chart — share-of-whole for a handful of categories, paired with a
// legend (color is never the only identity cue). No external library.
function DonutChart({ data, centerLabel, percentOf, size = 220, thickness = 34 }: {
  data: { label: string; value: number; color: string }[];
  /** Shown under the center total, e.g. "Total billed". Omit for charts where
   * the sum of the slices isn't itself a meaningful standalone figure. */
  centerLabel?: string;
  /** What the legend's % is computed against — defaults to the sum of the
   * slices. Pass this when the meaningful denominator is a DIFFERENT figure
   * (e.g. "% of Total Cash," where the slices don't add up to that total). */
  percentOf?: number;
  size?: number;
  thickness?: number;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const pctBase = percentOf ?? total;
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  const GAP = 3; // px gap between adjacent segments
  let cumulative = 0;

  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {total <= 0 ? (
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e1e0d9" strokeWidth={thickness} />
          ) : data.filter((d) => d.value > 0).map((d) => {
            const frac = d.value / total;
            const dash = Math.max(0, frac * C - GAP);
            const dashOffset = -cumulative;
            cumulative += frac * C;
            return (
              <circle
                key={d.label}
                cx={size / 2} cy={size / 2} r={r}
                fill="none" stroke={d.color} strokeWidth={thickness}
                strokeDasharray={`${dash} ${C - dash}`}
                strokeDashoffset={dashOffset}
                strokeLinecap="round"
              />
            );
          })}
        </g>
        {centerLabel && total > 0 && (
          <>
            <text x={size / 2} y={size / 2 - 5} textAnchor="middle" fontSize="22" fontWeight="700" fill="#0b0b0b">{pkr(total)}</text>
            <text x={size / 2} y={size / 2 + 18} textAnchor="middle" fontSize="12" fill="#898781">{centerLabel}</text>
          </>
        )}
      </svg>
      <div className="flex-1 min-w-[220px] space-y-4">
        {data.map((d) => (
          <div key={d.label} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
              <span className="font-semibold text-base truncate">{d.label}</span>
            </div>
            <span className="font-mono font-bold text-xl text-slate-900 shrink-0">
              {pkr(d.value)}
              <span className="text-sm font-semibold text-slate-500 ml-2">({pctBase > 0 ? ((d.value / pctBase) * 100).toFixed(1) : "0"}%)</span>
            </span>
          </div>
        ))}
      </div>
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
