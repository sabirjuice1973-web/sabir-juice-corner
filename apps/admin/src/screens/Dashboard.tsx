import { useEffect, useState } from "react";
import { api } from "../api";
import type { Screen } from "../App";

export function Dashboard({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const [counts, setCounts] = useState<{ organizations: number; items: number; branches: number } | null>(null);
  const [alertSummary, setAlertSummary] = useState<{ CRITICAL: number; HIGH: number; MEDIUM: number; LOW: number } | null>(null);

  useEffect(() => {
    api<{ counts: any }>("GET", "/health/db").then((r) => setCounts(r.counts)).catch(() => {});
    api<{ open: any }>("GET", "/alerts/summary?days=7").then((r) => setAlertSummary(r.open)).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Branches" value={counts?.branches} color="blue"
          icon={<><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 9h1M9 13h1M14 9h1M14 13h1" /></>} />
        <Stat label="Menu items" value={counts?.items} color="amber"
          icon={<><path d="M3 3h18v4H3z" /><path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7" /><line x1="10" y1="12" x2="14" y2="12" /></>} />
        <Stat label="Organizations" value={counts?.organizations} color="emerald"
          icon={<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>} />
      </div>

      {alertSummary && (alertSummary.CRITICAL + alertSummary.HIGH + alertSummary.MEDIUM + alertSummary.LOW) > 0 && (
        <div className="card p-4 border-l-4 border-amber-400">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-amber-800">Open alerts (last 7 days)</div>
              <div className="text-sm text-slate-600 mt-1">
                {alertSummary.CRITICAL > 0 && <span className="mr-3"><b className="text-red-700">{alertSummary.CRITICAL}</b> critical</span>}
                {alertSummary.HIGH > 0 && <span className="mr-3"><b className="text-red-700">{alertSummary.HIGH}</b> high</span>}
                {alertSummary.MEDIUM > 0 && <span className="mr-3"><b className="text-amber-700">{alertSummary.MEDIUM}</b> medium</span>}
                {alertSummary.LOW > 0 && <span><b className="text-slate-700">{alertSummary.LOW}</b> low</span>}
              </div>
            </div>
            <button className="btn-secondary text-sm" onClick={() => onNavigate("alerts")}>Review →</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Card title="Daily operations" actions={[
          { label: "Record production batch",  to: "production" },
          { label: "Dispatch transfer",        to: "transfers" },
          { label: "Receive goods (GRN)",      to: "purchases" },
          { label: "Check stock levels",       to: "stockLevels" },
        ]} onNavigate={onNavigate} />
        <Card title="Catalog & setup" actions={[
          { label: "Manage raw materials",     to: "rawMaterials" },
          { label: "Manage suppliers",         to: "suppliers" },
          { label: "Create / edit recipes",    to: "recipes" },
        ]} onNavigate={onNavigate} />
      </div>

      <div className="card p-4 text-sm text-slate-600">
        <div className="font-medium text-slate-800 mb-1">What this admin app does today</div>
        Manage raw materials, suppliers, purchase orders, GRNs, production batches, recipes, and transfers.
        After you've created recipes, every paid order at the POS automatically deducts ingredients from
        the branch's counter location — visible in <a href="#" onClick={(e) => { e.preventDefault(); onNavigate("stockLevels"); }} className="underline text-sjc-700">Stock levels</a>.
      </div>
    </div>
  );
}

const STAT_COLORS = {
  blue:    { bg: "bg-blue-50", text: "text-blue-600" },
  amber:   { bg: "bg-amber-50", text: "text-amber-600" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-600" },
};

function Stat({ label, value, icon, color }: { label: string; value: number | undefined; icon: React.ReactNode; color: keyof typeof STAT_COLORS }) {
  const c = STAT_COLORS[color];
  return (
    <div className="card p-4 flex items-center gap-3.5">
      <div className={`w-11 h-11 rounded-xl ${c.bg} ${c.text} flex items-center justify-center shrink-0`}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
      </div>
      <div className="min-w-0">
        <div className="text-xs text-slate-500 uppercase tracking-wide font-medium">{label}</div>
        <div className="text-2xl font-bold mt-0.5 text-slate-900">{value ?? "—"}</div>
      </div>
    </div>
  );
}

function Card({ title, actions, onNavigate }: { title: string; actions: { label: string; to: Screen }[]; onNavigate: (s: Screen) => void }) {
  return (
    <div className="card p-4">
      <div className="font-semibold mb-3 text-slate-800">{title}</div>
      <div className="space-y-0.5">
        {actions.map((a) => (
          <button key={a.to} onClick={() => onNavigate(a.to)}
            className="group flex items-center justify-between w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 text-sm text-slate-700 transition-colors">
            {a.label}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              className="text-slate-300 group-hover:text-accent-600 group-hover:translate-x-0.5 transition-all shrink-0">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
