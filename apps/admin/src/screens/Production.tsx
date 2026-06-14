import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal, Field } from "./RawMaterials";

type RawMaterial = { id: string; name: string; defaultUnit: { code: string } };
type Processed = { id: string; name: string; storageUnit: string; defaultGlassesPerUnit: string };
type Location = { id: string; name: string; type: string; branch: { code: string; name: string } };
type Batch = {
  id: string;
  batchNo: string;
  startedAt: string;
  branch: { name: string };
  supervisedBy: { fullName: string } | null;
  status: string;
  yieldSummary: { inputUnits: string; outputUnits: string; wastageUnits: string; totalInputCost: string };
};

export function Production() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [creating, setCreating] = useState(false);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [processed, setProcessed] = useState<Processed[]>([]);

  async function refresh() {
    const [b, p] = await Promise.all([
      api<{ batches: Batch[] }>("GET", "/production/batches"),
      api<{ processedProducts: Processed[] }>("GET", "/catalog/processed"),
    ]);
    setBatches(b.batches);
    setProcessed(p.processedProducts);
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Production</h1>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setCreatingProduct(true)}>+ New processed product</button>
          <button className="btn-primary" onClick={() => setCreating(true)}>+ New batch</button>
        </div>
      </div>

      <div className="card p-4">
        <div className="text-sm font-medium mb-2">Processed products (pulp / shopers)</div>
        <div className="flex flex-wrap gap-2">
          {processed.length === 0 && <div className="text-slate-400 text-sm">None yet — create one to start tracking pulp.</div>}
          {processed.map((p) => (
            <span key={p.id} className="pill bg-sjc-100 text-sjc-800">
              {p.name} <span className="ml-1 text-sjc-700/70">· {p.defaultGlassesPerUnit} glasses / {p.storageUnit}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Batch #</th><th>Branch</th><th>Inputs</th><th>Outputs</th><th>Wastage</th><th>Status</th><th>When</th></tr>
          </thead>
          <tbody>
            {batches.length === 0 && <tr><td colSpan={7} className="text-center text-slate-400 py-6">No batches recorded yet.</td></tr>}
            {batches.map((b) => (
              <tr key={b.id}>
                <td className="font-mono text-xs">{b.batchNo}</td>
                <td>{b.branch.name}</td>
                <td className="font-mono">{b.yieldSummary.inputUnits}</td>
                <td className="font-mono">{b.yieldSummary.outputUnits}</td>
                <td className="font-mono">{b.yieldSummary.wastageUnits}</td>
                <td><span className="pill bg-emerald-100 text-emerald-800">{b.status}</span></td>
                <td className="text-xs">{new Date(b.startedAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && <NewBatch onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} processedProducts={processed} />}
      {creatingProduct && <NewProcessedProduct onClose={() => setCreatingProduct(false)} onCreated={() => { setCreatingProduct(false); refresh(); }} />}
    </div>
  );
}

function NewProcessedProduct({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [glassesPerUnit, setGlassesPerUnit] = useState("12");
  const [shelfLife, setShelfLife] = useState("7");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api("POST", "/catalog/processed", { name, storageUnit: "shoper", defaultGlassesPerUnit: Number(glassesPerUnit), shelfLifeDays: Number(shelfLife) });
      onCreated();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <Modal title="New processed product" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name (e.g. Peach Pulp)"><input className="input w-full" autoFocus value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Default glasses per shoper"><input className="input w-full" inputMode="numeric" value={glassesPerUnit} onChange={(e) => setGlassesPerUnit(e.target.value.replace(/[^0-9.]/g, ""))} required /></Field>
        <Field label="Shelf life (days)"><input className="input w-full" inputMode="numeric" value={shelfLife} onChange={(e) => setShelfLife(e.target.value.replace(/[^0-9]/g, ""))} required /></Field>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1">Create</button>
        </div>
      </form>
    </Modal>
  );
}

type InputRow = { rawMaterialId: string; quantity: string; unitCode: string; costAtIntake: string };
type OutputRow = { processedProductId: string; outputQty: string; outputUnitCode: string };
type WastageRow = { quantity: string; unitCode: string; reason: string };

function NewBatch({ onClose, onCreated, processedProducts }: { onClose: () => void; onCreated: () => void; processedProducts: Processed[] }) {
  const [rawMaterials, setRawMaterials] = useState<RawMaterial[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [branchId, setBranchId] = useState("");
  const [sourceLocationId, setSourceLocationId] = useState("");
  const [destinationLocationId, setDestinationLocationId] = useState("");
  const [inputs, setInputs] = useState<InputRow[]>([{ rawMaterialId: "", quantity: "", unitCode: "kg", costAtIntake: "" }]);
  const [outputs, setOutputs] = useState<OutputRow[]>([{ processedProductId: "", outputQty: "", outputUnitCode: "shoper" }]);
  const [wastages, setWastages] = useState<WastageRow[]>([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ rawMaterials: RawMaterial[] }>("GET", "/raw-materials").then((r) => setRawMaterials(r.rawMaterials));
    api<{ locations: Location[] }>("GET", "/stock/locations").then((r) => {
      setLocations(r.locations);
      const ck = r.locations.find((l) => l.branch.code === "CK");
      if (ck) {
        setBranchId("1");
        setSourceLocationId(ck.id);
      }
    });
  }, []);

  // Filter locations by chosen branch
  const branchLocations = branchId
    ? locations.filter((l) => l.branch.code === (branchId === "1" ? "CK" : `B${Number(branchId) - 1}`))
    : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api("POST", "/production/batches", {
        branchId: Number(branchId),
        sourceLocationId: Number(sourceLocationId),
        destinationLocationId: Number(destinationLocationId),
        inputs: inputs.filter((i) => i.rawMaterialId && i.quantity).map((i) => ({
          rawMaterialId: Number(i.rawMaterialId),
          quantity: Number(i.quantity),
          unitCode: i.unitCode,
          costAtIntake: Number(i.costAtIntake) || 0,
        })),
        outputs: outputs.filter((o) => o.processedProductId && o.outputQty).map((o) => ({
          processedProductId: Number(o.processedProductId),
          outputQty: Number(o.outputQty),
          outputUnitCode: o.outputUnitCode,
        })),
        wastages: wastages.filter((w) => w.quantity).map((w) => ({ quantity: Number(w.quantity), unitCode: w.unitCode, reason: w.reason || undefined })),
        notes: notes || undefined,
      });
      onCreated();
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="New production batch" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Branch">
            <select className="input w-full" value={branchId} onChange={(e) => { setBranchId(e.target.value); setSourceLocationId(""); setDestinationLocationId(""); }}>
              <option value="">—</option>
              <option value="1">Central Kitchen</option>
            </select>
          </Field>
          <Field label="Source (where raw is drawn from)">
            <select className="input w-full" value={sourceLocationId} onChange={(e) => setSourceLocationId(e.target.value)}>
              <option value="">—</option>
              {branchLocations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.type})</option>)}
            </select>
          </Field>
          <Field label="Destination (where pulp is stored)">
            <select className="input w-full" value={destinationLocationId} onChange={(e) => setDestinationLocationId(e.target.value)}>
              <option value="">—</option>
              {branchLocations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.type})</option>)}
            </select>
          </Field>
        </div>

        <Section title="Inputs (raw materials consumed)" onAdd={() => setInputs([...inputs, { rawMaterialId: "", quantity: "", unitCode: "kg", costAtIntake: "" }])}>
          {inputs.map((row, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2">
              <select className="input col-span-5" value={row.rawMaterialId} onChange={(e) => updateAt(setInputs, inputs, idx, { rawMaterialId: e.target.value })}>
                <option value="">— pick raw material —</option>
                {rawMaterials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <input className="input col-span-2 font-mono" placeholder="qty" value={row.quantity} onChange={(e) => updateAt(setInputs, inputs, idx, { quantity: e.target.value.replace(/[^0-9.]/g, "") })} />
              <input className="input col-span-1" placeholder="unit" value={row.unitCode} onChange={(e) => updateAt(setInputs, inputs, idx, { unitCode: e.target.value })} />
              <input className="input col-span-3 font-mono" placeholder="cost per unit" value={row.costAtIntake} onChange={(e) => updateAt(setInputs, inputs, idx, { costAtIntake: e.target.value.replace(/[^0-9.]/g, "") })} />
              <button type="button" className="text-slate-400 hover:text-red-600 col-span-1" onClick={() => setInputs(inputs.filter((_, i) => i !== idx))}>×</button>
            </div>
          ))}
        </Section>

        <Section title="Outputs (processed products produced)" onAdd={() => setOutputs([...outputs, { processedProductId: "", outputQty: "", outputUnitCode: "shoper" }])}>
          {outputs.map((row, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2">
              <select className="input col-span-7" value={row.processedProductId} onChange={(e) => updateAt(setOutputs, outputs, idx, { processedProductId: e.target.value })}>
                <option value="">— pick processed product —</option>
                {processedProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input className="input col-span-3 font-mono" placeholder="qty" value={row.outputQty} onChange={(e) => updateAt(setOutputs, outputs, idx, { outputQty: e.target.value.replace(/[^0-9.]/g, "") })} />
              <input className="input col-span-1" placeholder="unit" value={row.outputUnitCode} onChange={(e) => updateAt(setOutputs, outputs, idx, { outputUnitCode: e.target.value })} />
              <button type="button" className="text-slate-400 hover:text-red-600 col-span-1" onClick={() => setOutputs(outputs.filter((_, i) => i !== idx))}>×</button>
            </div>
          ))}
        </Section>

        <Section title="Wastage (optional)" onAdd={() => setWastages([...wastages, { quantity: "", unitCode: "kg", reason: "" }])}>
          {wastages.length === 0 && <div className="text-slate-400 text-xs">No wastage recorded. Add a row if peels/pits etc. need tracking.</div>}
          {wastages.map((row, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2">
              <input className="input col-span-3 font-mono" placeholder="qty" value={row.quantity} onChange={(e) => updateAt(setWastages, wastages, idx, { quantity: e.target.value.replace(/[^0-9.]/g, "") })} />
              <input className="input col-span-2" placeholder="unit" value={row.unitCode} onChange={(e) => updateAt(setWastages, wastages, idx, { unitCode: e.target.value })} />
              <input className="input col-span-6" placeholder="reason" value={row.reason} onChange={(e) => updateAt(setWastages, wastages, idx, { reason: e.target.value })} />
              <button type="button" className="text-slate-400 hover:text-red-600 col-span-1" onClick={() => setWastages(wastages.filter((_, i) => i !== idx))}>×</button>
            </div>
          ))}
        </Section>

        <Field label="Notes (optional)"><input className="input w-full" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {error && <div className="text-sm text-red-600">{error}</div>}

        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Recording…" : "Record batch"}</button>
        </div>
      </form>
    </Modal>
  );
}

function Section({ title, children, onAdd }: { title: string; children: React.ReactNode; onAdd?: () => void }) {
  return (
    <div className="border border-slate-200 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{title}</div>
        {onAdd && <button type="button" className="text-xs text-sjc-700 hover:underline" onClick={onAdd}>+ Add row</button>}
      </div>
      {children}
    </div>
  );
}

function updateAt<T>(setter: (rows: T[]) => void, rows: T[], idx: number, patch: Partial<T>) {
  setter(rows.map((r, i) => i === idx ? { ...r, ...patch } : r));
}
