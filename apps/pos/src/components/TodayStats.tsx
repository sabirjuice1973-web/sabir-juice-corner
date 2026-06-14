import { useEffect, useState } from "react";
import { api } from "../api";
import { ORDERS_CHANGED } from "../lib/events";

/**
 * Today's running totals — paid orders count + sales total — refreshed every
 * 30 seconds. Sits in the POS header so the owner can see the day's progress
 * at a glance without leaving the billing screen.
 *
 * Counts only PAID orders so unfinished box rows don't inflate the figure.
 */
type Stats = {
  orderCount: number;
  salesTotal: string;
  byMethod: { cash: string; card: string; wallet: string; credit: string; bank: string };
};

export function TodayStats({ shiftId, onClick }: { shiftId: string; onClick?: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchOnce() {
      try {
        const r = await api.todayStats(shiftId);
        if (!cancelled) setStats(r);
      } catch {
        // Silent: stale data is fine, fetch retries on the next interval.
      }
    }
    fetchOnce();
    // Background poll as a safety net. The event listener below is the primary
    // refresh signal — pay/void emit ORDERS_CHANGED, which refetches instantly.
    // The 30-second poll covers external changes (a second terminal paying an
    // order on the same shift) that we can't observe locally.
    const id = setInterval(fetchOnce, 30_000);
    const onChange = () => { void fetchOnce(); };
    window.addEventListener(ORDERS_CHANGED, onChange);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener(ORDERS_CHANGED, onChange);
    };
  }, [shiftId]);

  if (!stats) {
    return <span className="text-xs text-slate-700 px-2">Loading…</span>;
  }

  const sales = Math.round(Number(stats.salesTotal));
  const cash = Math.round(Number(stats.byMethod.cash));

  // The widget is also the entry point to the full Today's Sales panel — clicking
  // anywhere on it opens the modal with per-order + per-item breakdowns. Visually
  // we hint at this with a small ▸ chevron and a hover lift; without it owners
  // tended to overlook the panel because the stats already "looked like a panel".
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex items-center gap-3 px-3 py-1 rounded-lg bg-white/40 border border-slate-900/10 text-slate-900 hover:bg-white/70 hover:border-accent-400 transition-colors text-left cursor-pointer disabled:cursor-default"
      title={onClick ? "Click to see today's orders + item breakdown" : `Cash ${stats.byMethod.cash} · Card ${stats.byMethod.card} · Wallet ${stats.byMethod.wallet} · Credit ${stats.byMethod.credit}`}
    >
      <div className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-wider text-slate-700">Today's sales</span>
        <span className="font-mono font-bold text-base">PKR {sales.toLocaleString("en-PK")}</span>
      </div>
      <div className="flex flex-col leading-tight text-right">
        <span className="text-[10px] uppercase tracking-wider text-slate-700">Orders</span>
        <span className="font-mono font-bold text-base">{stats.orderCount}</span>
      </div>
      <div className="flex flex-col leading-tight text-right border-l border-slate-900/10 pl-3">
        <span className="text-[10px] uppercase tracking-wider text-slate-700">Cash</span>
        <span className="font-mono text-sm">{cash.toLocaleString("en-PK")}</span>
      </div>
      {onClick && <span className="text-accent-700 font-bold text-lg leading-none" aria-hidden>›</span>}
    </button>
  );
}
