import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal, Field } from "./RawMaterials";

type Supplier = { id: string; name: string; phone: string | null; paymentTermsDays: number; openingBalance: string };

export function Suppliers() {
  const [list, setList] = useState<Supplier[]>([]);
  const [creating, setCreating] = useState(false);
  const [ledgerFor, setLedgerFor] = useState<Supplier | null>(null);
  const [paying, setPaying] = useState<Supplier | null>(null);

  async function refresh() {
    const r = await api<{ suppliers: Supplier[] }>("GET", "/suppliers");
    setList(r.suppliers);
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Suppliers</h1>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ New supplier</button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Phone</th><th>Terms</th><th>Opening balance</th><th></th></tr>
          </thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={5} className="text-center text-slate-400 py-6">No suppliers yet.</td></tr>}
            {list.map((s) => (
              <tr key={s.id}>
                <td className="font-medium">{s.name}</td>
                <td>{s.phone ?? "—"}</td>
                <td>{s.paymentTermsDays} days</td>
                <td className="font-mono">{s.openingBalance}</td>
                <td className="text-right">
                  <button className="btn-ghost text-xs" onClick={() => setLedgerFor(s)}>Ledger</button>
                  <button className="btn-ghost text-xs" onClick={() => setPaying(s)}>Pay</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && <CreateSupplier onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} />}
      {ledgerFor && <LedgerModal supplier={ledgerFor} onClose={() => setLedgerFor(null)} />}
      {paying && <PayModal supplier={paying} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); refresh(); }} />}
    </div>
  );
}

function CreateSupplier({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("15");
  const [openingBalance, setOpeningBalance] = useState("0");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api("POST", "/suppliers", { name, phone, paymentTermsDays: Number(paymentTermsDays), openingBalance: Number(openingBalance) });
      onCreated();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Modal title="New supplier" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name"><input className="input w-full" autoFocus value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Phone"><input className="input w-full" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label="Payment terms (days)"><input className="input w-full" inputMode="numeric" value={paymentTermsDays} onChange={(e) => setPaymentTermsDays(e.target.value.replace(/[^0-9]/g, ""))} /></Field>
        <Field label="Opening balance (PKR)"><input className="input w-full" inputMode="numeric" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1">Create</button>
        </div>
      </form>
    </Modal>
  );
}

function LedgerModal({ supplier, onClose }: { supplier: Supplier; onClose: () => void }) {
  const [data, setData] = useState<{ events: any[]; balance: string } | null>(null);
  useEffect(() => {
    api<{ events: any[]; balance: string }>("GET", `/suppliers/${supplier.id}/ledger`).then(setData);
  }, [supplier.id]);
  return (
    <Modal title={`Ledger — ${supplier.name}`} onClose={onClose} wide>
      {!data ? <div className="text-slate-500">Loading…</div> : (
        <>
          <div className="text-right text-sm mb-3">Outstanding balance: <span className="font-bold font-mono text-lg">PKR {data.balance}</span></div>
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Note</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th></tr>
            </thead>
            <tbody>
              {data.events.map((e: any, i: number) => (
                <tr key={i}>
                  <td className="text-xs">{new Date(e.at).toLocaleDateString()}</td>
                  <td><span className="pill bg-slate-100 text-slate-700">{e.type}</span></td>
                  <td className="text-xs">{e.note}</td>
                  <td className="text-right font-mono">{Number(e.debit) > 0 ? e.debit : ""}</td>
                  <td className="text-right font-mono">{Number(e.credit) > 0 ? e.credit : ""}</td>
                  <td className="text-right font-mono font-medium">{e.balance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

function PayModal({ supplier, onClose, onPaid }: { supplier: Supplier; onClose: () => void; onPaid: () => void }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api("POST", `/suppliers/${supplier.id}/pay`, { amount: Number(amount), method, reference });
      onPaid();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Modal title={`Pay ${supplier.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Amount (PKR)"><input className="input w-full font-mono text-xl" inputMode="numeric" autoFocus value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} required /></Field>
        <Field label="Method">
          <select className="input w-full" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="CASH">Cash</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="WALLET">Wallet (JazzCash/Easypaisa)</option>
            <option value="CARD">Card</option>
          </select>
        </Field>
        <Field label="Reference (optional)"><input className="input w-full" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="cheque #, txn id, …" /></Field>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1">Record payment</button>
        </div>
      </form>
    </Modal>
  );
}
