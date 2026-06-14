import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal, Field } from "./RawMaterials";

type RawMaterial = { id: string; name: string; defaultUnit: { code: string } };
type Supplier = { id: string; name: string };
type Location = { id: string; name: string; type: string; branch: { id: string; code: string; name: string } };
type Po = {
  id: string; poNo: string; status: string;
  supplier: { name: string };
  branch: { name: string };
  total: string;
  items: { rawMaterial: { name: string }; qty: string; unit: { code: string }; rate: string; amount: string }[];
  grns: { id: string; grnNo: string }[];
  createdAt: string;
};

const STATUS_COLOR: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  OPEN: "bg-blue-100 text-blue-800",
  PARTIALLY_RECEIVED: "bg-amber-100 text-amber-800",
  RECEIVED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-red-100 text-red-800",
};

export function Purchases() {
  const [list, setList] = useState<Po[]>([]);
  const [creating, setCreating] = useState(false);
  const [receivingFor, setReceivingFor] = useState<Po | null>(null);

  async function refresh() {
    const r = await api<{ orders: Po[] }>("GET", "/purchases/orders");
    setList(r.orders);
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Purchase orders</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ New PO</button>
      </div>

      <div className="card">
        <table className="table">
          <thead><tr><th>PO #</th><th>Supplier</th><th>Lines</th><th>Total</th><th>Status</th><th>GRNs</th><th></th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={7} className="text-center text-slate-400 py-6">No POs yet.</td></tr>}
            {list.map((po) => (
              <tr key={po.id}>
                <td className="font-mono text-xs">{po.poNo}</td>
                <td>{po.supplier.name}</td>
                <td className="text-xs">{po.items.length}</td>
                <td className="font-mono">{po.total}</td>
                <td><span className={`pill ${STATUS_COLOR[po.status] ?? "bg-slate-100 text-slate-700"}`}>{po.status}</span></td>
                <td className="text-xs">{po.grns.length} received</td>
                <td className="text-right">
                  {(po.status === "OPEN" || po.status === "PARTIALLY_RECEIVED") && (
                    <button className="btn-ghost text-xs" onClick={() => setReceivingFor(po)}>Receive (GRN)</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && <NewPo onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} />}
      {receivingFor && <NewGrn po={receivingFor} onClose={() => setReceivingFor(null)} onCreated={() => { setReceivingFor(null); refresh(); }} />}
    </div>
  );
}

function NewPo({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [rows, setRows] = useState<{ rawMaterialId: string; qty: string; unitCode: string; rate: string }[]>([
    { rawMaterialId: "", qty: "", unitCode: "kg", rate: "" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ suppliers: Supplier[] }>("GET", "/suppliers"),
      api<{ rawMaterials: RawMaterial[] }>("GET", "/raw-materials"),
    ]).then(([s, r]) => { setSuppliers(s.suppliers); setRawMaterials(r.rawMaterials); });
  }, []);

  const total = rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.rate) || 0), 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api("POST", "/purchases/orders", {
        supplierId: Number(supplierId),
        branchId: 1, // Central Kitchen by default
        items: rows.filter((r) => r.rawMaterialId && r.qty && r.rate).map((r) => ({
          rawMaterialId: Number(r.rawMaterialId),
          qty: Number(r.qty),
          unitCode: r.unitCode,
          rate: Number(r.rate),
        })),
      });
      onCreated();
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="New purchase order" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <Field label="Supplier">
          <select className="input w-full" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
            <option value="">—</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>

        <div className="border border-slate-200 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Lines</div>
            <button type="button" className="text-xs text-sjc-700 hover:underline" onClick={() => setRows([...rows, { rawMaterialId: "", qty: "", unitCode: "kg", rate: "" }])}>+ Add line</button>
          </div>
          {rows.map((r, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <select className="input col-span-5" value={r.rawMaterialId} onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, rawMaterialId: e.target.value } : x))}>
                <option value="">— raw material —</option>
                {rawMaterials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <input className="input col-span-2 font-mono" placeholder="qty" value={r.qty} onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, qty: e.target.value.replace(/[^0-9.]/g, "") } : x))} />
              <input className="input col-span-1" placeholder="unit" value={r.unitCode} onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, unitCode: e.target.value } : x))} />
              <input className="input col-span-2 font-mono" placeholder="rate" value={r.rate} onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, rate: e.target.value.replace(/[^0-9.]/g, "") } : x))} />
              <div className="col-span-1 font-mono text-xs">{((Number(r.qty) || 0) * (Number(r.rate) || 0)).toFixed(2)}</div>
              <button type="button" className="col-span-1 text-slate-400 hover:text-red-600" onClick={() => setRows(rows.filter((_, i) => i !== idx))}>×</button>
            </div>
          ))}
        </div>

        <div className="text-right text-lg">Total: <span className="font-mono font-bold">PKR {total.toFixed(2)}</span></div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Creating…" : "Create PO"}</button>
        </div>
      </form>
    </Modal>
  );
}

function NewGrn({ po, onClose, onCreated }: { po: Po; onClose: () => void; onCreated: () => void }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [rows, setRows] = useState(po.items.map((it) => ({
    rawMaterialId: "", qty: it.qty, unitCode: it.unit.code, rate: it.rate, name: it.rawMaterial.name,
  })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ locations: Location[] }>("GET", "/stock/locations"),
      api<{ rawMaterials: RawMaterial[] }>("GET", "/raw-materials"),
    ]).then(([l, m]) => {
      setLocations(l.locations);
      setRawMaterials(m.rawMaterials);
      // pre-select first central-store location
      const cs = l.locations.find((x) => x.type === "CENTRAL_STORE");
      if (cs) setLocationId(cs.id);
      // map names to ids
      setRows(po.items.map((it) => {
        const found = m.rawMaterials.find((rm) => rm.name === it.rawMaterial.name);
        return { rawMaterialId: found?.id ?? "", qty: it.qty, unitCode: it.unit.code, rate: it.rate, name: it.rawMaterial.name };
      }));
    });
  }, [po]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api("POST", "/purchases/grn", {
        poId: Number(po.id),
        branchId: 1, // CK
        locationId: Number(locationId),
        items: rows.filter((r) => r.qty && Number(r.qty) > 0 && r.rawMaterialId).map((r) => ({
          rawMaterialId: Number(r.rawMaterialId),
          qtyReceived: Number(r.qty),
          unitCode: r.unitCode,
          rate: Number(r.rate),
        })),
      });
      onCreated();
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Receive goods — ${po.poNo}`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <Field label="Receive into location">
          <select className="input w-full" value={locationId} onChange={(e) => setLocationId(e.target.value)} required>
            <option value="">—</option>
            {locations.filter((l) => l.branch.code === "CK").map((l) => <option key={l.id} value={l.id}>{l.name} ({l.type})</option>)}
          </select>
        </Field>
        <table className="table">
          <thead><tr><th>Item</th><th>Receiving qty</th><th>Unit</th><th>Rate (override if changed)</th></tr></thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx}>
                <td>{r.name}</td>
                <td><input className="input w-28 font-mono" value={r.qty} onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, qty: e.target.value.replace(/[^0-9.]/g, "") } : x))} /></td>
                <td><input className="input w-20" value={r.unitCode} onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, unitCode: e.target.value } : x))} /></td>
                <td><input className="input w-28 font-mono" value={r.rate} onChange={(e) => setRows(rows.map((x, i) => i === idx ? { ...x, rate: e.target.value.replace(/[^0-9.]/g, "") } : x))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Receiving…" : "Receive into stock"}</button>
        </div>
      </form>
    </Modal>
  );
}
