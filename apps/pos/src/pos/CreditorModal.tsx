import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { displayItemName } from "./posState";

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

type FullItem = { name: string; size: string; qty: string; unitPrice: string; lineTotal: string; };
type EnrichedOrder = AccountOrder & { fullItems: FullItem[] | null };

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
  const [discountStr, setDiscountStr] = useState("");
  const [showAddPayment, setShowAddPayment] = useState(false);
  const [addPaymentAmount, setAddPaymentAmount] = useState("");
  const [addPaymentNote, setAddPaymentNote] = useState("");

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
    setDiscountStr("");
    setShowAddPayment(false);
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
  const discountAmount = Math.max(0, parseFloat(discountStr) || 0);
  // Cap at account balance — advance payments (no order links) reduce the balance
  // but leave per-order outstanding untouched, causing apparent double-counting.
  const accountBal = Math.max(0, Number(accountBalance));
  const effectiveOutstanding = Math.min(selectedOutstanding, accountBal);
  const advanceApplied = selectedOutstanding - effectiveOutstanding; // > 0 when advance exists
  const cashToPay = Math.max(0, effectiveOutstanding - discountAmount);

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

  function buildSlipHtml(orderList: EnrichedOrder[], forPreview: boolean): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-PK", { day: "2-digit", month: "2-digit", year: "numeric" });
    const timeStr = now.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });

    const grandTotal       = orderList.reduce((s, o) => s + Number(o.total), 0);
    const grandPaid        = orderList.reduce((s, o) => s + (Number(o.total) - Number(o.outstanding)), 0);
    const grandOutstanding = orderList.reduce((s, o) => s + Number(o.outstanding), 0);
    const balance          = Number(accountBalance); // negative = we owe customer

    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
    const fmt = (n: number) => {
      const r = Math.round(n * 100) / 100;
      return Number.isInteger(r) ? r.toLocaleString("en-PK") : r.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const buildItemRows = (o: EnrichedOrder): string => {
      if (o.fullItems && o.fullItems.length > 0) {
        // Rich rows: Qty | Name | Rate | Total (matches the thermal receipt layout)
        return o.fullItems.map((it) => {
          const label = displayItemName(it.name, it.size);
          const qtyNum = parseFloat(it.qty);
          const qtyStr = Number.isInteger(qtyNum) ? `${qtyNum}` : qtyNum.toFixed(2).replace(/\.?0+$/, "");
          return `<tr>
            <td class="qty">${qtyStr}×</td>
            <td class="name">${esc(label)}</td>
            <td class="rate">${fmt(Number(it.unitPrice))}</td>
            <td class="linetotal">${fmt(Number(it.lineTotal))}</td>
          </tr>`;
        }).join("");
      }
      // Fallback: parse itemsSummary string (no rate/total)
      return o.itemsSummary.split(", ").map((part) => {
        const m = /^(\d+(?:\.\d+)?)×\s+(.+)$/.exec(part.trim());
        return `<tr><td class="qty">${esc(m?.[1] ?? "")}×</td><td class="name" colspan="3">${esc(m?.[2] ?? part)}</td></tr>`;
      }).join("");
    };

    const orderBlocks = orderList.map((o) => {
      const t = new Date(o.openedAt);
      const orderTime = t.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
      return `
    <div class="order-block">
      <div class="order-hdr">
        <span class="order-no">${esc(o.orderNo)}</span>
        <span class="order-meta">${o.businessDate} ${orderTime}</span>
      </div>
      <table class="items">
        <colgroup><col style="width:7mm"/><col/><col style="width:12mm"/><col style="width:13mm"/></colgroup>
        <thead><tr>
          <th class="qty">Qty</th><th class="name">Item</th>
          <th class="rate">Rate</th><th class="linetotal">Total</th>
        </tr></thead>
        <tbody>${buildItemRows(o)}</tbody>
      </table>
      <div class="order-subtotal">Order Total: PKR ${fmt(Number(o.total))}</div>
    </div>
    <hr />`;
    }).join("");

    // Summary rows — mirrors the receipt's .totals table style
    const summaryRows = `
      <tr class="sub-row">
        <td class="lc">Total Billed (${orderList.length} orders)</td>
        <td class="num">PKR ${fmt(grandTotal)}</td>
      </tr>
      ${grandPaid > 0 ? `<tr class="sub-row">
        <td class="lc">Amount Paid</td>
        <td class="num">− PKR ${fmt(grandPaid)}</td>
      </tr>` : ""}
      <tr class="total-row">
        <td class="lc">OUTSTANDING</td>
        <td class="num">${grandOutstanding > 0 ? `PKR ${fmt(grandOutstanding)}` : "PKR 0"}</td>
      </tr>
      ${balance < 0 ? `<tr class="credit-row">
        <td colspan="2" class="credit-cell">Credit Balance (we owe you): PKR ${fmt(Math.abs(balance))}</td>
      </tr>` : ""}`;

    // For actual print: use @page thermal size + auto-print script (same as receipt.ts).
    // For preview: wrap in a centred container so it looks like a slip in the browser.
    const printScript = forPreview ? "" : `
<script>
  (function(){
    function doPrint(){ try{ window.focus(); window.print(); }catch(e){} }
    var img = document.querySelector("img.logo");
    if(img && !img.complete){ img.addEventListener("load",doPrint); img.addEventListener("error",doPrint); setTimeout(doPrint,1500); }
    else { setTimeout(doPrint, 80); }
  })();
</script>`;

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>Credit Statement · ${esc(selectedAccount?.name ?? "")}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 500 9pt/1.45 "Segoe UI","Helvetica Neue",Calibri,Arial,sans-serif;
    color: #000;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    ${forPreview ? "background:#f0f0f0;" : ""}
  }
  .slip {
    ${forPreview ? "max-width:320px;margin:20px auto;background:#fff;padding:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);" : ""}
    page-break-inside: avoid;
  }
  .logo { display:block; margin:0 auto 1.5mm; width:27mm; height:auto; }
  h1 { text-align:center; font-size:15pt; margin:0; letter-spacing:1.5px; font-weight:900; }
  .tagline { text-align:center; font-size:9.5pt; color:#222; margin:1mm 0 0; font-weight:600; }
  .branchline { text-align:center; font-size:10pt; margin:1.5mm 0 0; font-weight:700; }
  hr { border:0; border-top:1px dashed #444; margin:2.5mm 0; }
  table.meta { width:100%; border-collapse:collapse; font-size:8.5pt; }
  table.meta td { padding:0.3mm 0; vertical-align:top; }
  table.meta .lb { font-weight:700; white-space:nowrap; padding-right:1.5mm; }
  table.meta .lb2 { font-weight:700; white-space:nowrap; padding-left:3mm; padding-right:1.5mm; }
  .doc-title {
    text-align:center; font-size:8.5pt; font-weight:900; letter-spacing:1px;
    border-top:1.5px solid #000; border-bottom:1.5px solid #000;
    padding:1.5mm 0; margin:2mm 0;
  }
  .order-block { margin:0.5mm 0; }
  .order-hdr { display:flex; justify-content:space-between; font-size:8.5pt; font-weight:700; }
  .order-meta { font-size:7.5pt; font-weight:500; color:#333; }
  table.items { width:100%; border-collapse:collapse; font-size:8pt; margin:1mm 0 0.5mm; }
  table.items td { padding:0.4mm 0.3mm; vertical-align:top; }
  table.items thead th { font-size:7.5pt; font-weight:700; border-bottom:1px solid #000; padding-bottom:0.5mm; }
  table.items .qty { font-weight:700; white-space:nowrap; }
  table.items .name { }
  table.items .rate { text-align:right; white-space:nowrap; font-weight:500; }
  table.items .linetotal { text-align:right; white-space:nowrap; font-weight:700; }
  .order-subtotal { text-align:right; font-size:8.5pt; font-weight:700; border-top:1px dotted #999; padding-top:0.5mm; }
  table.totals { width:100%; border-collapse:collapse; font-weight:900; font-size:11pt; margin-top:1.5mm; }
  table.totals .total-row td { border-top:2px solid #000; border-bottom:2px solid #000; padding:1.5mm 0; }
  table.totals .sub-row td { font-size:9pt; font-weight:600; padding:0.8mm 0; }
  table.totals .credit-row td { font-size:8.5pt; font-weight:700; padding:1mm 0; }
  table.totals .credit-cell { text-align:center; color:#006600; }
  table.totals .lc { letter-spacing:0.5px; }
  table.totals .num { text-align:right; white-space:nowrap; }
  .footer { text-align:center; margin-top:4mm; font-size:10pt; font-style:italic; color:#111; font-weight:600; }
  .footer .small { display:block; font-style:normal; font-size:9pt; color:#000; margin-top:1mm; font-weight:700; }
</style>
</head><body>
<div class="slip">
  <img class="logo" src="/logo-mono.png" alt="Sabir Juice Corner"/>
  <h1>SABIR JUICE CORNER</h1>
  <div class="tagline">Est. 1973 · Multan</div>
  <div class="branchline">${esc(branchName)}</div>
  <hr/>
  <table class="meta">
    <tr>
      <td class="lb">Date:</td><td>${dateStr}</td>
      <td class="lb2">Time:</td><td>${timeStr}</td>
    </tr>
    <tr><td class="lb">Cashier:</td><td colspan="3">${esc(cashierName)}</td></tr>
    <tr><td class="lb">Account:</td><td colspan="3">${esc(selectedAccount?.name ?? "")}</td></tr>
    ${selectedAccount?.phone ? `<tr><td class="lb">Phone:</td><td colspan="3">${esc(selectedAccount.phone)}</td></tr>` : ""}
  </table>
  <div class="doc-title">CREDIT ACCOUNT STATEMENT</div>

  ${orderBlocks}

  <table class="totals">
    ${summaryRows}
  </table>

  <div class="footer">
    Thank you!
    <span class="small">Sabir Juice Corner · Est. 1973</span>
  </div>
</div>
${printScript}
</body></html>`;
  }

  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  async function printOrPreview(orderList: AccountOrder[], preview: boolean) {
    if (orderList.length === 0) return;
    // Fetch full item details for all orders in parallel so we can show Qty|Name|Rate|Total
    const enriched: EnrichedOrder[] = await Promise.all(
      orderList.map(async (o): Promise<EnrichedOrder> => {
        try {
          const { order } = await api.getOrder(o.id);
          const fullItems: FullItem[] = (order.items as any[]).map((it) => {
            const mix = it.isCustomMix && Array.isArray(it.customMixComponents) ? it.customMixComponents as any[] : null;
            const name = mix && mix.length >= 2
              ? mix.map((m: any) => m.name).join("+")
              : (it.item?.name ?? "");
            const size = mix ? (mix[0]?.size ?? "NA") : (it.item?.size ?? "NA");
            return { name, size, qty: it.qty, unitPrice: it.unitPrice, lineTotal: it.lineTotal };
          });
          return { ...o, fullItems };
        } catch {
          return { ...o, fullItems: null };
        }
      })
    );
    const html = buildSlipHtml(enriched, preview);
    if (preview) {
      const w = window.open("", "_blank", "width=460,height=800,resizable=yes");
      if (!w) { setError("Browser blocked the preview window — allow popups."); return; }
      w.document.open(); w.document.write(html); w.document.close();
      return;
    }
    if (iframeRef.current) document.body.removeChild(iframeRef.current);
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    iframeRef.current = iframe;
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(html);
    iframe.contentDocument!.close();
    // print() is triggered by the embedded script after the logo loads (same pattern as receipt.ts)
    setTimeout(() => { if (iframeRef.current) { document.body.removeChild(iframeRef.current); iframeRef.current = null; } }, 15_000);
  }

  // Single-order print (uses same slip format but just one order)
  function printSingleOrder(order: AccountOrder) {
    void printOrPreview([order], false);
  }

  // ── Cash-paid flow ─────────────────────────────────────────────────────────

  async function recordCashPaid(orderList: AccountOrder[], discount = 0) {
    if (!selectedAccount || orderList.length === 0) return;
    const rawOutstanding = orderList.reduce((s, o) => s + Number(o.outstanding), 0);
    // Cap by current account balance so advance payments aren't double-charged.
    const outstanding = Math.min(rawOutstanding, Math.max(0, Number(accountBalance)));
    const amount = Math.max(0, outstanding - discount);
    if (amount <= 0 && discount <= 0) { setError("All selected orders are already fully paid."); return; }
    setBusy(true); setError(null);
    try {
      await api.recordAccountPayment(selectedAccount.id, {
        amount,
        ...(discount > 0 ? { discount } : {}),
        notes: `Cash received for ${orderList.length} order(s): ${orderList.map((o) => o.orderNo).join(", ")}`,
        // Only pass order links when amounts match — skip when advance payments created a gap
        // (linking full per-order amounts would show false "overpaid" on individual orders).
        ...(rawOutstanding === outstanding
          ? { orderApplications: orderList.map((o) => ({ orderId: o.id, appliedAmount: Number(o.outstanding) })) }
          : {}),
      });
      setDiscountStr("");
      await loadAccount(selectedAccount);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  async function recordAdvancePayment() {
    if (!selectedAccount) return;
    const amount = Math.max(0, parseFloat(addPaymentAmount) || 0);
    if (amount <= 0) { setError("Enter a valid amount."); return; }
    setBusy(true); setError(null);
    try {
      await api.recordAccountPayment(selectedAccount.id, {
        amount,
        notes: addPaymentNote.trim() || "Advance payment",
      });
      setShowAddPayment(false);
      setAddPaymentAmount("");
      setAddPaymentNote("");
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
                                    onClick={async () => { void printSingleOrder(o); await recordCashPaid([o]); }}
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
              <div className="border-t border-slate-200 px-4 py-3 space-y-2">
                {error && <div className="text-sm text-red-600">{error}</div>}

                {/* Add Payment inline panel */}
                {showAddPayment && (
                  <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 flex-wrap">
                    <span className="text-xs font-semibold text-blue-700 shrink-0">Add Payment</span>
                    <input
                      type="number" min="0" placeholder="Amount (PKR)"
                      value={addPaymentAmount}
                      onChange={(e) => setAddPaymentAmount(e.target.value)}
                      className="input text-xs px-2 py-1 w-32"
                      autoFocus
                    />
                    <input
                      type="text" placeholder="Note (optional)"
                      value={addPaymentNote}
                      onChange={(e) => setAddPaymentNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void recordAdvancePayment(); }}
                      className="input text-xs px-2 py-1 flex-1 min-w-[120px]"
                    />
                    <button type="button" onClick={() => void recordAdvancePayment()} disabled={busy || !addPaymentAmount}
                      className="rounded bg-blue-600 text-white px-3 py-1 text-xs font-semibold hover:bg-blue-700 disabled:opacity-40">
                      {busy ? "…" : "Record"}
                    </button>
                    <button type="button" onClick={() => { setShowAddPayment(false); setAddPaymentAmount(""); setAddPaymentNote(""); }}
                      className="text-slate-400 hover:text-slate-700 text-xs">Cancel</button>
                  </div>
                )}

                {/* Main action row */}
                <div className="flex items-center gap-3 flex-wrap">
                  {/* Left: selection summary + discount */}
                  <div className="flex items-center gap-2 text-sm text-slate-600 flex-wrap">
                    {selectedOrders.length > 0 ? (
                      <>
                        <span className="font-medium">{selectedOrders.length} selected</span>
                        <span className="text-slate-300">·</span>
                        <span className="font-mono">Total: PKR {selectedTotal.toFixed(0)}</span>
                        <span className="text-slate-300">·</span>
                        <span className="font-mono font-bold text-red-600">Due: PKR {effectiveOutstanding.toFixed(0)}</span>
                        {advanceApplied > 0 && (
                          <span className="text-xs text-cyan-700 font-semibold bg-cyan-50 border border-cyan-200 rounded px-1.5 py-0.5">
                            PKR {advanceApplied.toFixed(0)} advance applied
                          </span>
                        )}
                        <span className="text-slate-300">·</span>
                        <label className="text-xs text-slate-500 shrink-0">Discount:</label>
                        <input
                          type="number" min="0" max={effectiveOutstanding} placeholder="0"
                          value={discountStr}
                          onChange={(e) => setDiscountStr(e.target.value)}
                          className="input text-xs px-2 py-1 w-24 font-mono"
                        />
                        {(discountAmount > 0 || advanceApplied > 0) && (
                          <span className="text-xs text-orange-600 font-semibold">
                            Cash: PKR {cashToPay.toFixed(0)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-slate-400">{filteredOrders.length} order{filteredOrders.length !== 1 ? "s" : ""} · click checkboxes to select</span>
                    )}
                  </div>

                  {/* Right: buttons */}
                  <div className="ml-auto flex items-center gap-2 flex-wrap">
                    <button type="button"
                      onClick={() => { setShowAddPayment((v) => !v); setAddPaymentAmount(""); setAddPaymentNote(""); }}
                      className={`btn-secondary text-xs px-3 py-1.5 ${showAddPayment ? "bg-blue-100 border-blue-300 text-blue-700" : ""}`}>
                      + Add Payment
                    </button>
                    <button type="button"
                      onClick={() => allSelected ? setSelectedIds(new Set()) : selectAll()}
                      className="btn-secondary text-xs px-3 py-1.5">
                      {allSelected ? "Deselect All" : "Select All"}
                    </button>
                    <button type="button"
                      onClick={() => void printOrPreview(selectedOrders, true)}
                      disabled={selectedOrders.length === 0}
                      className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">
                      Preview
                    </button>
                    <button type="button"
                      onClick={() => void printOrPreview(selectedOrders, false)}
                      disabled={selectedOrders.length === 0}
                      className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40">
                      Print
                    </button>
                    <button type="button"
                      onClick={() => void recordCashPaid(selectedOrders, discountAmount)}
                      disabled={selectedOrders.length === 0 || busy || (selectedOutstanding <= 0 && discountAmount <= 0)}
                      className="rounded-lg bg-leaf-600 text-white px-4 py-1.5 text-xs font-semibold hover:bg-leaf-700 disabled:opacity-40">
                      {busy ? "Processing…" : `Cash Paid · PKR ${cashToPay.toFixed(0)}`}
                    </button>
                    <button type="button"
                      onClick={async () => { await printOrPreview(selectedOrders, false); await recordCashPaid(selectedOrders, discountAmount); }}
                      disabled={selectedOrders.length === 0 || busy || (selectedOutstanding <= 0 && discountAmount <= 0)}
                      className="rounded-lg bg-accent-600 text-white px-4 py-1.5 text-xs font-semibold hover:bg-accent-700 disabled:opacity-40">
                      Print + Cash Paid
                    </button>
                  </div>
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
