import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { displayItemName, type BoxOrder } from "./posState";
import { emitOrdersChanged } from "../lib/events";

/**
 * Order Details modal — opens when the cashier double-clicks an order row.
 *
 * Shows the order's items read-only, lets the cashier apply a flat PKR discount
 * (any value > 0), and offers three actions on the bottom row that mirror the
 * inline icons in the box row:
 *   • Print only         → reprint the bill, no state change
 *   • Save               → apply discount (if any), mark paid as CASH, remove from box
 *   • Print + Save       → both
 *
 * For discounts >10% of subtotal, the backend requires POS_DISCOUNT_LARGE
 * permission. The error message surfaces if the cashier lacks it.
 */

type Props = {
  order: BoxOrder;
  branchId: string;
  boxNumber: number;
  cashierName: string;
  onClose: () => void;
  onPrintOnly: () => void;            // reprint only — parent handles
  onSaved: () => void;                 // remove from box — parent handles after we apply discount + pay
  onPrintAndSaved: () => void;         // same — parent prints first
  onPushedToAccount: () => void;       // remove from box after creditor push
};

export function OrderDetails({ order, branchId, boxNumber: _boxNumber, cashierName: _cashierName, onClose, onPrintOnly, onSaved, onPrintAndSaved, onPushedToAccount }: Props) {
  const [discountStr, setDiscountStr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedDiscount, setAppliedDiscount] = useState(0);

  // ─── Creditor account push ───────────────────────────────────────────────
  const [showCreditor, setShowCreditor] = useState(false);
  const [creditorName, setCreditorName] = useState(() => order.customerName ?? "");
  const [creditorPhone, setCreditorPhone] = useState("");
  const [suggestions, setSuggestions] = useState<{ id: string; name: string; phone: string | null; type: string }[]>([]);
  const [creditorBusy, setCreditorBusy] = useState(false);
  const [creditorError, setCreditorError] = useState<string | null>(null);
  const suggestionsRef = useRef<HTMLUListElement>(null);

  // Debounced account search
  useEffect(() => {
    const q = creditorName.trim();
    if (q.length < 2) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      try {
        const { accounts } = await api.listAccounts(branchId, undefined, q);
        setSuggestions((accounts as any[]).filter((a) => a.type !== "FOODPANDA").slice(0, 6));
      } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [creditorName, branchId]);

  // Close suggestions on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setSuggestions([]);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  async function handlePushToCreditor() {
    const name = creditorName.trim();
    if (!name) return;
    if (!order.serverId) {
      setCreditorError("Order not synced yet — wait for the Online status pill, then try again.");
      return;
    }
    setCreditorBusy(true); setCreditorError(null);
    try {
      await api.pushOrderToAccount({
        orderId: order.serverId,
        type: "CUSTOMER",
        name,
        phone: creditorPhone.trim() || undefined,
      });
      emitOrdersChanged();
      onPushedToAccount();
    } catch (e: any) {
      setCreditorError(e.body?.error || e.message || "Failed to push to account");
    } finally {
      setCreditorBusy(false);
    }
  }

  // Esc closes the modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const subtotal = Number(order.total) + appliedDiscount;        // server total already reflects past discounts
  const discountInput = Math.max(0, parseFloat(discountStr) || 0);
  const newTotal = Math.max(0, subtotal - appliedDiscount - discountInput);

  async function applyDiscountIfNeeded(): Promise<boolean> {
    if (discountInput <= 0) return true;
    if (!order.serverId) {
      setError("This order isn't synced yet — wait for the green status pill, then try again.");
      return false;
    }
    try {
      await api.applyDiscount(order.serverId, "FLAT", discountInput, `Counter discount`);
      setAppliedDiscount((d) => d + discountInput);
      setDiscountStr("");
      return true;
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not apply discount");
      return false;
    }
  }

  async function payAsCash(): Promise<boolean> {
    if (!order.serverId) {
      setError("This order isn't synced yet — wait for the green status pill, then try again.");
      return false;
    }
    try {
      await api.pay(order.serverId, "CASH", newTotal);
      emitOrdersChanged();
      return true;
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not save");
      return false;
    }
  }

  async function handleSave() {
    setBusy(true); setError(null);
    try {
      if (!(await applyDiscountIfNeeded())) return;
      if (!(await payAsCash())) return;
      onSaved();
    } finally { setBusy(false); }
  }
  async function handlePrintAndSave() {
    setBusy(true); setError(null);
    try {
      if (!(await applyDiscountIfNeeded())) return;
      if (!(await payAsCash())) return;
      onPrintAndSaved();
    } finally { setBusy(false); }
  }
  async function handlePrintOnly() {
    // Apply discount if cashier entered one (so the printed bill reflects it),
    // but don't save/remove the order. They can keep it in the box if needed.
    setBusy(true); setError(null);
    try {
      if (!(await applyDiscountIfNeeded())) return;
      onPrintOnly();
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-sjc-100 to-white">
          <div>
            <div className="font-bold text-lg">Order details</div>
            <div className="text-xs text-slate-500">
              {order.orderNo ?? <span className="text-amber-600">{order.localId} · awaiting sync</span>}
              &nbsp;·&nbsp;{new Date(order.openedAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true })}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        {/* Items list */}
        <div className="flex-1 overflow-auto px-5 py-3">
          <ul className="divide-y divide-slate-100">
            {order.lines.map((li, i) => (
              <li key={i} className="py-1.5 flex items-center gap-3 text-sm">
                <span className="font-mono text-xs text-slate-400 w-12">#{li.itemCode}</span>
                <span className="flex-1">
                  <span className="font-medium">{displayItemName(li.name, li.size)}</span>
                </span>
                <span className="font-mono text-slate-600">{li.qty} ×</span>
                <span className="font-mono font-bold w-20 text-right">PKR {Number(li.lineTotal).toFixed(0)}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Totals + discount input */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">Subtotal (before discount)</span>
            <span className="font-mono">PKR {subtotal.toFixed(2)}</span>
          </div>
          {appliedDiscount > 0 && (
            <div className="flex items-center justify-between text-sm text-emerald-700">
              <span>Already applied discount</span>
              <span className="font-mono">− PKR {appliedDiscount.toFixed(2)}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-600 flex-1">
              Add discount (PKR)
              <input
                className="input w-full mt-1 font-mono text-lg"
                inputMode="decimal"
                value={discountStr}
                onChange={(e) => setDiscountStr(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0"
                autoFocus
              />
              <div className="text-[11px] text-slate-400 mt-0.5">Any positive amount. Above 10% of subtotal requires manager permission.</div>
            </label>
            <div className="text-right">
              <div className="text-xs text-slate-500">New total</div>
              <div className="text-3xl font-mono font-bold">PKR {newTotal.toFixed(0)}</div>
            </div>
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>

        {/* Creditor account push */}
        <div className="px-5 py-3 border-t border-slate-200">
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm font-medium text-leaf-700 hover:text-leaf-800"
            onClick={() => setShowCreditor((v) => !v)}
          >
            <CreditIcon />
            Push to creditor account
            <span className="text-slate-400 text-xs ml-0.5">{showCreditor ? "▲" : "▼"}</span>
          </button>
          {showCreditor && (
            <div className="mt-3 space-y-2">
              <div className="relative">
                <label className="text-xs text-slate-500 font-medium uppercase tracking-wide">Account name *</label>
                <input
                  className="input w-full mt-1"
                  value={creditorName}
                  onChange={(e) => { setCreditorName(e.target.value); setCreditorError(null); }}
                  placeholder="Type to search existing or create new…"
                  autoFocus
                />
                {suggestions.length > 0 && (
                  <ul
                    ref={suggestionsRef}
                    className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-40 overflow-auto"
                  >
                    {suggestions.map((acc) => (
                      <li
                        key={acc.id}
                        className="px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer flex items-center justify-between"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setCreditorName(acc.name);
                          setCreditorPhone(acc.phone ?? "");
                          setSuggestions([]);
                        }}
                      >
                        <span className="font-medium">{acc.name}</span>
                        <span className="text-slate-400 text-xs">{acc.phone ?? ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <label className="text-xs text-slate-500 font-medium uppercase tracking-wide">Phone (optional)</label>
                <input
                  className="input w-full mt-1"
                  value={creditorPhone}
                  onChange={(e) => setCreditorPhone(e.target.value)}
                  placeholder="e.g. 0300-1234567"
                />
              </div>
              {creditorError && <div className="text-sm text-red-600">{creditorError}</div>}
              <button
                type="button"
                className="btn-primary w-full py-2.5"
                onClick={handlePushToCreditor}
                disabled={!creditorName.trim() || creditorBusy}
              >
                {creditorBusy ? "Pushing…" : `Push PKR ${Number(order.total).toFixed(0)} to creditor account`}
              </button>
            </div>
          )}
        </div>

        {/* Three actions, mirrored from the row icons */}
        <div className="px-5 py-3 border-t border-slate-200 grid grid-cols-3 gap-2">
          <button onClick={handlePrintOnly} disabled={busy} className="btn-secondary py-3">
            <PrinterIcon /> <span className="ml-1">Print only</span>
          </button>
          <button onClick={handleSave} disabled={busy} className="rounded-lg bg-leaf-600 hover:bg-leaf-600/90 text-white font-medium py-3 disabled:opacity-50">
            <SaveIcon /> <span className="ml-1">Save (Cash)</span>
          </button>
          <button onClick={handlePrintAndSave} disabled={busy} className="btn-primary py-3">
            <PrintSaveIcon /> <span className="ml-1">Print + Save</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function PrinterIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline align-text-bottom"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>;
}
function SaveIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline align-text-bottom"><polyline points="20 6 9 17 4 12" /></svg>;
}
function PrintSaveIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline align-text-bottom"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><polyline points="9 14 11 16 15 12" /></svg>;
}
function CreditIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline align-text-bottom"><path d="M20 12V8H6a2 2 0 0 1 0-4h12v4" /><path d="M4 6v12a2 2 0 0 0 2 2h14v-4" /><circle cx="16" cy="14" r="1.5" /></svg>;
}
