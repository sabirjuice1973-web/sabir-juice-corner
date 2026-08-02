import { useEffect, useState } from "react";
import { api, type PartnerAccount, type PartnerAccountEntry } from "../api";

/**
 * Partner Accounts — owners' personal cash-in/cash-out ledger (replaces the
 * pair of personal Excel sheets). Money moving between the shop till and a
 * partner's own pocket is a running loan, not a sale or a supplier expense.
 * Balance = GAVE_TO_SHOP − TOOK_FROM_SHOP − RECEIVED_ONLINE; positive means
 * the shop owes the partner, negative means the partner owes the shop. See
 * partnerAccounts.ts on the API side for the full model.
 *
 * OWNER-only — enforced server-side too, this UI is just the front door.
 */

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDateDisplay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d}-${MONTH_ABBR[m - 1]}-${String(y).slice(2)}`;
}
function pkr(n: number): string {
  return `PKR ${n.toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
}

const TYPE_META: Record<PartnerAccountEntry["type"], { label: string; short: string; color: string }> = {
  GAVE_TO_SHOP:    { label: "Gave to Shop",          short: "Gave In",  color: "emerald" },
  TOOK_FROM_SHOP:  { label: "Took from Shop",        short: "Took Out", color: "rose" },
  RECEIVED_ONLINE: { label: "Received Online for Order", short: "Online", color: "cyan" },
};

type FormState = {
  id: string | null;
  entryDate: string;
  type: PartnerAccountEntry["type"];
  amount: string;
  note: string;
};
const EMPTY_FORM = (): FormState => ({ id: null, entryDate: todayIso(), type: "GAVE_TO_SHOP", amount: "", note: "" });

