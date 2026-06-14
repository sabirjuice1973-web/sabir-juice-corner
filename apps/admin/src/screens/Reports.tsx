import { useEffect, useState } from "react";
import { api } from "../api";

type Branch = { id: string; code: string; name: string };
type VarianceRow = {
  productId: string; name: string; unit: string;
  totalIn: string; salesOut: string; wastageOut: string; transferOut: string;
  currentLevel: string; expectedClose: string;
  variance: string; variancePct: string;
  expectedGlasses: string; glassesSold: string; glassesVariance: string;
};
type PnL = {
  orderCount: number;
  sales: string; discounts: string; cogs: string; expenses: string;
  net: string; netMarginPct: string;
};
type ProfRow = {
  itemId: string; itemCode: number | null; name: string;
  qtySold: string; revenue: string; cogsPerUnit: string; cogsTotal: string;
  profit: string; marginPct: string;
};

const DEFAULT_FROM = () => {
  const d = new Date(); d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
};
const TODAY = () => new Date().toISOString().slice(0, 10);

const KNOWN_BRANCHES: Branch[] = [
  { id: "1", code: "CK", name: "Central Kitchen" },
  { id: "2", code: "B1", name: "Branch 1" },
  { id: "3", code: "B2", name: "Branch 2" },
  { id: "4", code: "B3", name: "Branch 3" },
];

type Tab = "variance" | "pnl" | "profitability";

export function Reports() {
  const [tab, setTab] = useState<Tab>("variance");
  const [branchId, setBranchId] = useState<string>("2");
  const [from, setFrom] = useState(DEFAULT_FROM());
  const [to, setTo] = useState(TODAY());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Reports</h1>
      </div>

      <div className="card p-4 flex flex-wrap gap-3 items-end text-sm">
        <label>
          <div className="text-xs text-slate-500 mb-1">Branch</div>
          <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {tab === "profitability" && <option value="">All branches</option>}
            {KNOWN_BRANCHES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label>
          <div className="text-xs text-slate-500 mb-1">From</div>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <div className="text-xs text-slate-500 mb-1">To</div>
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="ml-auto flex gap-1">
          <TabBtn active={tab === "variance"} onClick={() => setTab("variance")}>Variance / leakage</TabBtn>
          <TabBtn active={tab === "pnl"} onClick={() => setTab("pnl")}>Branch P&L</TabBtn>
          <TabBtn active={tab === "profitability"} onClick={() => setTab("profitability")}>Item profitability</TabBtn>
        </div>
      </div>

      {tab === "variance" && <Variance branchId={branchId} from={from} to={to} />}
      {tab === "pnl" && <Pnl branchId={branchId} from={from} to={to} />}
      {tab === "profitability" && <Profitability branchId={branchId} from={from} to={to} />}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${active ? "bg-sjc-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
      {children}
    </button>
  );
}

function Variance({ branchId, from, to }: { branchId: string; from: string; to: string }) {
  const [rows, setRows] = useState<VarianceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null); setError(null);
    api<{ rows: VarianceRow[] }>("GET", `/reports/variance?branchId=${branchId}&from=${from}&to=${to}`)
      .then((r) => setRows(r.rows)).catch((e) => setError(e.message));
  }, [branchId, from, to]);

  if (error) return <div className="card p-6 text-red-600">{error}</div>;
  if (!rows) return <div className="card p-6 text-slate-500">Loading…</div>;
  if (rows.length === 0) return <div className="card p-6 text-slate-400 text-center">No processed-product movement at this branch in the selected window.</div>;

  return (
    <div className="card">
      <div className="px-4 py-3 border-b border-slate-200 text-xs text-slate-500">
        Variance = (received − sold − wasted − transferred out) − current stock.
        Positive variance means stock disappeared (leakage signal). Negative means you sold more than was logged in.
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Product</th>
            <th className="text-right">Received</th>
            <th className="text-right">Sold</th>
            <th className="text-right">Wasted</th>
            <th className="text-right">Current</th>
            <th className="text-right">Variance</th>
            <th className="text-right">Expected glasses</th>
            <th className="text-right">Glasses sold</th>
            <th className="text-right">Glass variance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const v = Number(r.variance);
            const cls = v > 0.01 ? "bg-red-50" : v < -0.01 ? "bg-amber-50" : "";
            return (
              <tr key={r.productId} className={cls}>
                <td className="font-medium">{r.name}</td>
                <td className="text-right font-mono">{r.totalIn} <span className="text-slate-400 text-xs">{r.unit}</span></td>
                <td className="text-right font-mono">{r.salesOut}</td>
                <td className="text-right font-mono">{r.wastageOut}</td>
                <td className="text-right font-mono">{r.currentLevel}</td>
                <td className="text-right font-mono">
                  {r.variance} <span className="text-xs text-slate-500">({r.variancePct}%)</span>
                </td>
                <td className="text-right font-mono text-xs text-slate-500">{r.expectedGlasses}</td>
                <td className="text-right font-mono text-xs text-slate-500">{r.glassesSold}</td>
                <td className="text-right font-mono text-xs">{r.glassesVariance}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Pnl({ branchId, from, to }: { branchId: string; from: string; to: string }) {
  const [data, setData] = useState<PnL | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    api<PnL>("GET", `/reports/pnl?branchId=${branchId}&from=${from}&to=${to}`)
      .then(setData).catch((e) => setError(e.message));
  }, [branchId, from, to]);

  if (error) return <div className="card p-6 text-red-600">{error}</div>;
  if (!data) return <div className="card p-6 text-slate-500">Loading…</div>;
  const net = Number(data.net);
  return (
    <div className="card p-6">
      <div className="text-xs text-slate-500 mb-4">{data.orderCount} paid orders in window</div>
      <div className="grid grid-cols-2 gap-y-3 text-lg">
        <Line label="Sales"            value={data.sales} />
        <Line label="Discounts"        value={data.discounts} muted />
        <Line label="Cost of goods"    value={data.cogs} muted />
        <Line label="Expenses"         value={data.expenses} muted />
        <div className="col-span-2 border-t border-slate-200 my-2"></div>
        <Line label="Net profit"       value={data.net} big highlight={net >= 0 ? "good" : "bad"} />
        <Line label="Net margin"       value={`${data.netMarginPct}%`} big />
      </div>
    </div>
  );
}

