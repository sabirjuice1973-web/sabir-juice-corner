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
        <Stat label="Branches" value={counts?.branches} />
        <Stat label="Menu items" value={counts?.items} />
        <Stat label="Organizations" value={counts?.organizations} />
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

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-3xl font-bold mt-1">{value ?? "—"}</div>
    </div>
  );
}

function Card({ title, actions, onNavigate }: { title: string; actions: { label: string; to: Screen }[]; onNavigate: (s: Screen) => void }) {
  return (
    <div className="card p-4">
      <div className="font-medium mb-3">{title}</div>
      <div className="space-y-1">
        {actions.map((a) => (
          <button key={a.to} onClick={() => onNavigate(a.to)} className="block w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 text-sm">
            → {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