export function PartnerAccountsModal({ branchId, onClose, standalone = false }: {
  branchId: string; onClose: () => void;
  standalone?: boolean;
}) {
  const [accounts, setAccounts] = useState<PartnerAccount[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<PartnerAccountEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM());
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const loadAccounts = async () => {
    try {
      const { accounts: accs } = await api.partnerAccounts(branchId);
      setAccounts(accs);
      if (!selectedId && accs.length > 0) setSelectedId(accs[0].id);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not load partner accounts");
    }
  };
  useEffect(() => { void loadAccounts(); }, [branchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadEntries = async (accountId: string) => {
    setLoading(true); setError(null);
    try {
      const { entries: es } = await api.partnerAccountEntries(accountId);
      setEntries(es);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not load entries");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (selectedId) void loadEntries(selectedId); }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedAccount = accounts?.find((a) => a.id === selectedId) ?? null;

  // Running balance shown per row too, so the history reads like a bank statement.
  const rows = (() => {
    if (!entries) return [];
    let running = 0;
    return entries.map((e) => {
      const signed = e.type === "GAVE_TO_SHOP" ? Number(e.amount) : -Number(e.amount);
      running += signed;
      return { ...e, runningBalance: running };
    });
  })();

  function resetForm() { setForm(EMPTY_FORM()); }

  async function refreshAfterMutation() {
    await Promise.all([loadAccounts(), selectedId ? loadEntries(selectedId) : Promise.resolve()]);
  }

  async function handleSubmit() {
    const amt = parseFloat(form.amount);
    if (!Number.isFinite(amt) || amt <= 0) { setError("Enter a valid amount"); return; }
    if (!selectedId) return;
    setBusy(true); setError(null);
    try {
      const payload = { entryDate: form.entryDate, type: form.type, amount: amt, note: form.note.trim() || null };
      if (form.id) {
        await api.updatePartnerAccountEntry(selectedId, form.id, payload);
      } else {
        await api.addPartnerAccountEntry(selectedId, payload);
      }
      resetForm();
      await refreshAfterMutation();
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not save entry");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(e: PartnerAccountEntry) {
    setForm({ id: e.id, entryDate: e.entryDate, type: e.type, amount: e.amount, note: e.note ?? "" });
  }

  async function removeEntry(id: string) {
    if (!selectedId) return;
    setBusy(true); setError(null);
    try {
      await api.deletePartnerAccountEntry(selectedId, id);
      await refreshAfterMutation();
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not delete entry");
    } finally {
      setBusy(false);
    }
  }

  async function submitRename() {
    if (!selectedId || !renameValue.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.renamePartnerAccount(selectedId, renameValue.trim());
      setRenaming(false);
      await loadAccounts();
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not rename");
    } finally {
      setBusy(false);
    }
  }

  const balance = selectedAccount ? Number(selectedAccount.balance) : 0;

  return (
    <div className={`fixed inset-0 flex items-center justify-center z-50 ${standalone ? "bg-white p-0" : "bg-black/40 p-4"}`}>
      <div className={`card p-0 flex flex-col ${standalone ? "w-full h-full max-w-none max-h-none rounded-none border-0" : "w-full max-w-4xl max-h-[90vh]"}`}>
        {/* Header */}
        <div className="px-5 py-3 border-b flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-bold">Self Loan</h2>
            <div className="text-xs text-slate-500 mt-0.5">Personal cash in/out between you and the shop</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none flex-shrink-0">×</button>
        </div>

        {/* Tabs — one per partner */}
        {accounts && (
          <div className="px-5 pt-3 border-b flex items-center gap-1">
            {accounts.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${selectedId === a.id ? "border-accent-600 text-accent-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
              >
                {a.name}
                <span className={`ml-1.5 text-xs font-mono ${Number(a.balance) > 0 ? "text-emerald-600" : Number(a.balance) < 0 ? "text-red-600" : "text-slate-400"}`}>
                  {Number(a.balance) === 0 ? "settled" : pkr(Math.abs(Number(a.balance)))}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-auto p-5">
          {error && <div className="card border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-3">{error}</div>}

          {selectedAccount && (
            <>
              {/* Balance summary */}
              <div className={`rounded-xl px-4 py-3 mb-4 flex items-center justify-between ${balance > 0 ? "bg-emerald-50 border-2 border-emerald-200" : balance < 0 ? "bg-red-50 border-2 border-red-200" : "bg-slate-50 border-2 border-slate-200"}`}>
                <div>
                  {renaming ? (
                    <div className="flex items-center gap-2">
                      <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void submitRename(); if (e.key === "Escape") setRenaming(false); }}
                        className="input text-sm py-1 px-2" autoFocus />
                      <button onClick={() => void submitRename()} className="btn-primary text-xs px-2 py-1">Save</button>
                      <button onClick={() => setRenaming(false)} className="btn-secondary text-xs px-2 py-1">Cancel</button>
                    </div>
                  ) : (
                    <button onClick={() => { setRenameValue(selectedAccount.name); setRenaming(true); }} className="text-sm font-semibold text-slate-700 hover:text-accent-700" title="Click to rename">
                      {selectedAccount.name} <span className="text-slate-300">✎</span>
                    </button>
                  )}
                  <div className="text-xs text-slate-500 mt-0.5">
                    {balance > 0 ? "Shop owes this partner" : balance < 0 ? "This partner owes the shop" : "Fully settled"}
                  </div>
                </div>
                <div className={`text-2xl font-bold font-mono ${balance > 0 ? "text-emerald-700" : balance < 0 ? "text-red-700" : "text-slate-500"}`}>
                  {pkr(Math.abs(balance))}
                </div>
              </div>

              {/* Fast entry row */}
              <div className={`border-2 rounded-lg px-3 py-2 mb-4 bg-white ${form.id ? "border-blue-400" : "border-emerald-400"}`}>
                {form.id && <div className="text-[10px] text-blue-600 font-semibold mb-1.5">✎ Editing entry</div>}
                <div className="flex gap-2 items-end flex-wrap">
                  <div className="shrink-0">
                    <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Date</label>
                    <input type="date" value={form.entryDate} onChange={(e) => setForm((p) => ({ ...p, entryDate: e.target.value }))} className="input text-sm w-36" />
                  </div>
                  <div className="shrink-0">
                    <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Type</label>
                    <div className="flex rounded-lg overflow-hidden border border-slate-300">
                      {(Object.keys(TYPE_META) as PartnerAccountEntry["type"][]).map((t) => (
                        <button key={t} type="button" onClick={() => setForm((p) => ({ ...p, type: t }))}
                          className={`px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap ${form.type === t
                            ? t === "GAVE_TO_SHOP" ? "bg-emerald-600 text-white" : t === "TOOK_FROM_SHOP" ? "bg-rose-600 text-white" : "bg-cyan-600 text-white"
                            : "bg-white text-slate-600 hover:bg-slate-50"}`}
                        >{TYPE_META[t].short}</button>
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Amount</label>
                    <input type="number" min="0" autoFocus placeholder="0" value={form.amount}
                      onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
                      className="input text-sm w-28 text-right" />
                  </div>
                  <div className="flex-1 min-w-[160px]">
                    <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Note (optional)</label>
                    <input type="text" placeholder="e.g. order for Ahmed" value={form.note}
                      onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
                      className="input text-sm w-full" />
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {form.id && <button onClick={resetForm} className="btn-secondary text-xs px-3 py-1.5">Cancel</button>}
                    <button onClick={() => void handleSubmit()} disabled={busy} className="btn-primary text-xs px-4 py-1.5 disabled:opacity-50">
                      {busy ? "Saving…" : form.id ? "Update" : "Add"}
                    </button>
                  </div>
                </div>
              </div>

              {loading && <div className="text-slate-400 text-sm text-center py-8">Loading…</div>}
              {!loading && rows.length === 0 && (
                <div className="text-slate-400 text-sm text-center py-12">No entries yet for {selectedAccount.name}.</div>
              )}
              {!loading && rows.length > 0 && (
                <table className="table w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="px-3 py-1.5 w-24">Date</th>
                      <th className="px-3 py-1.5 text-left">Type</th>
                      <th className="px-3 py-1.5 text-right w-28">Amount</th>
                      <th className="px-3 py-1.5 text-right w-32">Balance</th>
                      <th className="px-3 py-1.5 pl-5 border-l border-slate-200 text-left">Note</th>
                      <th className="px-3 py-1.5 w-24 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-300">
                    {[...rows].reverse().map((r) => (
                      <tr key={r.id}>
                        <td className="px-3 py-1 text-xs font-mono whitespace-nowrap">{formatDateDisplay(r.entryDate)}</td>
                        <td className="px-3 py-1">
                          <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                            r.type === "GAVE_TO_SHOP" ? "bg-emerald-50 text-emerald-700" : r.type === "TOOK_FROM_SHOP" ? "bg-rose-50 text-rose-700" : "bg-cyan-50 text-cyan-700"
                          }`}>{TYPE_META[r.type].label}</span>
                        </td>
                        <td className="px-3 py-1 text-right font-mono whitespace-nowrap">{pkr(Number(r.amount))}</td>
                        <td className={`px-3 py-1 text-right font-mono whitespace-nowrap font-semibold ${r.runningBalance > 0 ? "text-emerald-700" : r.runningBalance < 0 ? "text-red-700" : "text-slate-400"}`}>
                          {pkr(Math.abs(r.runningBalance))}
                        </td>
                        <td className="px-3 py-1 pl-5 border-l border-slate-200 text-xs text-slate-500 max-w-[220px] truncate" title={r.note ?? ""}>{r.note}</td>
                        <td className="px-3 py-1 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button title="Edit" onClick={() => startEdit(r)} className="text-xs px-1.5 py-1 rounded bg-slate-100 hover:bg-blue-100 text-slate-600 hover:text-blue-700">Edit</button>
                            <button title="Delete" onClick={() => void removeEntry(r.id)} className="text-xs px-1.5 py-1 rounded bg-slate-100 hover:bg-red-100 text-slate-600 hover:text-red-700">Del</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
