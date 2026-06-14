import { useEffect, useState } from "react";
import { api } from "../api";

type Level = {
  locationId: string;
  location: { name: string; type: string; branch: { code: string; name: string } };
  stockableType: string;
  stockableId: string;
  name: string;
  quantity: string;
  unit: string;
  reorderLevel: string | null;
  glassesPerUnit: string | null;
  expectedGlasses: string | null;
};

export function StockLevels() {
  const [levels, setLevels] = useState<Level[]>([]);
  const [filter, setFilter] = useState<"ALL" | "RAW_MATERIAL" | "PROCESSED_PRODUCT">("ALL");
  const [lowOnly, setLowOnly] = useState(false);

  async function refresh() {
    const qs = new URLSearchParams();
    if (filter !== "ALL") qs.set("stockableType", filter);
    if (lowOnly) qs.set("lowStockOnly", "true");
    const r = await api<{ levels: Level[] }>("GET", `/stock/levels?${qs}`);
    setLevels(r.levels);
  }
  useEffect(() => { refresh(); }, [filter, lowOnly]);

  // Group by branch
  const byBranch = new Map<string, Level[]>();
  for (const l of levels) {
    const key = l.location.branch.name;
    if (!byBranch.has(key)) byBranch.set(key, []);
    byBranch.get(key)!.push(l);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Stock levels</h1>
        <div className="flex gap-2 items-center text-sm">
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value as any)}>
            <option value="ALL">All types</option>
            <option value="RAW_MATERIAL">Raw materials</option>
            <option value="PROCESSED_PRODUCT">Processed (pulp/shopers)</option>
          </select>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
            Low stock only
          </label>
          <button className="btn-secondary text-sm py-1.5" onClick={refresh}>Refresh</button>
        </div>
      </div>

      {byBranch.size === 0 && (
        <div className="card p-8 text-center text-slate-400">No stock records yet. Receive a GRN or complete a production batch.</div>
      )}

      {[...byBranch.entries()].map(([branch, rows]) => (
        <div key={branch} className="card">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="font-medium">{branch}</div>
            <div className="text-xs text-slate-500">{rows.length} item{rows.length === 1 ? "" : "s"}</div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Type</th>
                <th>Location</th>
                <th className="text-right">Quantity</th>
                <th className="text-right">Reorder at</th>
                <th className="text-right">Expected glasses</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const low = r.reorderLevel && Number(r.quantity) <= Number(r.reorderLevel);
                const negative = Number(r.quantity) < 0;
                return (
                  <tr key={`${r.locationId}-${r.stockableType}-${r.stockableId}`} className={negative ? "bg-red-50" : low ? "bg-amber-50" : ""}>
                    <td className="font-medium">{r.name}</td>
                    <td><span className="pill bg-slate-100 text-slate-700 text-xs">{r.stockableType.replace("_", " ")}</span></td>
                    <td className="text-xs text-slate-500">{r.location.name} ({r.location.type})</td>
                    <td className="text-right font-mono">
                      {r.quantity} <span className="text-slate-400 text-xs">{r.unit}</span>
                      {negative && <span className="ml-2 text-red-700 text-xs">NEGATIVE</span>}
                      {!negative && low && <span className="ml-2 text-amber-700 text-xs">LOW</span>}
                    </td>
                    <td className="text-right text-slate-500 font-mono text-xs">{r.reorderLevel ?? "—"}</td>
                    <td className="text-right font-mono text-xs text-sjc-700">{r.expectedGlasses ? `≈ ${r.expectedGlasses}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div className="card p-4 text-xs text-slate-500">
        <span className="text-red-700 font-medium">NEGATIVE</span> = you've sold more than was recorded as on-hand.
        That's the leakage signal — either the recipe is off, stock receipts are missing, or there's shrinkage.
      </div>
    </div>
  );
}
