import { useEffect, useRef, useState } from "react";
import { api, type AuthUser } from "../api";
import { emitOrdersChanged } from "../lib/events";

/**
 * Business-date pill — lives above the box grid on the POS.
 *
 * Shows the branch's currently-active business date and, on click, opens an
 * inline calendar picker. Only OWNER or BRANCH_MANAGER can actually change it;
 * for any other role the pill is read-only and a tooltip explains why.
 *
 * Drift signal: re-renders the calendar drift every minute via the parent and
 * displays the gap when it's ≥ 1 day. The full drift banner is rendered by
 * Pos.tsx (separate component) — this pill just shows the local pill state.
 */

type Props = {
  branchId: string;
  user: AuthUser;
  // Lifts the current date up so the parent can show a banner when the drift
  // exceeds the warning threshold.
  onDateLoaded?: (yyyymmdd: string) => void;
  onDateChanged?: (yyyymmdd: string) => void;
};

const ALLOWED_ROLES = new Set(["OWNER", "BRANCH_MANAGER"]);

export function BusinessDatePill({ branchId, user, onDateLoaded, onDateChanged }: Props) {
  const [date, setDate] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the backend refuses the date change because OPEN orders are blocking
  // (409 with samples), we keep the pending-order list here to show the user
  // exactly which rows need to be cleared first.
  const [blockedSamples, setBlockedSamples] = useState<{ orderNo: string; waiterBox: number | null }[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const canEdit = user.roles?.some((r) => ALLOWED_ROLES.has(r.code)) ?? false;

  // Load initially + refresh every 5 minutes (covers the case where another
  // terminal at the same branch changed the date).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await api.getBranchBusinessDate(branchId);
        if (cancelled) return;
        setDate(r.businessDate);
        onDateLoaded?.(r.businessDate);
      } catch (e: any) {
        if (!cancelled) setError(e.body?.error || e.message || "Could not load business date");
      }
    }
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [branchId, onDateLoaded]);

  // Focus the date input when the picker opens
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  async function commitChange(next: string) {
    if (next === date) { setOpen(false); return; }
    setSaving(true); setError(null); setBlockedSamples(null);
    try {
      const r = await api.setBranchBusinessDate(branchId, next);
      setDate(r.businessDate);
      onDateChanged?.(r.businessDate);
      // The widget's "today's sales" view depends on the active business date,
      // so changing it should immediately re-fetch the stats / orders / item
      // summary — same channel pay/void use.
      emitOrdersChanged();
      setOpen(false);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not save date");
      // 409 with pending-order samples — show them so the cashier knows
      // exactly which rows to clear before the date can be rolled.
      if (Array.isArray(e.body?.samples)) setBlockedSamples(e.body.samples);
    } finally {
      setSaving(false);
    }
  }

  // Display: "Tue, 26 May 2026"
  const displayText = (() => {
    if (!date) return "Loading…";
    const [y, m, d] = date.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString("en-PK", {
      weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
    });
  })();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => canEdit && date && setOpen(!open)}
        disabled={!canEdit || !date}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border-2 text-sm font-medium transition-colors shadow-sm ${
          canEdit
            ? "border-emerald-400 bg-white text-slate-800 hover:bg-slate-50 cursor-pointer"
            : "border-white/30 bg-white/20 text-white cursor-default"
        }`}
        title={canEdit
          ? "Click to change the branch's business date — all new orders/shifts/expenses will use it"
          : "Only OWNER or BRANCH_MANAGER can change the business date"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Business date</span>
        <span className="font-mono font-bold text-slate-900">{displayText}</span>
        {canEdit && <span className="text-emerald-600">▾</span>}
      </button>

      {open && canEdit && date && (
        <div className="absolute top-full mt-2 z-30 right-0 card border-2 border-leaf-500 p-3 min-w-[300px] max-w-sm">
          <div className="text-xs text-slate-600 mb-2">
            Pick the date all new orders/shifts/expenses at this branch should be recorded under.
          </div>
          <input
            ref={inputRef}
            type="date"
            value={date}
            onChange={(e) => commitChange(e.target.value)}
            disabled={saving}
            max="9999-12-31"
            className="input w-full font-mono"
          />
          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mt-2 space-y-1">
              <div className="font-medium">{error}</div>
              {blockedSamples && blockedSamples.length > 0 && (
                <ul className="font-mono text-[11px] pl-3 list-disc space-y-0.5">
                  {blockedSamples.map((s) => (
                    <li key={s.orderNo}>
                      {s.orderNo}{s.waiterBox != null ? ` (Box ${s.waiterBox})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex gap-2 mt-3">
            <button onClick={() => setOpen(false)} className="btn-secondary flex-1 text-xs" disabled={saving}>Cancel</button>
            <button
              onClick={() => commitChange(new Date().toISOString().slice(0, 10))}
              className="btn-ghost flex-1 text-xs"
              disabled={saving}
              title="Set to today's calendar date"
            >
              Set to calendar today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
