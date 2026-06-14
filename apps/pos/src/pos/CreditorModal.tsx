import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

type AccountSummary = {
  id: string;
  name: string;
  type: string;
  phone: string | null;
  currentBalance: string;
  grossOwed: string;
  totalReceived: string;
  orderCount: number;
};

type AccountOrder = {
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

type Props = {
  branchId: string;
  branchName: string;
  cashierName: string;
  onClose: () => void;
};

export function CreditorModal({ branchId, branchName, cashierName, onClose }: Props) {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [search, setSearch] = useState("");
  const [selectedAccount, setSelectedAccount] = useState<AccountSummary | null>(null);
  const [orders, setOrders] = useState<AccountOrder[]>([]);
  const [accountBalance, setAccountBalance] = useState<string>("0");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load account list whenever search changes
  useEffect(() => {
    api.listAccounts(branchId, undefined, search.trim() || undefined)
      .then(({ accounts: list }) => setAccounts(list as AccountSummary[]))
      .catch(() => {});
  }, [branchId, search]);

  // Load orders when account is selected
  const loadAccount = useCallback(async (acc: AccountSummary) => {
    setSelectedAccount(acc);
    setSelectedIds(new Set());
    setLoadingOrders(true);
    setError(null);
    try {
      const data = await api.getAccount(acc.id);
      setOrders((data.orders ?? []) as AccountOrder[]);
      setAccountBalance(data.currentBalance ?? acc.currentBalance);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Failed to load orders");
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  const filteredOrders = orders.filter((o) => {
    if (fromDate && o.businessDate < fromDate) return false;
    if (toDate && o.businessDate > toDate) return false;
    return true;
  });

  const selectedOrders = filteredOrders.filter((o) => selectedIds.has(o.id));
  const selectedTotal = selectedOrders.reduce((s, o) => s + Number(o.total), 0);
  const selectedOutstanding = selectedOrders.reduce((s, o) => s + Number(o.outstanding), 0);

  function toggleOrder(id: string) {
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(filteredOrders.map((o) => o.id)));
  }

  // ── Print helpers ──────────────────────────────────────────────────────────

  function buildSlipHtml(orderList: AccountOrder[], forPreview: boolean): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-PK", { day: "2-digit", month: "2-digit", year: "numeric" });
    const timeStr = now.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
    const grandTotal = orderList.reduce((s, o) => s + Number(o.total), 0);
    const grandOutstanding = orderList.reduce((s, o) => s + Number(o.outstanding), 0);

    const orderRows = orderList.map((o) => `
      <div class="order-block">
        <div class="order-header">
          <span class="order-no">${o.orderNo}</span>
          <span class="order-date">${o.businessDate}</span>
        </div>
        <div class="items-line">${o.itemsSummary}</div>
        <div class="order-total">PKR ${Number(o.total).toFixed(0)}</div>
      </div>
      <div class="dotted-divider"></div>
    `).join("");

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Courier New", monospace; font-size: 11px; width: ${forPreview ? "380px" : "300px"}; margin: 0 auto; padding: 8px; background: white; }
  .slip-header { text-align: center; padding-bottom: 6px; }
  .slip-header h2 { font-size: 14px; font-weight: bold; letter-spacing: 1px; }
  .slip-header .sub { font-size: 11px; color: #333; margin-top: 2px; }
  .slip-header .account-name { font-size: 13px; font-weight: bold; margin-top: 4px; }
  .double-line { border-top: 2px solid #000; border-bottom: 1px solid #000; margin: 6px 0; padding: 2px 0; text-align: center; font-size: 10px; letter-spacing: 1px; }
  .order-block { padding: 4px 0; }
  .order-header { display: flex; justify-content: space-between; font-weight: bold; font-size: 11px; }
  .items-line { font-size: 10px; color: #444; margin: 2px 0 2px 8px; }
  .order-total { text-align: right; font-weight: bold; font-size: 12px; }
  .dotted-divider { border-top: 1px dashed #666; margin: 4px 0; }
  .summary { padding-top: 4px; }
  .summary-row { display: flex; justify-content: space-between; padding: 1px 0; }
  .summary-row.grand { font-size: 13px; font-weight: bold; border-top: 2px solid #000; padding-top: 4px; margin-top: 4px; }
  .outstanding { color: #c00; }
  .footer { text-align: center; font-size: 10px; color: #666; margin-top: 8px; padding-top: 4px; border-top: 1px dashed #999; }
</style>
</head>
<body>
  <div class="slip-header">
    <h2>${branchName}</h2>
    <div class="sub">Printed: ${dateStr} ${timeStr}</div>
    <div class="sub">Cashier: ${cashierName}</div>
    <div class="account-name">Account: ${selectedAccount?.name ?? ""}</div>
    ${selectedAccount?.phone ? `<div class="sub">Phone: ${selectedAccount.phone}</div>` : ""}
  </div>
  <div class="double-line">CREDIT ACCOUNT STATEMENT</div>

  ${orderRows}

  <div class="summary">
    <div class="summary-row">
      <span>Orders (${orderList.length})</span>
    </div>
    <div class="summary-row grand">
      <span>Total Billed</span>
      <span>PKR ${grandTotal.toFixed(0)}</span>
    </div>
    <div class="summary-row outstanding">
      <span><b>Outstanding</b></span>
      <span><b>PKR ${grandOutstanding.toFixed(0)}</b></span>
    </div>
  </div>

  <div class="footer">
    Sabir Juice Corner · Thank you
  </div>
</body>
</html>`;
  }

  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  function printOrPreview(orderList: AccountOrder[], preview: boolean) {
    if (orderList.length === 0) return;
    const html = buildSlipHtml(orderList, preview);
    if (preview) {
      const w = window.open("", "_blank", "width=440,height=700,resizable=yes");
      if (!w) { setError("Browser blocked the preview window — allow popups."); return; }
      w.document.write(html);
      w.document.close();
      return;
    }
    if (iframeRef.current) document.body.removeChild(iframeRef.current);
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    iframeRef.current = iframe;
    iframe.contentDocument!.write(html);
    iframe.contentDocument!.close();
    iframe.contentWindow!.focus();
    iframe.contentWindow!.print();
    setTimeout(() => { if (iframeRef.current) { document.body.removeChild(iframeRef.current); iframeRef.current = null; } }, 10_000);
  }

  // Single-order print (uses same slip format but just one order)
  function printSingleOrder(order: AccountOrder) {
    printOrPreview([order], false);
  }

  // ── Cash-paid flow ─────────────────────────────────────────────────────────

  async function recordCashPaid(orderList: AccountOrder[]) {
    if (!selectedAccount || orderList.length === 0) return;
    const amount = orderList.reduce((s, o) => s + Number(o.outstanding), 0);
    if (amount <= 0) { setError("All selected orders are already fully paid."); return; }
    setBusy(true); setError(null);
    try {
      await api.recordAccountPayment(selectedAccount.id, {
        amount,
        notes: `Cash received for ${orderList.length} order(s): ${orderList.map((o) => o.orderNo).join(", ")}`,
        orderApplications: orderList.map((o) => ({ orderId: o.id, appliedAmount: Number(o.outstanding) })),
      });
      // Reload
      await loadAccount(selectedAccount);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const allSelected = filteredOrders.length > 0 && selectedIds.size === filteredOrders.length;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-6xl flex flex-col" style={{ height: "90vh" }}>

        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-sjc-100 to-white rounded-t-xl">
          <div>
            <div className="font-bold text-lg">Creditor Accounts</div>
            <div className="text-xs text-slate-500">View & settle credit account balances</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none w-8 h-8 flex items-center justify-center">×</button>
        </div>

        <div className="flex-1 flex min-h-0">

          {/* Left: Account list */}
          <div className="w-72 border-r border-slate-200 flex flex-col flex-shrink-0">
            <div className="p-3 border-b border-slate-200">
              <input
                className="input w-full text-sm"
                placeholder="Search accounts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex-1 overflow-auto">
              {accounts.map((acc) => (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => loadAccount(acc)}
                  className={`w-full px-3 py-3 text-left border-b border-slate-100 transition-colors ${
                    selectedAccount?.id === acc.id
                      ? "bg-accent-50 border-l-2 border-l-accent-500"
                      : "hover:bg-slate-50"
                  }`}
                >
                  <div className="font-medium text-sm text-slate-900">{acc.name}</div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-slate-500 uppercase tracking-wide">{acc.type}</span>
                    <span className={`text-xs font-mono font-bold ${Number(acc.currentBalance) > 0 ? "text-red-600" : "text-green-600"}`}>
                      PKR {Number(acc.currentBalance).toFixed(0)}
                    </span>
                  </div>
                  {acc.phone && <div className="text-xs text-slate-400 mt-0.5">{acc.phone}</div>}
                </button>
              ))}
              {accounts.length === 0 && (
                <div className="text-center text-slate-400 text-xs py-10">No accounts found</div>
              )}
            </div>
          </div>

          {/* Right: Orders for selected account */}
          {selectedAccount ? (
            <div className="flex-1 flex flex-col min-h-0">

              {/* Account header + date filter */}
              <div className="px-4 py-2 border-b border-slate-200 flex items-center gap-4 flex-wrap">
                <div>
                  <span className="font-bold text-slate-900">{selectedAccount.name}</span>
                  <span className="ml-2 text-xs text-slate-500">{selectedAccount.type}</span>
                  {selectedAccount.phone && <span className="ml-2 text-xs text-slate-400">{selectedAccount.phone}</span>}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-500">Outstanding:</span>
                  <span className={`font-mono font-bold ${Number(accountBalance) > 0 ? "text-red-600" : "text-green-600"}`}>
                    PKR {Number(accountBalance).toFixed(0)}
                  </span>
                </div>
                <div className="ml-auto flex items-center gap-2 text-xs">
                  <span className="text-slate-500">From</span>
                  <input type="date" className="input text-xs px-2 py-1 h-7" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
                  <span className="text-slate-500">To</span>
                  <input type="date" className="input text-xs px-2 py-1 h-7" value={toDate} onChange={(e) => setToDate(e.target.value)} />
                  {(fromDate || toDate) && (
                    <button type="button" onClick={() => { setFromDate(""); setToDate(""); }} className="text-slate-400 hover:text-red-600 text-xs">Clear</button>
                  )}
                </div>
              </div>

              {/* Orders table */}
              <div className="flex-1 overflow-auto">
                {loadingOrders ? (
                  <div className="text-center text-slate-400 text-sm py-10">Loading…</div>
                ) : (
                  <table className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 z-10">
                      <tr>
                        <th className="px-3 py-2 text-left w-8">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={(e) => e.target.checked ? selectAll() : setSelectedIds(new Set())}
                          />
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Order #</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Date</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Items</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-slate-600 uppercase tracking-wide">Total</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-slate-600 uppercase tracking-wide">Paid</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-slate-600 uppercase tracking-wide">Due</th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-slate-600 uppercase tracking-wide w-28">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredOrders.map((o) => {
                        const isSelected = selectedIds.has(o.id);
                        const outstanding = Number(o.outstanding);
                        return (
                          <tr key={o.id} className={`transition-colors ${isSelected ? "bg-accent-50" : "hover:bg-slate-50"}`}>
                            <td className="px-3 py-2">
                              <input type="checkbox" checked={isSelected} onChange={() => toggleOrder(o.id)} />
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-slate-700">{o.orderNo}</td>
                            <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">{o.businessDate}</td>
                            <td className="px-3 py-2 text-xs text-slate-600 max-w-[220px] truncate" title={o.itemsSummary}>{o.itemsSummary}</td>
                            <td className="px-3 py-2 text-right font-mono text-xs">PKR {Number(o.total).toFixed(0)}</td>
                            <td className="px-3 py-2 text-right font-mono text-xs text-green-700">PKR {Number(o.paid).toFixed(0)}</td>
                            <td className={`px-3 py-2 text-right font-mono text-xs font-bold ${outstanding > 0 ? "text-red-600" : "text-green-600"}`}>
                              PKR {outstanding.toFixed(0)}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center justify-center gap-1">
                                {/* Print bill */}
                                <button
                                  type="button"
                                  title="Print bill for this order"
                                  onClick={() => printSingleOrder(o)}
                                  className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-slate-800"
                                >
                                  <PrintIcon />
                                </button>
                                {/* Cash paid for this order */}
                                {outstanding > 0 && (
                                  <button
                                    type="button"
                                    title={`Mark as cash paid (PKR ${outstanding.toFixed(0)})`}
                                    onClick={() => recordCashPaid([o])}
                                    disabled={busy}
                                    className="p-1 rounded hover:bg-leaf-100 text-slate-500 hover:text-leaf-700 disabled:opacity-40"
                                  >
                                    <CashIcon />
                                  </button>
                                )}
                                {/* Print + cash paid */}
                                {outstanding > 0 && (
                                  <button
                                    type="button"
                                    title={`Print + mark cash paid`}
                                    onClick={async () => { printSingleOrder(o); await recordCashPaid([o]); }}
                                    disabled={busy}
                                    className="p-1 rounded hover:bg-accent-100 text-slate-500 hover:text-accent-700 disabled:opacity-40"
                                  >
                                    <PrintCashIcon />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {!loadingOrders && filteredOrders.length === 0 && (
                  <div className="text-center text-slate-400 text-sm py-10">
                    {orders.length === 0 ? "No orders on this account yet" : "No orders in selected date range"}
                  </div>
                )}
              </div>

              {/* Footer: summary + bulk actions */}
              <div className="border-t border-slate-200 px-4 py-3 flex items-center gap-4 flex-wrap">
                {error && <span className="text-sm text-red-600">{error}</span>}
                <div className="text-sm text-slate-600">
                  {selectedOrders.length > 0 ? (
                    <>
                      <span className="font-medium">{selectedOrders.length} selected</span>
                      <span className="text-slate-400 mx-2">·</span>
                      <span className="font-mono">Total: PKR {selectedTotal.toFixed(0)}</span>
                      <span className="text-slate-400 mx-2">·</span>
                      <span className="font-mono font-bold text-red-600">Due: PKR {selectedOutstanding.toFixed(0)}</span>
                    </>
                  ) : (
                    <span className="text-slate-400">{filteredOrders.length} order{filteredOrders.length !== 1 ? "s" : ""} · click checkboxes to select</span>
                  )}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => allSelected ? setSelectedIds(new Set()) : selectAll()}
                    className="btn-secondary text-xs px-3 py-1.5"
                  >
                    {allSelected ? "Deselect All" : "Select All"}
                  </button>
                  <button
                    type="button"
                    onClick={() => printOrPreview(selectedOrders, true)}
                    disabled={selectedOrders.length === 0}
                    className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => printOrPreview(selectedOrders, false)}
                    disabled={selectedOrders.length === 0}
                    className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40"
                  >
                    Print
                  </button>
                  <button
                    type="button"
                    onClick={() => recordCashPaid(selectedOrders)}
                    disabled={selectedOrders.length === 0 || busy || selectedOutstanding <= 0}
                    className="rounded-lg bg-leaf-600 text-white px-4 py-1.5 text-xs font-semibold hover:bg-leaf-700 disabled:opacity-40"
                  >
                    {busy ? "Processing…" : `Cash Paid · PKR ${selectedOutstanding.toFixed(0)}`}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      printOrPreview(selectedOrders, false);
                      await recordCashPaid(selectedOrders);
                    }}
                    disabled={selectedOrders.length === 0 || busy || selectedOutstanding <= 0}
                    className="rounded-lg bg-accent-600 text-white px-4 py-1.5 text-xs font-semibold hover:bg-accent-700 disabled:opacity-40"
                  >
                    Print + Cash Paid
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-slate-400">
                <AccountsIcon />
                <div className="mt-3 text-sm">Select an account from the left</div>
                <div className="text-xs mt-1">to view its orders and manage payments</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────────

function PrintIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}
function CashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function PrintCashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <polyline points="9 14 11 16 15 12" />
    </svg>
  );
}
function AccountsIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-slate-300">
      <path d="M20 12V8H6a2 2 0 0 1 0-4h12v4" />
      <path d="M4 6v12a2 2 0 0 0 2 2h14v-4" />
      <circle cx="16" cy="14" r="2" />
    </svg>
  );
}
