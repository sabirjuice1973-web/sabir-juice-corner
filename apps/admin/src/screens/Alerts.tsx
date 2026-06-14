import { useEffect, useState } from "react";
import { api } from "../api";

type Alert = {
  id: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  message: string;
  payload: any;
  createdAt: string;
  acknowledgedAt: string | null;
  rule: { code: string; name: string };
  branch: { id: string; code: string; name: string } | null;
};

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-800 border-red-300",
  HIGH: "bg-red-100 text-red-800 border-red-200",
  MEDIUM: "bg-amber-100 text-amber-800 border-amber-200",
  LOW: "bg-slate-100 text-slate-700 border-slate-200",
};

export function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [showAcked, setShowAcked] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);

  async function refresh() {
    const r = await api<{ alerts: Alert[] }>("GET", `/alerts?includeAcknowledged=${showAcked}`);
    setAlerts(r.alerts);
  }
  useEffect(() => { refresh(); }, [showAcked]);

  async function scan() {
    setScanning(true);
    try {
      const r = await api<{ created: number; total: number }>("POST", "/reports/anomalies/scan", { windowDays: 7 });
      setLastScan(`${new Date().toLocaleTimeString()} — ${r.created} new alert(s), ${r.total} signal(s) checked`);
      await refresh();
    } finally { setScanning(false); }
  }

  async function ack(id: string) {
    await api("POST", `/alerts/${id}/acknowledge`);
    refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Alerts</h1>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={showAcked} onChange={(e) => setShowAcked(e.target.checked)} /> Show acknowledged</label>
          <button className="btn-primary" onClick={scan} disabled={scanning}>{scanning ? "Scanning…" : "Run scan now"}</button>
        </div>
      </div>

      {lastScan && <div className="text-xs text-slate-500">Last scan: {lastScan}</div>}

      <div className="card p-4 text-sm text-slate-600">
        The anomaly engine looks for: excessive voids by a cashier, persistent cash variance,
        discount abuse, supplier rate jumps &gt;15%, batch wastage spikes &gt;15%, and negative
        on-hand stock (the leakage signal). It de-duplicates so re-running the scan won't
        create duplicate alerts for the same day.
      </div>

      {alerts.length === 0 ? (
        <div className="card p-8 text-center text-slate-400">No alerts. Run a scan to check now.</div>
      ) : (
        <div className="space-y-2">
          {alerts.map((a) => (
            <div key={a.id} className={`card p-4 border-l-4 ${SEVERITY_COLOR[a.severity].split(" ").find((c) => c.startsWith("border-"))}`}>
              <div className="flex items-start gap-3">
                <span className={`pill border ${SEVERITY_COLOR[a.severity]}`}>{a.severity}</span>
                <div className="flex-1">
                  <div className="font-medium">{a.message}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    {a.rule.name} ({a.rule.code}) {a.branch && `· ${a.branch.name}`} · {new Date(a.createdAt).toLocaleString()}
                  </div>
                </div>
                {!a.acknowledgedAt ? (
                  <button className="btn-secondary text-xs py-1" onClick={() => ack(a.id)}>Acknowledge</button>
                ) : (
                  <span className="text-xs text-slate-400">acked {new Date(a.acknowledgedAt).toLocaleDateString()}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
