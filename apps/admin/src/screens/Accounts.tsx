import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Modal, Field } from "./RawMaterials";

/**
 * Accounts screen — the creditor ledger.
 *
 * List view shows every account at this branch (Food Panda, market shopkeepers,
 * credit customers) with the running balance prominent. Click any account to
 * drill into the detail view: per-order ledger lines + payment history + a form
 * to record a new payment.
 *
 * Payment form: enter cash received + (optional) discount (commission write-off),
 * pick which orders to mark settled (or leave unselected to apply to the running
 * balance). System auto-computes the difference as discount when the amount entered
 * is less than the total of selected orders, so the owner can just type "I got
 * 60,000 against this 70,000 batch" and the 10,000 commission lands automatically.
 */

const BRANCH_ID = "2";

type AccountSummary = {
  id: string;
  name: string;
  type: "FOODPANDA" | "MARKET" | "CUSTOMER";
  phone: string | null;
  notes: string | null;
  isActive: boolean;
  grossOwed: string;
  totalReceived: string;
  totalDiscount: string;
  currentBalance: string;
  orderCount: number;
  paymentCount: number;
};

type OrderRow = {
  id: string;
  orderNo: string;
  total: string;
  paid: string;
  outstanding: string;
  businessDate: string;
  openedAt: string;
  customerName: string | null;
  itemsSummary: string;
};

type PaymentRow = {
  id: string;
  amount: string;
  discount: string;
  method: string;
  paidAt: string;
  businessDate: string;
  notes: string | null;
  recordedBy: string | null;
  orderLinks: { orderId: string; appliedAmount: string }[];
};

type AccountDetail = AccountSummary & {
  branch: { id: string; code: string; name: string };
  orders: OrderRow[];
  payments: PaymentRow[];
};

