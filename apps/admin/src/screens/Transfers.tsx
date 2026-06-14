import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal, Field } from "./RawMaterials";

type Processed = { id: string; name: string };
type Location = { id: string; name: string; type: string; branch: { id: string; code: string; name: string } };
type Transfer = {
  id: string; transferNo: string;
  fromBranch: { code: string; name: string }; toBranch: { code: string; name: string };
  fromLocation: { name: string }; toLocation: { name: string };
  status: string;
  dispatchedAt: string | null; receivedAt: string | null;
  items: { id: string; stockableType: string; stockableId: string; qtySent: string; qtyReceived: string | null; varianceReason: string | null; unit: { code: string } }[];
};

const STATUS_COLOR: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  DISPATCHED: "bg-amber-100 text-amber-800",
  RECEIVED: "bg-emerald-100 text-emerald-800",
  VARIANCE: "bg-red-100 text-red-800",
  CLOSED: "bg-slate-200 text-slate-700",
};

export function Transfers() {
  const [list, setList] = useState<Transfer[]>([]);
  const [dispatching, setDispatching] = useState(false);
  const [receiving, setReceiving] = useState<Transfer | null>(null);

  async function refresh() {
    const r = await api<{ transfers: Transfer[] }>("GET", "/transfers");
    setList(r.transfers);
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Transfers</h1>
        <button className="btn-primary" onClick={() => setDispatching(true)}>+ Dispatch transfer</button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Transfer #</th><th>From → To</th><th>Items</th><th>Status</th><th>When</th><th></th></tr>
          </thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={6} className="text-center text-slate-400 py-6">No transfers yet.</td></tr>}
            {list.map((t) => (
              <tr key={t.id}>
                <td className="font-mono text-xs">{t.transferNo}</td>
                <td className="text-xs">{t.fromBranch.code} → {t.toBranch.code}</td>
                <td className="text-xs">{t.items.length} line{t.items.length === 1 ? "" : "s"}</td>
                <td><span className={`pill ${STATUS_COLOR[t.status]}`}>{t.status}</span></td>
                <td className="text-xs">{t.dispatchedAt ? new Date(t.dispatchedAt).toLocaleString() : "—"}</td>
                <td className="text-right">
                  {t.status === "DISPATCHED" && <button className="btn-ghost text-xs" onClick={() => setReceiving(t)}>Receive</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dispatching && <DispatchModal onClose={() => setDispatching(false)} onCreated={() => { setDispatching(false); refresh(); }} />}
      {receiving && <ReceiveModal transfer={receiving} onClose={() => setReceiving(null)} onReceived={() => { setReceiving(null); refresh(); }} />}
    </div>
  );
}

function DispatchModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [processed, setProcessed] = useState<Processed[]>([]);
  const [fromBranchId, setFromBranchId] = useState("");
  const [fromLocationId, setFromLocationId] = useState("");
  const [toBranchId, setToBranchId] = useState("");
  const [toLocationId, setToLocationId] = useState("");
  const [rows, setRows] = useState<{ processedProductId: string; qty: string }[]>([{ processedProductId: "", qty: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ locations: Location[] }>("GET", "/stock/locations"),
      api<{ processedProducts: Processed[] }>("GET", "/catalog/processed"),
    ]).then(([l, p]) => { setLocations(l.locations); setProcessed(p.processedProducts); });
  }, []);

  const branches = Array.from(new Map(locations.map((l) => [l.branch.id, l.branch])).values());
  const fromLocs = locations.filter((l) => l.branch.id === fromBranchId);
  const toLocs = locations.filter((l) => l.branch.id === toBranchId);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api("POST", "/transfers/dispatch", {
        fromBranchId: Number(fromBranchId),
        toBranchId: Number(toBranchId),
        fromLocationId: Number(fromLocationId),
        toLocationId: Number(toLocationId),
        items: rows.filter((r) => r.processedProductId && r.qty).map((r) => ({
          stockableType: "PROCESSED_PRODUCT",
          stockableId: Number(r.processedProductId),
          qty: Number(r.qty),
          unitCode: "shoper",
        })),
      });
      onCreated();
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Dispatch transfer" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Field label="From branch">
            <select className="input w-full" value={fromBranchId} onChange={(e) => { setFromBranchId(e.target.value); setFromLocationId(""); }}>
              <option value="">—</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="From location">
            <select className="input w-full" value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)}>
              <option value="">—</option>
              {fromLocs.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.type})</option>)}
            </select>
          </Field>
          <Field label="To branch">
            <select className="input w-full" value={toBranchId} onChange={(e) => { setToBranchId(e.target.value); setToLocationId(""); }}>
              <option value="">—</option>
              {branches.filter((b) => b.id !== fromBranchId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="To location">
            <select className="input w-full" value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}>
              <option value="">—</option>
              {toLocs.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.type})</option>)}
            </select>
          </Field>
        </div>

        <div className="border border-slate-200 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Shopers to send</div>
            <button type="button" className="text-xs text-sjc-700 hover:underline" onClick={() => setRows([...rows, { processedProductId: "", qty: "" }])}>+ Add row</button>
          </div>
          {rows.map((r, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2">
              <select className="input col-span-8" value={r.processedProductId} onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, processedProductId: e.target.value } : x))}>
                <option value="">— processed product —</option>
                {processed.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input className="input col-span-3 font-mono" placeholder="shopers" value={r.qty} onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, qty: e.target.value.replace(/[^0-9.]/g, "") } : x))} />
              <button type="button" className="col-span-1 text-slate-400 hover:text-red-600" onClick={() => setRows(rows.filter((_, i) => i !== idx))}>×</button>
            </div>
          ))}
        </div>

        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Dispatching…" : "Dispatch"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ReceiveModal({ transfer, onClose, onReceived }: { transfer: Transfer; onClose: () => void; onReceived: () => void }) {
  const [received, setReceived] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const li of transfer.items) m[li.id] = li.qtySent;
    return m;
  });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api("POST", `/transfers/${transfer.id}/receive`, {
        items: transfer.items.map((li) => ({
          transferItemId: Number(li.id),
          qtyReceived: Number(received[li.id] || 0),
          varianceReason: reasons[li.id] || undefined,
        })),
      });
      onReceived();
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Receive ${transfer.transferNo}`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <div className="text-xs text-slate-500">
          {transfer.fromBranch.name} → {transfer.toBranch.name} · into {transfer.toLocation.name}
        </div>
        <table className="table">
          <thead>
            <tr><th>Item</th><th>Sent</th><th>Received</th><th>Variance reason (if different)</th></tr>
          </thead>
          <tbody>
            {transfer.items.map((li) => {
              const sent = Number(li.qtySent);
              const got = Number(received[li.id] || 0);
              const diff = got - sent;
              return (
                <tr key={li.id}>
                  <td className="text-xs">{li.stockableType} #{li.stockableId}</td>
                  <td className="font-mono">{li.qtySent} {li.unit.code}</td>
                  <td>
                    <input className="input w-24 font-mono" inputMode="numeric" value={received[li.id]}
                           onChange={(e) => setReceived({ ...received, [li.id]: e.target.value.replace(/[^0-9.]/g, "") })} />
                    {diff !== 0 && <span className={`ml-2 text-xs ${diff < 0 ? "text-red-600" : "text-amber-600"}`}>{diff > 0 ? "+" : ""}{diff}</span>}
                  </td>
                  <td>
                    {diff !== 0 && (
                      <input className="input w-full text-xs" placeholder="reason for variance" value={reasons[li.id] || ""}
                             onChange={(e) => setReasons({ ...reasons, [li.id]: e.target.value })} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Recording…" : "Confirm receipt"}</button>
        </div>
      </form>
    </Modal>
  );
}
