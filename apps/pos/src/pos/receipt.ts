import { displayItemName, type BoxOrder } from "./posState";
import { LOGO_MONO_DATA_URI } from "./logoMonoDataUri";

/**
 * Render a receipt for a BoxOrder and open the browser's print dialog.
 *
 * Layout: 80mm-wide thermal-receipt format, Segoe UI (with sans-serif fallbacks
 * for non-Windows printers). Line-art logo at the top (line-art prints sharper
 * on thermal than a solid fill), bold metadata labels, generous spacing on the
 * items table, heavy TOTAL line.
 *
 * Image loading:
 *   The logo is inlined as a base64 data URI (LOGO_MONO_DATA_URI) rather than
 *   an <img src="/logo-mono.png"> network request. A network-loaded image
 *   fires its "load" event asynchronously, and win.print() was firing before
 *   that completed — Chromium then waits on the pending image before it can
 *   render the print preview, so the popup sat fully visible for a beat before
 *   the print dialog appeared. Inlining removes that wait entirely.
 *
 * For ESC/POS thermal printers later: the same HTML is structured so a Node
 * service (or WebUSB-based driver) can pick it up and translate to printer
 * commands. The logo would be re-rasterised by the printer driver.
 */

// Reused across prints (within a burst) instead of opening + closing a fresh
// popup every time. Spinning up a brand-new browsing context (renderer process,
// layout, print pipeline) is what was costing ~1-1.5s per print on Windows/Edge.
//
// BUT: a popup left open and untouched for a while (first order after opening
// the shop, or after a lull) can get frozen/discarded in the background by
// Chromium's memory-saving tab lifecycle — `.closed` still reads false, yet
// win.print() on it silently fails at the OS/spooler level ("Print failed —
// check your printer"), even though the printer itself is fine. So reuse is
// only trusted for STALE_MS after the last successful print; anything older
// is torn down and replaced with a fresh window, same as a cold start.
let sharedPrintWindow: Window | null = null;
let lastPrintAt = 0;
const STALE_MS = 3 * 60 * 1000;

function getPrintWindow(): Window | null {
  const isFresh = sharedPrintWindow && !sharedPrintWindow.closed && Date.now() - lastPrintAt < STALE_MS;
  if (isFresh) return sharedPrintWindow;
  if (sharedPrintWindow && !sharedPrintWindow.closed) {
    try { sharedPrintWindow.close(); } catch { /* ignore */ }
  }
  // Note: do NOT include "noopener" in the features string — when noopener is
  // present the browser opens the window but window.open() returns null (per
  // spec), so every print would silently fall through to the null-check below.
  // Open at a usable size — Edge shows the print-preview panel INSIDE the popup
  // window, so a 1x1 px window makes the preview panel tiny and unusable.
  sharedPrintWindow = window.open("", "_blank", "width=900,height=680");
  return sharedPrintWindow;
}