export function Accounts() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"" | "FOODPANDA" | "MARKET" | "CUSTOMER">("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  function flash(msg: string) { setSavedToast(msg); setTimeout(() => setSavedToast(null), 2500); }

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ branchId: BRANCH_ID });
      if (typeFilter) qs.set("type", typeFilter);
      if (search.trim()) qs.set("search", search.trim());
      const r = await api<{ accounts: AccountSummary[] }>("GET", `/accounts?${qs}`);
      setAccounts(r.accounts);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    const t = setTimeout(refresh, 200);
    return () => clearTimeout(t);
  }, [typeFilter, search]);

  // Totals across all visible accounts
  const totals = useMemo(() => {
    const owed = accounts.reduce((s, a) => s + Number(a.currentBalance), 0);
    const advances = accounts.reduce((s, a) => s + (Number(a.currentBalance) < 0 ? -Number(a.currentBalance) : 0), 0);
    return { owed, advances };
  }, [accounts]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Accounts</h1>
          <div className="text-xs text-slate-500 mt-0.5">
            Credit ledger for Food Panda, market shopkeepers, and credit customers. Click an account to record a payment or see order history.
          </div>
        </div>
        <div className="flex gap-2">
          <div className="rounded-lg bg-amber-50 border-2 border-amber-300 px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-amber-700">Net owed to us</div>
            <div className="font-mono font-bold text-base text-amber-900">PKR {totals.owed.toLocaleString("en-PK")}</div>
          </div>
          {totals.advances > 0 && (
            <div className="rounded-lg bg-leaf-50 border-2 border-leaf-300 px-3 py-2 text-right">
              <div className="text-[10px] uppercase tracking-wider text-leaf-700">Customer advances</div>
              <div className="font-mono font-bold text-base text-leaf-900">PKR {totals.advances.toLocaleString("en-PK")}</div>
            </div>
          )}
        </div>
      </div>

      <div className="card p-3 flex items-center gap-3">
        <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as any)}>
          <option value="">All types</option>
          <option value="FOODPANDA">Food Panda</option>
          <option value="MARKET">Market shopkeepers</option>
          <option value="CUSTOMER">Credit customers</option>
        </select>
        <input className="input flex-1" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <span className="text-xs text-slate-400">{loading ? "Loading…" : `${accounts.length} accounts`}</span>
      </div>

      {error && <div className="card p-3 text-sm text-red-700 bg-red-50 border border-red-200">{error}</div>}

      <div className="card overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="w-32">Type</th>
              <th className="text-right w-32">Owed</th>
              <th className="text-right w-32">Received</th>
              <th className="text-right w-32">Discount</th>
              <th className="text-right w-36">Current balance</th>
              <th className="text-right w-20">Orders</th>
              <th className="text-right w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!loading && accounts.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">No accounts yet — pushing an order to Box 6 (Food Panda) or Box 7 (Market) creates one automatically.</td></tr>
            )}
            {accounts.map((a) => {
              const bal = Number(a.currentBalance);
              return (
                <tr key={a.id} className={bal > 0 ? "bg-amber-50/30" : bal < 0 ? "bg-leaf-50/30" : ""}>
                  <td className="font-medium">{a.name}</td>
                  <td><span className={`pill text-[10px] ${a.type === "FOODPANDA" ? "bg-rose-100 text-rose-800" : a.type === "MARKET" ? "bg-sjc-100 text-sjc-800" : "bg-slate-100 text-slate-700"}`}>{a.type}</span></td>
                  <td className="text-right font-mono text-sm">{Number(a.grossOwed).toLocaleString("en-PK")}</td>
                  <td className="text-right font-mono text-sm">{Number(a.totalReceived).toLocaleString("en-PK")}</td>
                  <td className="text-right font-mono text-sm">{Number(a.totalDiscount).toLocaleString("en-PK")}</td>
                  <td className={`text-right font-mono font-bold ${bal > 0 ? "text-amber-800" : bal < 0 ? "text-leaf-800" : "text-slate-500"}`}>
                    {bal > 0 ? "+" : ""}{Number(a.currentBalance).toLocaleString("en-PK")}
                  </td>
                  <td className="text-right text-xs text-slate-500">{a.orderCount}</td>
                  <td className="text-right">
                    <button className="btn-ghost text-xs py-1" onClick={() => setOpenId(a.id)}>Open</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {openId && (
        <AccountDetailModal accountId={openId} onClose={() => setOpenId(null)} onChanged={(msg) => { flash(msg); refresh(); }} />
      )}

      {savedToast && (
        <div className="fixed top-6 right-6 z-50 card border-2 border-emerald-400 bg-emerald-50 px-4 py-3 shadow-lg flex items-center gap-3 min-w-[260px]">
          <div className="h-8 w-8 rounded-full bg-emerald-500 text-white flex items-center justify-center font-bold text-lg">✓</div>
          <div className="text-sm font-medium text-emerald-900">{savedToast}</div>
        </div>
      )}
    </div>
  );
}

// ─── Detail modal ────────────────────────────────────────────────────

function AccountDetailModal({ accountId, onClose, onChanged }: { accountId: string; onClose: () => void; onChanged: (msg: string) => void }) {
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPayForm, setShowPayForm] = useState(false);

  async function refresh() {
    try {
      const r = await api<AccountDetail>("GET", `/accounts/${accountId}`);
      setDetail(r);
    } catch (e: any) { setError(e.body?.error || e.message); }
  }
  useEffect(() => { refresh(); }, [accountId]);

  if (!detail) return (
    <Modal title="Loading…" onClose={onClose} wide>
      {error ? <div className="text-sm text-red-600">{error}</div> : <div className="text-slate-400">…</div>}
    </Modal>
  );

  const bal = Number(detail.currentBalance);

  return (
    <Modal title={`${detail.name} · ${detail.type}`} onClose={onClose} wide>
      <div className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-4 gap-2">
          <Stat label="Gross owed" value={detail.grossOwed} />
          <Stat label="Received" value={detail.totalReceived} />
          <Stat label="Discount" value={detail.totalDiscount} />
          <Stat label="Balance" value={detail.currentBalance} accent={bal > 0 ? "amber" : bal < 0 ? "leaf" : "slate"} />
        </div>

        {/* Record-payment toggle */}
        <div className="flex justify-between items-center">
          <div className="text-sm font-bold">Ledger</div>
          {!showPayForm && (
            <button className="btn-primary text-sm" onClick={() => setShowPayForm(true)}>+ Record payment</button>
          )}
        </div>

        {showPayForm && (
          <PaymentForm
            account={detail}
            onCancel={() => setShowPayForm(false)}
            onSaved={(msg) => { setShowPayForm(false); refresh(); onChanged(msg); }}
          />
        )}

        {/* Orders ledger */}
        <div className="card overflow-auto">
          <div className="px-3 py-2 border-b text-xs font-bold uppercase tracking-wider text-slate-600">Orders on account ({detail.orders.length})</div>
          <table className="table">
            <thead>
              <tr>
                <th className="w-28">Date</th>
                <th className="w-40">Order #</th>
                <th>Items</th>
                <th className="text-right w-24">Total</th>
                <th className="text-right w-24">Paid</th>
                <th className="text-right w-24">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {detail.orders.length === 0 && (
                <tr><td colSpan={6} className="text-center text-slate-400 py-6">No orders yet on this account.</td></tr>
              )}
              {detail.orders.map((o) => {
                const out = Number(o.outstanding);
                return (
                  <tr key={o.id} className={out > 0 ? "" : "bg-leaf-50/30"}>
                    <td className="font-mono text-xs">{o.businessDate}</td>
                    <td className="font-mono text-xs">{o.orderNo}</td>
                    <td className="text-xs text-slate-600">{o.itemsSummary || "—"}</td>
                    <td className="text-right font-mono">{Number(o.total).toLocaleString("en-PK")}</td>
                    <td className="text-right font-mono text-leaf-700">{Number(o.paid).toLocaleString("en-PK")}</td>
                    <td className={`text-right font-mono font-medium ${out > 0 ? "text-amber-800" : "text-slate-400"}`}>{out.toLocaleString("en-PK")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Payments history */}
        <div className="card overflow-auto">
          <div className="px-3 py-2 border-b text-xs font-bold uppercase tracking-wider text-slate-600">Payments received ({detail.payments.length})</div>
          <table className="table">
            <thead>
              <tr>
                <th className="w-28">Date</th>
                <th className="text-right w-32">Cash in</th>
                <th className="text-right w-32">Discount</th>
                <th>Method · Notes</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {detail.payments.length === 0 && (
                <tr><td colSpan={5} className="text-center text-slate-400 py-6">No payments yet.</td></tr>
              )}
              {detail.payments.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono text-xs">{p.businessDate}</td>
                  <td className="text-right font-mono font-bold text-leaf-700">{Number(p.amount).toLocaleString("en-PK")}</td>
                  <td className="text-right font-mono">{Number(p.discount).toLocaleString("en-PK")}</td>
                  <td className="text-xs text-slate-600">{p.method}{p.notes ? ` · ${p.notes}` : ""}</td>
                  <td className="text-xs text-slate-500">{p.recordedBy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "amber" | "leaf" | "slate" }) {
  const color = accent === "amber" ? "bg-amber-50 border-amber-300 text-amber-900"
              : accent === "leaf"  ? "bg-leaf-50 border-leaf-300 text-leaf-900"
              :                       "bg-slate-50 border-slate-200 text-slate-700";
  return (
    <div className={`rounded-lg border-2 px-3 py-2 ${color}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="font-mono font-bold text-lg">PKR {Number(value).toLocaleString("en-PK")}</div>
    </div>
  );
}

// ─── Payment form ───────────────────────────────────────────────────

function PaymentForm({ account, onCancel, onSaved }: { account: AccountDetail; onCancel: () => void; onSaved: (msg: string) => void }) {
  const [amount, setAmount] = useState("");
  const [discount, setDiscount] = useState("");
  const [method, setMethod] = useState<"CASH" | "CARD" | "WALLET" | "BANK_TRANSFER">("CASH");
  const [notes, setNotes] = useState("");
  // Selected order IDs — when set, we send orderApplications so the system can
  // link the payment to specific orders for the audit trail.
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only outstanding orders are pickable.
  const outstandingOrders = account.orders.filter((o) => Number(o.outstanding) > 0);
  const selectedSum = outstandingOrders
    .filter((o) => selectedOrderIds.has(o.id))
    .reduce((s, o) => s + Number(o.outstanding), 0);

  function toggleOrder(id: string) {
    setSelectedOrderIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedOrderIds(new Set(outstandingOrders.map((o) => o.id)));
  }

  /** Auto-fill: amount = sum of selected outstanding, discount = 0. */
  function fillFromSelection() {
    setAmount(String(selectedSum.toFixed(2)));
    setDiscount("0");
  }

  /** Auto-discount: when amount entered is LESS than selected total, the gap is treated as discount. */
  const amt = Number(amount) || 0;
  const dsc = Number(discount) || 0;
  const autoDiscountSuggestion = (selectedOrderIds.size > 0 && amt > 0 && amt < selectedSum)
    ? +(selectedSum - amt).toFixed(2)
    : null;

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const body: any = {
        amount: amt,
        discount: dsc,
        method,
        notes: notes.trim() || undefined,
      };
      if (selectedOrderIds.size > 0) {
        // Apply payment proportionally across selected orders (by outstanding share).
        // The owner can override later if they want to re-distribute.
        const total = selectedSum > 0 ? selectedSum : 1;
        const selected = outstandingOrders.filter((o) => selectedOrderIds.has(o.id));
        body.orderApplications = selected.map((o) => ({
          orderId: o.id,
          appliedAmount: +(Number(o.outstanding) * (amt + dsc) / total).toFixed(2),
        }));
      }
      await api("POST", `/accounts/${account.id}/payments`, body);
      onSaved(`Payment recorded · PKR ${amt.toLocaleString("en-PK")}${dsc > 0 ? ` + PKR ${dsc.toLocaleString("en-PK")} discount` : ""}`);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className="card border-2 border-leaf-500 bg-leaf-50/30 p-3 space-y-3">
      <div className="font-bold text-sm border-b pb-2">Record payment for {account.name}</div>

      <div className="grid grid-cols-12 gap-3 items-end">
        <Field label="Cash received (PKR)">
          <input type="text" inputMode="decimal" autoFocus className="input w-full font-mono text-xl"
            value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} required />
        </Field>
        <Field label="Discount / write-off">
          <input type="text" inputMode="decimal" className="input w-full font-mono text-xl"
            value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^0-9.]/g, ""))} />
          {autoDiscountSuggestion !== null && (
            <button type="button" className="text-[11px] text-leaf-700 hover:underline mt-1" onClick={() => setDiscount(String(autoDiscountSuggestion))}>
              Set discount = {autoDiscountSuggestion.toLocaleString("en-PK")} (gap between selected total and cash received)
            </button>
          )}
        </Field>
        <Field label="Method">
          <select className="input w-full" value={method} onChange={(e) => setMethod(e.target.value as any)}>
            <option value="CASH">Cash</option>
            <option value="CARD">Card</option>
            <option value="WALLET">Wallet (JazzCash/Easypaisa)</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
          </select>
        </Field>
        <Field label="Notes">
          <input className="input w-full" placeholder="e.g. weekly Food Panda settlement"
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>

      {/* Optional order selection */}
      {outstandingOrders.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-700">
            <span><b>Apply to specific orders</b> (optional). Selected: {selectedOrderIds.size} totaling PKR {selectedSum.toLocaleString("en-PK")}.</span>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost text-[11px] py-0.5" onClick={selectAll}>Select all</button>
              <button type="button" className="btn-ghost text-[11px] py-0.5" onClick={() => setSelectedOrderIds(new Set())}>Clear</button>
              {selectedSum > 0 && <button type="button" className="btn-ghost text-[11px] py-0.5" onClick={fillFromSelection}>Fill amount from selection</button>}
            </div>
          </div>
          <div className="max-h-48 overflow-auto border border-slate-200 rounded">
            <table className="table text-xs">
              <thead>
                <tr><th className="w-8"></th><th>Date</th><th>Order #</th><th className="text-right">Outstanding</th></tr>
              </thead>
              <tbody>
                {outstandingOrders.map((o) => (
                  <tr key={o.id} className={selectedOrderIds.has(o.id) ? "bg-leaf-50" : ""} onClick={() => toggleOrder(o.id)} style={{ cursor: "pointer" }}>
                    <td className="text-center"><input type="checkbox" checked={selectedOrderIds.has(o.id)} onChange={() => toggleOrder(o.id)} /></td>
                    <td className="font-mono">{o.businessDate}</td>
                    <td className="font-mono">{o.orderNo}</td>
                    <td className="text-right font-mono">{Number(o.outstanding).toLocaleString("en-PK")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {error && <div className="text-sm text-red-600">{error}</div>}

      <div className="flex gap-2 pt-1">
        <button type="button" className="btn-secondary flex-1" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-primary flex-1" disabled={busy || (amt + dsc) === 0}>
          {busy ? "Saving…" : `Save payment${amt + dsc > 0 ? ` (PKR ${(amt + dsc).toLocaleString("en-PK")})` : ""}`}
        </button>
      </div>
    </form>
  );
}
