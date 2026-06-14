import { useEffect, useState } from "react";
import { api } from "../api";

type RawMaterial = {
  id: string;
  name: string;
  category: string | null;
  isPerishable: boolean;
  reorderLevel: string | null;
  defaultUnit: { code: string; name: string };
};

export function RawMaterials() {
  const [list, setList] = useState<RawMaterial[]>([]);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    const r = await api<{ rawMaterials: RawMaterial[] }>("GET", "/raw-materials");
    setList(r.rawMaterials);
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Raw materials</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ New raw material</button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>Unit</th>
              <th>Reorder at</th>
              <th>Perishable</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-400 py-6">No raw materials yet.</td></tr>
            )}
            {list.map((m) => (
              <tr key={m.id}>
                <td className="font-medium">{m.name}</td>
                <td>{m.category ?? "—"}</td>
                <td><span className="pill bg-slate-100 text-slate-700">{m.defaultUnit.code}</span></td>
                <td>{m.reorderLevel ?? "—"}</td>
                <td>{m.isPerishable ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} />}
    </div>
  );
}

const UNIT_CODES = ["kg", "g", "l", "ml", "pc", "crate", "box"];

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("FRUIT");
  const [defaultUnitCode, setDefaultUnitCode] = useState("kg");
  const [reorderLevel, setReorderLevel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api("POST", "/raw-materials", {
        name, category, defaultUnitCode,
        reorderLevel: reorderLevel ? Number(reorderLevel) : undefined,
      });
      onCreated();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New raw material" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name"><input className="input w-full" autoFocus value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Category">
          <select className="input w-full" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="FRUIT">Fruit</option>
            <option value="DAIRY">Dairy</option>
            <option value="SUGAR">Sugar</option>
            <option value="PACKAGING">Packaging</option>
            <option value="OTHER">Other</option>
          </select>
        </Field>
        <Field label="Default unit">
          <select className="input w-full" value={defaultUnitCode} onChange={(e) => setDefaultUnitCode(e.target.value)}>
            {UNIT_CODES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Reorder level (optional)">
          <input className="input w-full" inputMode="numeric" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value.replace(/[^0-9.]/g, ""))} />
        </Field>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className={`card w-full ${wide ? "max-w-2xl" : "max-w-md"} p-6`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