export function printReceipt(
  order: BoxOrder,
  header: { branchName: string; cashier: string },
  payment?: { amountReceived: number; cashReturn: number },
  onDone?: () => void,
) {
  const html = receiptHtml(order, header, payment);
  const win = getPrintWindow();
  if (!win) {
    onDone?.();
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Trigger print from the PARENT window — this is still within the user-gesture
  // activation from the button click, so Edge/Chrome allow it. Calling
  // window.print() from inside the popup's own <script> has no user gesture and
  // can be silently blocked on Windows Edge.
  win.focus();
  win.print();
  lastPrintAt = Date.now();
  if (onDone) {
    win.addEventListener("afterprint", () => onDone(), { once: true });
  }
}

function receiptHtml(order: BoxOrder, header: { branchName: string; cashier: string }, payment?: { amountReceived: number; cashReturn: number }): string {
  const orderedAt = new Date(order.openedAt);
  const printedAt = new Date();
  const orderDate = orderedAt.toLocaleDateString("en-PK", { day: "2-digit", month: "2-digit", year: "numeric" });
  const orderTime = orderedAt.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
  const printTime = printedAt.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
  // Show just the sequential integer: "B2-20260612-0062" → 62
  const orderSeq = order.orderNo
    ? String(parseInt(/(\d+)$/.exec(order.orderNo)?.[1] ?? "0", 10) || order.orderNo)
    : order.localId;
  const lines = order.lines.map((li) => {
    // Customer-readable name — always carries the size word (Medium/Jumbo)
    // when applicable. displayItemName() handles the "already in name" case
    // for mix lines so we don't print "...Plum Medium Medium".
    const displayName = displayItemName(li.name, li.size);
    // Rate = unit price. We don't store unitPrice on the BoxOrder line (it's
    // captured server-side at add-time), so we derive it from lineTotal / qty.
    // Both come from the server's Decimal math so the result is exact unless
    // the qty was non-integer (mix at 0.5×); the toFixed(0) keeps the column tight.
    const rate = li.qty > 0 ? Number(li.lineTotal) / li.qty : 0;
    const qtyStr = Number.isInteger(li.qty) ? `${li.qty}` : li.qty.toFixed(2).replace(/\.?0+$/, "");
    return `<tr>
       <td class="qty"><span>${qtyStr}</span></td>
       <td class="item">${escapeHtml(displayName)}</td>
       <td class="num">${formatMoney(rate)}</td>
       <td class="num total">${formatMoney(Number(li.lineTotal))}</td>
     </tr>`;
  }).join("");
  const totalQty = order.lines.reduce((s, li) => s + li.qty, 0);
  const totalQtyStr = Number.isInteger(totalQty) ? `${totalQty}` : totalQty.toFixed(2).replace(/\.?0+$/, "");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Receipt ${order.orderNo ?? order.localId}</title>
<style>
  /* Reverted to the original @page margin (4mm) and zero body padding — the
     combo of margin:0 + body padding was making Chrome generate a 2nd blank
     "page" for tall receipts, which the printer then cut as an empty strip. */
  @page { size: 80mm auto; margin: 4mm; }
  /* The popup window paints once before the print dialog takes over (the
     window/renderer needs a moment to spin up) — without this the cashier
     briefly sees the fully rendered receipt sitting there before the dialog
     appears. Hiding it on screen (but not @media print) means that moment
     is just a blank window instead. */
  @media screen { .receipt { visibility: hidden; } }
  * { box-sizing: border-box; }
  /* Heavier base weight (500) keeps thermal print crisp — the printer rasterises
     at ~203 dpi so thin strokes turn blurry. Tabular-nums everywhere so columns
     line up perfectly in money cells. */
  html, body { margin: 0; padding: 0; }
  body {
    font: 500 9pt/1.45 "Arial Narrow", Arial, sans-serif;
    color: #000;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  /* Force every visible element onto a single page — Chrome won't break
     anywhere inside the receipt. If content somehow exceeds page-1 height,
     Chrome will grow the page rather than spawn a blank page-2 that becomes
     a cut paper strip. */
  .receipt, .receipt * {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
  }
  .receipt { page-break-after: avoid !important; break-after: avoid !important; }
  /* Header: shop info on left, logo on right */
  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2mm;
    margin-bottom: 1.5mm;
  }
  .header-info { flex: 1; }
  .logo {
    width: 22mm;
    height: auto;
    flex-shrink: 0;
    /* boost contrast so thin strokes print solid on thermal */
    filter: contrast(2);
    -webkit-print-color-adjust: exact;
  }
  h1 {
    font-size: 12pt;
    margin: 0;
    letter-spacing: 0.5px;
    font-weight: 900;
  }
  .addr-line {
    font-size: 8pt;
    font-weight: 700;
    color: #000;
    margin-top: 1mm;
    line-height: 1.35;
  }
  .addr-line b {
    font-weight: 900;
  }
  hr {
    border: 0;
    border-top: 1px dashed #444;
    margin: 2.5mm 0;
  }
  /* Meta block: 4-column layout — two label/value pairs per row to save paper. */
  .meta {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0 1.5mm;
    font-size: 8.5pt;
  }
  .meta td {
    padding: 0;
    vertical-align: middle;
  }
  .meta .label,
  .meta .label-r {
    font-weight: 700;
    white-space: nowrap;
    border: 1.2px solid #000;
    border-radius: 1px;
    padding: 0.5mm 2mm;
  }
  .meta .value {
    font-weight: 500;
    width: 50%;
    padding-left: 2mm;
  }
  .meta .value {
    font-weight: 500;
    width: 50%;
  }
  /* Items table — 4 columns. Crisp header row: solid black, no uppercase
     letter-spacing tricks (those go blurry on thermal). Just plain bold 9pt. */
  table.lines {
    width: 100%;
    border-collapse: collapse;
    font-size: 8.5pt;
    table-layout: fixed;
  }
  table.lines thead th {
    text-align: left;
    font-size: 9pt;
    font-weight: 900;
    color: #000;
    padding: 1.2mm 0.3mm;
    border-top: 1.5px solid #000;
    border-bottom: 1.5px solid #000;
  }
  table.lines thead th.right { text-align: right; }
  table.lines tbody td {
    padding: 1mm 0.3mm;
    vertical-align: top;
  }
  table.lines tbody tr + tr td {
    border-top: 1px dotted #999;
  }
  /* Column widths come from the <colgroup> in the markup — applying widths to
     <td> alone doesn't work with table-layout: fixed because the browser reads
     the first row's widths (the <thead>) which had no explicit width. <colgroup>
     applies regardless. Item column has no width → takes remaining ~42mm so
     "Apple Shake Medium" and "Banana Medium" render on a single line. */
  table.lines td.qty {
    font-weight: 700;
    white-space: nowrap;
    padding-top: 1.2mm;
  }
  table.lines td.qty span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 5mm;
    height: 5mm;
    padding: 0 0.8mm;
    border: 1.5px solid #000;
    border-radius: 50%;
    font-size: 8pt;
    line-height: 1;
  }
  table.lines td.item {
    word-wrap: break-word;
    overflow-wrap: break-word;
    font-weight: 600;
  }
  table.lines td.num {
    text-align: right;
    white-space: nowrap;
    font-weight: 500;
  }
  table.lines td.num.total {
    font-weight: 700;
  }
  /* TOTAL bar — slightly smaller than before but still emphatic via the heavy
     border + 900 weight. Kept compact so the bottom of the receipt isn't huge. */
  .totals {
    width: 100%;
    border-collapse: collapse;
    font-weight: 900;
    font-size: 11.5pt;
    margin-top: 1.5mm;
  }
  .totals tr.total-row td {
    border-top: 2px solid #000;
    border-bottom: 2px solid #000;
  }
  .totals tr.discount-row td, .totals tr.delivery-row td {
    font-size: 9.5pt;
    font-weight: 700;
    border: none;
    padding: 0.8mm 0;
    color: #222;
  }
  .totals tr.subtotal-row td {
    font-size: 9.5pt;
    font-weight: 600;
    border: none;
    padding: 0.8mm 0;
  }
  /* Amount received / cash return — printed only when the cashier used those
     optional fields. Cash return gets its own dashed rule + heavier weight
     since that's the number the cashier hands back to the customer. */
  .totals tr.payment-row td {
    font-size: 9.5pt;
    font-weight: 600;
    border: none;
    padding: 0.8mm 0;
  }
  .totals tr.cash-return-row td {
    font-size: 10.5pt;
    font-weight: 900;
    border: none;
    border-top: 1.5px dashed #000;
    padding: 1.2mm 0 0.8mm;
  }
  .totals td {
    padding: 1.5mm 0;
  }
  .totals .label-cell { letter-spacing: 1px; }
  .totals .num {
    text-align: right;
    white-space: nowrap;
  }
  /* Footer stays at owner-requested size. */
  .footer {
    text-align: center;
    margin-top: 4mm;
    font-size: 10pt;
    font-style: italic;
    color: #111;
    font-weight: 600;
  }
  /* Tagline under "Thank you!" — was blurry on thermal because of light gray
     (#444) + 500 weight + letter-spacing. Switching to pure black, 9pt, 700
     weight, no letter-spacing makes the printer's 203-dpi head render every
     glyph as a clean stroke. */
  .footer .small {
    display: block;
    font-style: normal;
    font-size: 9pt;
    color: #000;
    margin-top: 1mm;
    font-weight: 700;
  }
</style>
</head><body>
<div class="receipt">
  <div class="header-row">
    <div class="header-info">
      <h1>SABIR JUICE CORNER</h1>
      <div class="addr-line">Clifton Plaza, Multan Cantt.</div>
      <div class="addr-line"><b>Contact</b> 0321-6366000</div>
    </div>
    <img class="logo" src="${LOGO_MONO_DATA_URI}" alt="Sabir Juice Corner" />
  </div>
  <hr />
  <table class="meta">
    <tr>
      <td class="label">Date</td><td class="value">${orderDate}</td>
      <td class="label-r">Order</td><td class="value">${orderTime}</td>
    </tr>
    <tr>
      <td class="label">Print</td><td class="value" colspan="3">${printTime}</td>
    </tr>
  </table>
  <hr />
  <table class="lines">
    <colgroup>
      <col style="width: 7mm" />
      <col />
      <col style="width: 11mm" />
      <col style="width: 12mm" />
    </colgroup>
    <thead>
      <tr>
        <th>Qty</th>
        <th>Item</th>
        <th class="right">Rate</th>
        <th class="right">Total</th>
      </tr>
    </thead>
    <tbody>
      ${lines}
    </tbody>
  </table>
  <table class="totals">
    <tr class="subtotal-row">
      <td class="label-cell">Total Items</td>
      <td class="num">${totalQtyStr}</td>
    </tr>
    ${(Number(order.discountAmount) > 0 || Number(order.deliveryCharge ?? 0) > 0) ? `
    <tr class="subtotal-row">
      <td class="label-cell">Subtotal</td>
      <td class="num">PKR ${formatMoney(Number(order.subtotal))}</td>
    </tr>` : ""}
    ${Number(order.discountAmount) > 0 ? `
    <tr class="discount-row">
      <td class="label-cell">Discount</td>
      <td class="num">- PKR ${formatMoney(Number(order.discountAmount))}</td>
    </tr>` : ""}
    ${Number(order.deliveryCharge ?? 0) > 0 ? `
    <tr class="delivery-row">
      <td class="label-cell">Delivery Charge</td>
      <td class="num">+ PKR ${formatMoney(Number(order.deliveryCharge))}</td>
    </tr>` : ""}
    <tr class="total-row">
      <td class="label-cell">TOTAL</td>
      <td class="num">PKR ${formatMoney(Number(order.total))}</td>
    </tr>
    ${payment ? `
    <tr class="payment-row">
      <td class="label-cell">Amount Received</td>
      <td class="num">PKR ${formatMoney(payment.amountReceived)}</td>
    </tr>
    <tr class="cash-return-row">
      <td class="label-cell">Cash Return</td>
      <td class="num">PKR ${formatMoney(payment.cashReturn)}</td>
    </tr>` : ""}
  </table>
  <div class="footer">
    Thank you!
    <span class="small">Serving fresh Juices since 1973</span>
  </div>
</div>
  <script>
    // Hand focus back to the POS tab once the print dialog closes. The window
    // itself is left open and reused for the next print (see getPrintWindow()
    // in receipt.ts) instead of closing — reopening a fresh popup every print
    // was the main source of the ~1.5s delay before the dialog appeared.
    window.addEventListener('afterprint', function () {
      if (window.opener) { try { window.opener.focus(); } catch (e) {} }
      window.blur();
    }, { once: true });
  </script>
</body></html>`;
}

// ─── Ledger Voucher print ─────────────────────────────────────────────────────

type LedgerPrintEntry = {
  entryDate: string;
  productName: string;
  quantity: string | null;
  rate: string | null;
  total: string;
  headName: string | null;
  supplierName: string | null;
  cashPaid: string;
  description: string | null;
  balance: number;
};

export function printLedgerEntry(entry: LedgerPrintEntry, accountName: string) {
  const html = ledgerVoucherHtml(entry, accountName);
  const win = getPrintWindow();
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
  lastPrintAt = Date.now();
}

// Numeric DD/MM/YYYY — used by the Petty Cash slip below.
function formatDateNumeric(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function ledgerVoucherHtml(entry: LedgerPrintEntry, accountName: string): string {
  const printedAt = new Date();
  const printDate = printedAt.toLocaleDateString("en-PK", { day: "2-digit", month: "2-digit", year: "numeric" });
  const printTime = printedAt.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
  const total = parseFloat(entry.total) || 0;
  const cashPaid = parseFloat(entry.cashPaid) || 0;
  // entry.balance is the running balance AFTER this entry (balance = previous
  // + total − cashPaid, same formula LedgerScreen uses to build it) — back it
  // out so the voucher shows where the account stood before this transaction,
  // not just before/after in one undifferentiated number.
  const previousBalance = entry.balance - total + cashPaid;
  const docType =
    total > 0 && cashPaid === 0 ? "PURCHASE ENTRY" :
    total === 0 && cashPaid > 0 ? "PAYMENT VOUCHER" :
    total > 0 && cashPaid > 0   ? "PURCHASE &amp; PAYMENT" :
    "LEDGER VOUCHER";

  // Qty + Rate combined onto one line ("2 × PKR 250") instead of two rows —
  // one of several compactions here to cut a voucher that was mostly empty
  // whitespace down to roughly half its printed length.
  const qtyRateLine =
    entry.quantity && entry.rate ? `${escapeHtml(entry.quantity)} × PKR ${formatMoney(parseFloat(entry.rate))}` :
    entry.quantity ? escapeHtml(entry.quantity) :
    entry.rate ? `PKR ${formatMoney(parseFloat(entry.rate))}` :
    null;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>${docType} — ${escapeHtml(accountName)}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  @media screen { .receipt { visibility: hidden; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 500 9pt/1.4 "Arial Narrow", Arial, sans-serif;
    color: #000;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .receipt, .receipt * { page-break-inside: avoid !important; break-inside: avoid !important; }
  .receipt { page-break-after: avoid !important; break-after: avoid !important; }
  .header-row { display: flex; align-items: center; justify-content: space-between; gap: 2mm; }
  .logo { width: 14mm; height: auto; flex-shrink: 0; filter: contrast(2); -webkit-print-color-adjust: exact; }
  h1 { font-size: 11pt; margin: 0; letter-spacing: 0.5px; font-weight: 900; }
  hr { border: 0; border-top: 1px dashed #444; margin: 1.5mm 0; }
  .doc-title { text-align: center; font-size: 9.5pt; font-weight: 900; letter-spacing: 0.5px; }
  table.fields { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  table.fields td { padding: 0.6mm 0; vertical-align: top; }
  table.fields td.lbl { font-weight: 700; white-space: nowrap; width: 26%; padding-right: 2mm; }
  table.totals { width: 100%; border-collapse: collapse; }
  table.totals td { padding: 0.8mm 0; font-size: 9pt; font-weight: 700; }
  table.totals .num { text-align: right; }
  table.totals tr.balance-row td { font-size: 11pt; font-weight: 900; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 1.2mm 0; }
  .notes { font-size: 8pt; margin-top: 0.8mm; font-style: italic; }
  .footer-line { text-align: center; font-size: 7.5pt; font-weight: 700; margin-top: 1mm; }
</style>
</head><body>
<div class="receipt">
  <div class="header-row">
    <img class="logo" src="${LOGO_MONO_DATA_URI}" alt="Sabir Juice Corner" />
    <h1>SABIR JUICE CORNER</h1>
    <div style="width:14mm"></div>
  </div>
  <hr />
  <div class="doc-title">${docType}</div>
  <hr />
  <table class="fields">
    <tr><td class="lbl">Date</td><td>${escapeHtml(entry.entryDate)}</td></tr>
    ${entry.supplierName ? `<tr><td class="lbl">Supplier</td><td>${escapeHtml(entry.supplierName)}</td></tr>` : ""}
    <tr><td class="lbl">Product</td><td>${escapeHtml(entry.productName)}</td></tr>
    ${qtyRateLine ? `<tr><td class="lbl">Qty × Rate</td><td>${qtyRateLine}</td></tr>` : ""}
  </table>
  <hr />
  <table class="totals">
    <tr><td>Previous Balance</td><td class="num">PKR ${formatMoney(previousBalance)}</td></tr>
    ${total > 0 ? `<tr><td>Total Amount</td><td class="num">PKR ${formatMoney(total)}</td></tr>` : ""}
    ${cashPaid > 0 ? `<tr><td>Cash Paid</td><td class="num">PKR ${formatMoney(cashPaid)}</td></tr>` : ""}
    <tr class="balance-row"><td>BALANCE</td><td class="num">PKR ${formatMoney(entry.balance)}</td></tr>
  </table>
  ${entry.description ? `<div class="notes">Notes: ${escapeHtml(entry.description)}</div>` : ""}
  <div class="footer-line">Printed: ${printDate} ${printTime}</div>
</div>
<script>
  window.addEventListener('afterprint', function () {
    if (window.opener) { try { window.opener.focus(); } catch (e) {} }
    window.blur();
  }, { once: true });
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
}

// ─── Shop Debt Summary print (from the Stats page's Total Shop Debt card) ──

type DebtSummaryLine = { position: number; name: string; debt: number };

export function printDebtSummary(data: { totalBilled: number; totalPaid: number; totalDebt: number; breakdown: DebtSummaryLine[] }) {
  const html = debtSummaryHtml(data);
  const win = getPrintWindow();
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
  lastPrintAt = Date.now();
}

function debtSummaryHtml(data: { totalBilled: number; totalPaid: number; totalDebt: number; breakdown: DebtSummaryLine[] }): string {
  const printedAt = new Date();
  const printDate = printedAt.toLocaleDateString("en-PK", { day: "2-digit", month: "2-digit", year: "numeric" });
  const printTime = printedAt.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });

  const rows = data.breakdown.map((b) => `
    <tr>
      <td class="acct">${b.position}. ${escapeHtml(b.name)}</td>
      <td class="num ${b.debt < 0 ? "credit" : ""}">PKR ${formatMoney(b.debt)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Shop Debt Summary</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  @media screen { .receipt { visibility: hidden; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 500 9pt/1.4 "Arial Narrow", Arial, sans-serif;
    color: #000;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .receipt, .receipt * { page-break-inside: avoid !important; break-inside: avoid !important; }
  .receipt { page-break-after: avoid !important; break-after: avoid !important; }
  .header-row { display: flex; align-items: center; justify-content: space-between; gap: 2mm; }
  .logo { width: 14mm; height: auto; flex-shrink: 0; filter: contrast(2); -webkit-print-color-adjust: exact; }
  h1 { font-size: 11pt; margin: 0; letter-spacing: 0.5px; font-weight: 900; }
  hr { border: 0; border-top: 1px dashed #444; margin: 1.5mm 0; }
  .doc-title { text-align: center; font-size: 9.5pt; font-weight: 900; letter-spacing: 0.5px; }
  table.totals { width: 100%; border-collapse: collapse; }
  table.totals td { padding: 0.8mm 0; font-size: 9pt; font-weight: 700; }
  table.totals .num { text-align: right; }
  table.totals tr.debt-row td { font-size: 12pt; font-weight: 900; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 1.2mm 0; }
  .section-hdr { font-size: 8pt; font-weight: 900; letter-spacing: 0.5px; margin: 1.5mm 0 0.5mm; }
  table.breakdown { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  table.breakdown td { padding: 0.6mm 0; }
  table.breakdown td.acct { font-weight: 600; }
  table.breakdown td.num { text-align: right; font-weight: 700; white-space: nowrap; }
  table.breakdown td.num.credit { color: #006600; }
  .footer-line { text-align: center; font-size: 7.5pt; font-weight: 700; margin-top: 1mm; }
</style>
</head><body>
<div class="receipt">
  <div class="header-row">
    <img class="logo" src="${LOGO_MONO_DATA_URI}" alt="Sabir Juice Corner" />
    <h1>SABIR JUICE CORNER</h1>
    <div style="width:14mm"></div>
  </div>
  <hr />
  <div class="doc-title">SHOP DEBT SUMMARY</div>
  <hr />
  <table class="totals">
    <tr><td>Total Billed</td><td class="num">PKR ${formatMoney(data.totalBilled)}</td></tr>
    <tr><td>Total Paid</td><td class="num">PKR ${formatMoney(data.totalPaid)}</td></tr>
    <tr class="debt-row"><td>${data.totalDebt < 0 ? "NET CREDIT" : "TOTAL DEBT"}</td><td class="num">PKR ${formatMoney(Math.abs(data.totalDebt))}</td></tr>
  </table>
  ${data.breakdown.length > 0 ? `
  <div class="section-hdr">BREAKDOWN BY ACCOUNT</div>
  <table class="breakdown">${rows}</table>` : ""}
  <hr />
  <div class="footer-line">Printed: ${printDate} ${printTime}</div>
</div>
<script>
  window.addEventListener('afterprint', function () {
    if (window.opener) { try { window.opener.focus(); } catch (e) {} }
    window.blur();
  }, { once: true });
</script>
</body></html>`;
}

// ─── Account Report — thermal (80mm) summary print ─────────────────────────

type ThermalReportEntry = {
  entryDate: string; productName: string; quantity: string | null;
  total: number; cashPaid: number; balance: number;
};
type ThermalReportGroup = {
  position: number; name: string; totalAmount: number; totalCashPaid: number;
  entries: ThermalReportEntry[];
};

/**
 * A compact 80mm alternative to the full-page Account Report PDF — grand
 * totals, per-account breakdown, AND a condensed entry-by-entry table (date,
 * product, total, running balance; cash-paid folded into a one-line note
 * instead of its own column). Detail is compressed, not dropped — for the
 * unabridged version with the full 10-column table, use "Download PDF" on
 * the report screen.
 */
export function printAccountReportThermal(data: {
  dateRange: string;
  filtersText: string | null;
  rowCount: number;
  groups: ThermalReportGroup[];
  grandTotalAmount: number;
  grandTotalCashPaid: number;
}) {
  const html = accountReportThermalHtml(data);
  const win = getPrintWindow();
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
  lastPrintAt = Date.now();
}

function accountReportThermalHtml(data: {
  dateRange: string;
  filtersText: string | null;
  rowCount: number;
  groups: ThermalReportGroup[];
  grandTotalAmount: number;
  grandTotalCashPaid: number;
}): string {
  const printedAt = new Date();
  const printDate = printedAt.toLocaleDateString("en-PK", { day: "2-digit", month: "2-digit", year: "numeric" });
  const printTime = printedAt.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
  const grandBalance = data.grandTotalAmount - data.grandTotalCashPaid;

  const breakdownRows = data.groups.map((g) => {
    const bal = g.totalAmount - g.totalCashPaid;
    return `
    <tr>
      <td class="acct">${g.position}. ${escapeHtml(g.name)}</td>
      <td class="num">${formatMoney(g.totalAmount)}</td>
      <td class="num">${formatMoney(g.totalCashPaid)}</td>
      <td class="num ${bal < 0 ? "credit" : ""}">${formatMoney(bal)}</td>
    </tr>`;
  }).join("");

  const groupSections = data.groups.map((g) => {
    const bal = g.totalAmount - g.totalCashPaid;
    const entryRows = g.entries.map((e) => {
      const qtyTxt = e.quantity ? ` ×${escapeHtml(e.quantity)}` : "";
      return `
      <tr>
        <td class="dt">${escapeHtml(formatDateNumeric(e.entryDate))}</td>
        <td class="prod">${escapeHtml(e.productName)}${qtyTxt}</td>
        <td class="num">${formatMoney(e.total)}</td>
        <td class="num ${e.balance < 0 ? "credit" : ""}">${formatMoney(e.balance)}</td>
      </tr>
      ${e.cashPaid > 0 ? `<tr class="paid-row"><td colspan="4">Paid: PKR ${formatMoney(e.cashPaid)}</td></tr>` : ""}`;
    }).join("");

    return `
    <div class="acct-hdr">
      <span>${g.position}. ${escapeHtml(g.name)}</span>
      <span class="acct-bal ${bal < 0 ? "credit" : ""}">Bal: ${formatMoney(bal)}</span>
    </div>
    <table class="entries">
      <tr><th>Date</th><th>Product</th><th>Total</th><th>Bal</th></tr>
      ${entryRows}
    </table>`;
  }).join("<hr />");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Account Report</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  @media screen { .receipt { visibility: hidden; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 500 9pt/1.4 "Arial Narrow", Arial, sans-serif;
    color: #000;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .receipt, .receipt * { page-break-inside: avoid !important; break-inside: avoid !important; }
  .header-row { display: flex; align-items: center; justify-content: space-between; gap: 2mm; }
  .logo { width: 14mm; height: auto; flex-shrink: 0; filter: contrast(2); -webkit-print-color-adjust: exact; }
  h1 { font-size: 11pt; margin: 0; letter-spacing: 0.5px; font-weight: 900; }
  hr { border: 0; border-top: 1px dashed #444; margin: 1.5mm 0; }
  .doc-title { text-align: center; font-size: 9.5pt; font-weight: 900; letter-spacing: 0.5px; }
  .meta { text-align: center; font-size: 8pt; margin-top: 0.5mm; color: #333; }
  table.totals { width: 100%; border-collapse: collapse; }
  table.totals td { padding: 0.8mm 0; font-size: 9pt; font-weight: 700; }
  table.totals .num { text-align: right; }
  table.totals tr.balance-row td { font-size: 12pt; font-weight: 900; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 1.2mm 0; }
  .section-hdr { font-size: 8pt; font-weight: 900; letter-spacing: 0.5px; margin: 1.5mm 0 0.5mm; }
  table.breakdown { width: 100%; border-collapse: collapse; font-size: 8pt; }
  table.breakdown th { text-align: right; font-size: 7pt; font-weight: 700; padding-bottom: 0.5mm; border-bottom: 1px solid #999; }
  table.breakdown th:first-child { text-align: left; }
  table.breakdown td { padding: 0.6mm 0; }
  table.breakdown td.acct { font-weight: 600; }
  table.breakdown td.num { text-align: right; font-weight: 700; white-space: nowrap; }
  table.breakdown td.num.credit { color: #006600; }
  .acct-hdr { display: flex; justify-content: space-between; align-items: baseline; font-size: 8.5pt; font-weight: 900; margin: 1.5mm 0 0.5mm; }
  .acct-bal { font-size: 7.5pt; font-weight: 700; }
  .acct-bal.credit { color: #006600; }
  table.entries { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
  table.entries th { text-align: right; font-size: 6.5pt; font-weight: 700; color: #555; padding-bottom: 0.5mm; border-bottom: 1px solid #999; }
  table.entries th:first-child, table.entries th:nth-child(2) { text-align: left; }
  table.entries td { padding: 0.5mm 0.5mm 0.5mm 0; vertical-align: top; }
  table.entries td.dt { white-space: nowrap; color: #444; width: 11mm; }
  table.entries td.prod { word-break: break-word; }
  table.entries td.num { text-align: right; font-weight: 700; white-space: nowrap; width: 15mm; }
  table.entries td.num.credit { color: #006600; }
  table.entries tr.paid-row td { padding: 0 0 0.8mm 11mm; font-size: 6.5pt; font-style: italic; color: #555; }
  .footer-line { text-align: center; font-size: 7.5pt; font-weight: 700; margin-top: 1mm; }
</style>
</head><body>
<div class="receipt">
  <div class="header-row">
    <img class="logo" src="${LOGO_MONO_DATA_URI}" alt="Sabir Juice Corner" />
    <h1>SABIR JUICE CORNER</h1>
    <div style="width:14mm"></div>
  </div>
  <hr />
  <div class="doc-title">ACCOUNT REPORT</div>
  <div class="meta">${escapeHtml(data.dateRange)}</div>
  ${data.filtersText ? `<div class="meta">${escapeHtml(data.filtersText)}</div>` : ""}
  <hr />
  <table class="totals">
    <tr><td>Total Entries</td><td class="num">${data.rowCount}</td></tr>
    <tr><td>Total Amount</td><td class="num">PKR ${formatMoney(data.grandTotalAmount)}</td></tr>
    <tr><td>Total Cash Paid</td><td class="num">PKR ${formatMoney(data.grandTotalCashPaid)}</td></tr>
    <tr class="balance-row"><td>${grandBalance < 0 ? "OVERPAID" : "BALANCE"}</td><td class="num">PKR ${formatMoney(Math.abs(grandBalance))}</td></tr>
  </table>
  ${data.groups.length > 1 ? `
  <div class="section-hdr">BY ACCOUNT (PKR)</div>
  <table class="breakdown">
    <tr><th>Account</th><th>Total</th><th>Paid</th><th>Balance</th></tr>
    ${breakdownRows}
  </table>` : ""}
  <hr />
  <div class="section-hdr">ENTRY DETAIL</div>
  ${groupSections}
  <hr />
  <div class="footer-line">Printed: ${printDate} ${printTime}</div>
</div>
<script>
  window.addEventListener('afterprint', function () {
    if (window.opener) { try { window.opener.focus(); } catch (e) {} }
    window.blur();
  }, { once: true });
</script>
</body></html>`;
}

/**
 * Money rendering for the receipt columns.
 * - Integer values print as-is (`320`, not `320.00`) — keeps columns tight on
 *   80mm thermal paper.
 * - Non-integers (e.g. a 0.5× mix line's rate) print with 2 decimals.
 * - Uses Pakistani locale separators (`8,450`, not `8450` or `8.450`).
 */
function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 100) / 100;
  if (Number.isInteger(rounded)) return rounded.toLocaleString("en-PK");
  return rounded.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── Petty Cash slip (stapled to next day's opening float) ────────────────

/**
 * A deliberately tiny slip — just the date the cash is FOR (next business
 * date, not today) and the amount — to staple to the petty cash set aside
 * at closing for tomorrow's opening float. No logo/address/items table;
 * this never leaves the drawer/envelope, so it doesn't need shop branding.
 */
export function printPettyCashSlip(data: { forDate: string; amount: number }) {
  const html = pettyCashSlipHtml(data);
  const win = getPrintWindow();
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
  lastPrintAt = Date.now();
}

function pettyCashSlipHtml(data: { forDate: string; amount: number }): string {
  const dateLabel = formatDateNumeric(data.forDate);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Petty Cash</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  @media screen { .receipt { visibility: hidden; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 500 9pt/1.4 "Arial Narrow", Arial, sans-serif;
    color: #000;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .receipt, .receipt * { page-break-inside: avoid !important; break-inside: avoid !important; }
  .receipt { page-break-after: avoid !important; break-after: avoid !important; }
  .title { text-align: center; font-size: 11pt; font-weight: 900; letter-spacing: 0.5px; }
  hr { border: 0; border-top: 1px dashed #444; margin: 1.5mm 0; }
  .row { display: flex; justify-content: space-between; margin: 1mm 0; font-size: 9pt; }
  .lbl { font-weight: 700; }
  .amount-row { text-align: center; margin-top: 1mm; }
  .amount-lbl { font-size: 9pt; font-weight: 700; }
  .amount-val { font-size: 13pt; font-weight: 900; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 1.2mm 0; margin-top: 1mm; }
</style>
</head><body>
<div class="receipt">
  <div class="title">PETTY CASH</div>
  <hr />
  <div class="row"><span class="lbl">For Date</span><span>${dateLabel}</span></div>
  <div class="amount-row">
    <div class="amount-lbl">TOTAL PETTY CASH</div>
    <div class="amount-val">PKR ${formatMoney(data.amount)}</div>
  </div>
</div>
<script>
  window.addEventListener('afterprint', function () {
    if (window.opener) { try { window.opener.focus(); } catch (e) {} }
    window.blur();
  }, { once: true });
</script>
</body></html>`;
}

// ─── Statistics Summary — thermal (80mm) print ──────────────────────────────

/**
 * A values-only, no-charts summary of the Statistics page for the shop's
 * thermal printer — the donuts/bar charts on screen don't mean anything on
 * 80mm paper, so this just lists every figure and breakdown the page shows,
 * section by section, in the same order as the screen.
 */
export function printStatsSummary(data: {
  dateLabel: string;
  revenue: number; orderCnt: number; aov: number;
  top5: { name: string; glasses: number; revenue: number }[];
  boxStats: { label: string; rev: number; cnt: number }[];
  medQty: number; jumboQty: number;
  cashRev: number; creditRev: number; fpRev: number;
  shopDebt: number; totalCredit: number; netShopPosition: number;
  debtBreakdown: { position: number; name: string; debt: number }[];
  homeExpenseTotal: number; shopExpenseTotal: number; salariesTotal: number; totalCashPeriod: number;
  expenseByAccount: { position: number; name: string; amount: number }[];
}) {
  const html = statsSummaryHtml(data);
  const win = getPrintWindow();
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
  lastPrintAt = Date.now();
}

function statsSummaryHtml(data: Parameters<typeof printStatsSummary>[0]): string {
  const printedAt = new Date();
  const printDate = printedAt.toLocaleDateString("en-PK", { day: "2-digit", month: "2-digit", year: "numeric" });
  const printTime = printedAt.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
  const totalGlass = data.medQty + data.jumboQty;
  const payTotal = data.cashRev + data.creditRev + data.fpRev;
  const pct = (n: number, base: number) => base > 0 ? ((n / base) * 100).toFixed(1) : "0";

  const top5Rows = data.top5.map((it, i) => `
    <tr>
      <td class="rank">${i + 1}</td>
      <td class="name">${escapeHtml(it.name)}</td>
      <td class="num">${it.glasses % 1 === 0 ? it.glasses : it.glasses.toFixed(1)}g</td>
      <td class="num">${formatMoney(it.revenue)}</td>
    </tr>`).join("");

  const boxRows = data.boxStats.map((b) => `
    <tr>
      <td class="name" colspan="2">${escapeHtml(b.label)}</td>
      <td class="num">${b.cnt}</td>
      <td class="num">${formatMoney(b.rev)}</td>
    </tr>`).join("");

  const debtRows = data.debtBreakdown.map((g) => `
    <tr>
      <td class="name" colspan="3">${g.position}. ${escapeHtml(g.name)}</td>
      <td class="num ${g.debt < 0 ? "credit" : ""}">${formatMoney(g.debt)}</td>
    </tr>`).join("");

  const expRows = data.expenseByAccount.map((g) => `
    <tr>
      <td class="name" colspan="3">${g.position}. ${escapeHtml(g.name)}</td>
      <td class="num">${formatMoney(g.amount)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Statistics Summary</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  @media screen { .receipt { visibility: hidden; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 500 9pt/1.4 "Arial Narrow", Arial, sans-serif;
    color: #000;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .receipt, .receipt * { page-break-inside: avoid !important; break-inside: avoid !important; }
  .header-row { display: flex; align-items: center; justify-content: space-between; gap: 2mm; }
  .logo { width: 14mm; height: auto; flex-shrink: 0; filter: contrast(2); -webkit-print-color-adjust: exact; }
  h1 { font-size: 11pt; margin: 0; letter-spacing: 0.5px; font-weight: 900; }
  hr { border: 0; border-top: 1px dashed #444; margin: 1.5mm 0; }
  .doc-title { text-align: center; font-size: 9.5pt; font-weight: 900; letter-spacing: 0.5px; }
  .meta { text-align: center; font-size: 8pt; margin-top: 0.5mm; color: #333; }
  .section-hdr { font-size: 8pt; font-weight: 900; letter-spacing: 0.5px; margin: 2mm 0 0.8mm; border-bottom: 1px solid #000; padding-bottom: 0.5mm; }
  table.totals { width: 100%; border-collapse: collapse; }
  table.totals td { padding: 0.6mm 0; font-size: 9pt; font-weight: 700; }
  table.totals .num { text-align: right; }
  table.totals tr.hero td { font-size: 11pt; font-weight: 900; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 1mm 0; }
  table.rows { width: 100%; border-collapse: collapse; font-size: 8pt; }
  table.rows td { padding: 0.5mm 0; }
  table.rows td.rank { width: 5mm; color: #666; }
  table.rows td.name { font-weight: 600; }
  table.rows td.num { text-align: right; font-weight: 700; white-space: nowrap; padding-left: 2mm; }
  table.rows td.num.credit { color: #006600; }
  .footer-line { text-align: center; font-size: 7.5pt; font-weight: 700; margin-top: 2mm; }
</style>
</head><body>
<div class="receipt">
  <div class="header-row">
    <img class="logo" src="${LOGO_MONO_DATA_URI}" alt="Sabir Juice Corner" />
    <h1>SABIR JUICE CORNER</h1>
    <div style="width:14mm"></div>
  </div>
  <hr />
  <div class="doc-title">STATISTICS SUMMARY</div>
  <div class="meta">${escapeHtml(data.dateLabel)}</div>
  <hr />

  <div class="section-hdr">OVERVIEW</div>
  <table class="totals">
    <tr><td>Total Revenue</td><td class="num">PKR ${formatMoney(data.revenue)}</td></tr>
    <tr><td>Paid Orders</td><td class="num">${data.orderCnt}</td></tr>
    <tr><td>Avg Order Value</td><td class="num">PKR ${formatMoney(data.aov)}</td></tr>
  </table>

  ${data.top5.length > 0 ? `
  <div class="section-hdr">TOP 5 ITEMS</div>
  <table class="rows">${top5Rows}</table>` : ""}

  ${data.boxStats.length > 0 ? `
  <div class="section-hdr">BOX / WAITER LEADERBOARD</div>
  <table class="rows">${boxRows}</table>` : ""}

  ${totalGlass > 0 ? `
  <div class="section-hdr">GLASS SIZE MIX</div>
  <table class="totals">
    <tr><td>Medium</td><td class="num">${data.medQty} (${pct(data.medQty, totalGlass)}%)</td></tr>
    <tr><td>Jumbo</td><td class="num">${data.jumboQty} (${pct(data.jumboQty, totalGlass)}%)</td></tr>
  </table>` : ""}

  ${payTotal > 0 ? `
  <div class="section-hdr">PAYMENT SPLIT</div>
  <table class="totals">
    ${data.cashRev > 0 ? `<tr><td>Cash</td><td class="num">PKR ${formatMoney(data.cashRev)} (${pct(data.cashRev, payTotal)}%)</td></tr>` : ""}
    ${data.creditRev > 0 ? `<tr><td>Credit (Accounts)</td><td class="num">PKR ${formatMoney(data.creditRev)} (${pct(data.creditRev, payTotal)}%)</td></tr>` : ""}
    ${data.fpRev > 0 ? `<tr><td>Food Panda</td><td class="num">PKR ${formatMoney(data.fpRev)} (${pct(data.fpRev, payTotal)}%)</td></tr>` : ""}
  </table>` : ""}

  <div class="section-hdr">TOTAL SHOP DEBT (all-time)</div>
  <table class="totals">
    <tr><td>Payable by shop</td><td class="num">PKR ${formatMoney(data.shopDebt)}</td></tr>
    <tr><td>Receivable from customers</td><td class="num">PKR ${formatMoney(data.totalCredit)}</td></tr>
    <tr class="hero"><td>${data.netShopPosition < 0 ? "NET OWED TO SHOP" : "NET OWED BY SHOP"}</td><td class="num">PKR ${formatMoney(Math.abs(data.netShopPosition))}</td></tr>
  </table>
  ${data.debtBreakdown.length > 0 ? `<table class="rows">${debtRows}</table>` : ""}

  ${(data.homeExpenseTotal !== 0 || data.shopExpenseTotal !== 0 || data.salariesTotal !== 0) ? `
  <div class="section-hdr">HOME/SHOP EXPENSE &amp; SALARIES (period)</div>
  <table class="totals">
    <tr><td>Home Expense</td><td class="num">PKR ${formatMoney(data.homeExpenseTotal)} (${pct(data.homeExpenseTotal, data.totalCashPeriod)}%)</td></tr>
    <tr><td>Shop Expense</td><td class="num">PKR ${formatMoney(data.shopExpenseTotal)} (${pct(data.shopExpenseTotal, data.totalCashPeriod)}%)</td></tr>
    <tr><td>Salaries</td><td class="num">PKR ${formatMoney(data.salariesTotal)} (${pct(data.salariesTotal, data.totalCashPeriod)}%)</td></tr>
  </table>` : ""}

  ${data.expenseByAccount.length > 0 ? `
  <div class="section-hdr">EXPENSE BY ACCOUNT (cash paid, period)</div>
  <table class="rows">${expRows}</table>` : ""}

  <hr />
  <div class="footer-line">Printed: ${printDate} ${printTime}</div>
</div>
<script>
  window.addEventListener('afterprint', function () {
    if (window.opener) { try { window.opener.focus(); } catch (e) {} }
    window.blur();
  }, { once: true });
</script>
</body></html>`;
}