function Line({ label, value, big, muted, highlight }: { label: string; value: string; big?: boolean; muted?: boolean; highlight?: "good" | "bad" }) {
  return (
    <>
      <div className={`${big ? "font-bold" : ""} ${muted ? "text-slate-500" : ""}`}>{label}</div>
      <div className={`text-right font-mono ${big ? "font-bold text-xl" : ""} ${muted ? "text-slate-500" : ""} ${highlight === "good" ? "text-emerald-700" : highlight === "bad" ? "text-red-700" : ""}`}>{value}</div>
    </>
  );
}

function Profitability({ branchId, from, to }: { branchId: string; from: string; to: string }) {
  const [rows, setRows] = useState<ProfRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null); setError(null);
    const qs = new URLSearchParams({ from, to });
    if (branchId) qs.set("branchId", branchId);
    api<{ rows: ProfRow[] }>("GET", `/reports/item-profitability?${qs}`).then((r) => setRows(r.rows)).catch((e) => setError(e.message));
  }, [branchId, from, to]);

  if (error) return <div className="card p-6 text-red-600">{error}</div>;
  if (!rows) return <div className="card p-6 text-slate-500">Loading…</div>;
  if (rows.length === 0) return <div className="card p-6 text-slate-400 text-center">No sales in window.</div>;

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr>
            <th>Code</th><th>Item</th>
            <th className="text-right">Sold</th>
            <th className="text-right">Revenue</th>
            <th className="text-right">COGS / unit</th>
            <th className="text-right">COGS total</th>
            <th className="text-right">Profit</th>
            <th className="text-right">Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const m = Number(r.marginPct);
            const margCls = m >= 30 ? "text-emerald-700" : m >= 15 ? "text-slate-700" : "text-red-700";
            return (
              <tr key={r.itemId}>
                <td className="font-mono text-xs">#{r.itemCode}</td>
                <td className="font-medium">{r.name}</td>
                <td className="text-right font-mono">{r.qtySold}</td>
                <td className="text-right font-mono">{r.revenue}</td>
                <td className="text-right font-mono text-xs text-slate-500">{r.cogsPerUnit}</td>
                <td className="text-right font-mono">{r.cogsTotal}</td>
                <td className="text-right font-mono font-medium">{r.profit}</td>
                <td className={`text-right font-mono font-medium ${margCls}`}>{r.marginPct}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="px-4 py-2 text-xs text-slate-500 border-t border-slate-100">
        Items without an active recipe show COGS = 0 and the full revenue as profit. Add recipes in the Recipes screen.
      </div>
    </div>
  );
}
