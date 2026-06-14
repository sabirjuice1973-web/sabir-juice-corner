import { useEffect, useState } from "react";
import { api, type Order } from "../api";
import { enqueue } from "../offline/orderQueue";
import { runDrain } from "../offline/syncDrain";
import { emitOrdersChanged } from "../lib/events";

const METHODS = [
  { code: "CASH" as const,   label: "Cash" },
  { code: "CARD" as const,   label: "Card" },
  { code: "WALLET" as const, label: "Wallet" },
];

export function PayDialog({
  order, onClose, onPaid,
}: {
  order: Order;
  onClose: () => void;
  onPaid: (order: Order, change: string) => void;
}) {
  const [method, setMethod] = useState<"CASH" | "CARD" | "WALLET">("CASH");
  const [amount, setAmount] = useState(order.total);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setAmount(order.total); }, [order.total]);

  const tendered = Number(amount) || 0;
  const due = Number(order.total) || 0;
  const change = method === "CASH" ? Math.max(0, tendered - due) : 0;

  async function pay() {
    setBusy(true); setError(null);
    try {
      const r = await api.pay(order.id, method, tendered);
      emitOrdersChanged();
      onPaid(r.order, r.change);
    } catch (e: any) {
      // Network failure → queue the full order spec for sync. Other errors (insufficient
      // funds, validation) surface to the user as before.
      if (isNetworkError(e)) {
        try {
          await enqueue({
            branchId: order.branchId,
            shiftId: order.shiftId,
            waiterBox: order.waiterBox ?? 1,
            orderType: order.orderType as any,
            items: order.items.map((li) => ({ itemCode: li.item.itemCode, qty: Number(li.qty) })),
            payment: { method, amount: tendered },
          });
          // Treat it as paid locally: same UX (receipt + clear box), with an offline note.
          const localChange = method === "CASH" ? Math.max(0, tendered - Number(order.total)) : 0;
          onPaid({ ...order, status: "PAID" }, String(localChange));
          // Try to drain immediately in case the network blip was momentary.
          void runDrain();
        } catch (queueErr: any) {
          setError("Could not save offline order: " + (queueErr?.message ?? "unknown"));
        }
      } else {
        setError(e.body?.error || e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Detect transport failures (offline, DNS, dropped connection) vs server-side
   * rejections (4xx/5xx with a JSON body). Only transport failures should queue.
   */
  function isNetworkError(e: any): boolean {
    if (e?.status) return false;            // API client populated .status → server responded
    if (e instanceof TypeError) return true; // fetch throws TypeError when offline
    return typeof e?.message === "string" && /failed to fetch|network|load failed/i.test(e.message);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Take payment</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">×</button>
        </div>

        <div className="rounded-lg bg-slate-50 p-3 text-center">
          <div className="text-sm text-slate-500">Total due</div>
          <div className="text-3xl font-bold font-mono">PKR {order.total}</div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {METHODS.map((m) => (
            <button
              key={m.code}
              onClick={() => setMethod(m.code)}
              className={`rounded-lg py-3 font-medium border-2 transition ${
                method === m.code
                  ? "border-sjc-600 bg-sjc-50 text-sjc-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="text-sm text-slate-600">{method === "CASH" ? "Cash tendered" : "Amount"}</span>
          <input
            className="input w-full mt-1 font-mono text-2xl"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            autoFocus
          />
        </label>

        {method === "CASH" && (
          <div className="grid grid-cols-4 gap-2 text-sm">
            {[Math.ceil(due / 100) * 100, 500, 1000, 2000].map((preset, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setAmount(String(preset))}
                className="btn-secondary py-1"
              >
                {preset}
              </button>
            ))}
          </div>
        )}

        {method === "CASH" && change > 0 && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-center">
            <div className="text-xs text-emerald-700">Change due</div>
            <div className="text-xl font-bold font-mono text-emerald-700">PKR {change}</div>
          </div>
        )}

        {error && <div className="text-sm text-red-600">{error}</div>}

        <div className="flex gap-2 pt-2">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary flex-1"
            onClick={pay}
            disabled={busy || tendered <= 0 || (method !== "CASH" && tendered < due)}
          >
            {busy ? "Processing…" : `Take ${method.toLowerCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
