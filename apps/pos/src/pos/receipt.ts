import { displayItemName, type BoxOrder } from "./posState";

/**
 * Render a receipt for a BoxOrder and open the browser's print dialog.
 *
 * Layout: 80mm-wide thermal-receipt format, Segoe UI (with sans-serif fallbacks
 * for non-Windows printers). Line-art logo at the top (uses /logo-mono.png —
 * the line-art version prints sharper on thermal than a solid fill),
 * bold metadata labels, generous spacing on the items table, heavy TOTAL line.
 *
 * Image loading:
 *   The receipt embeds <img src="/logo-mono.png"> from the app's origin. We
 *   inject a tiny script that waits for the logo to load (or fail) before
 *   triggering window.print() — without it, the print dialog can fire before
 *   the logo is ready and the printed receipt has a broken image placeholder.
 *
 * For ESC/POS thermal printers later: the same HTML is structured so a Node
 * service (or WebUSB-based driver) can pick it up and translate to printer
 * commands. The logo would be re-rasterised by the printer driver.
 */

export function printReceipt(order: BoxOrder, header: { branchName: string; cashier: string }, onDone?: () => void) {
  const html = receiptHtml(order, header);
  // Open in a separate window so window.print() inside it never blocks the main
  // POS tab. An iframe's window.print() call on Windows Chrome/Edge synchronously
  // freezes the parent tab's JS event loop until the print dialog is dismissed.
  const win = window.open("", "_blank", "width=1,height=1,left=-9999,top=-9999,noopener");
  if (!win) {
    // Popup blocked — still call onDone so the POS doesn't get stuck waiting.
    onDone?.();
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  if (onDone) {
    win.addEventListener("afterprint", () => onDone(), { once: true });
  }
}

function receiptHtml(order: BoxOrder, header: { branchName: string; cashier: string }): string {
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
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Receipt ${order.orderNo ?? order.localId}</title>
<style>
  /* Reverted to the original @page margin (4mm) and zero body padding — the
     combo of margin:0 + body padding was making Chrome generate a 2nd blank
     "page" for tall receipts, which the printer then cut as an empty strip. */
  @page { size: 80mm auto; margin: 4mm; }
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
  .totals tr:last-child td {
    border-top: 2px solid #000;
    border-bottom: 2px solid #000;
  }
  .totals tr.discount-row td {
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
    <img class="logo" src="/logo-mono.png" alt="Sabir Juice Corner" />
  </div>
  <hr />
  <table class="meta">
    <tr>
      <td class="label">Date</td><td class="value">${orderDate}</td>
      <td class="label-r">Order</td><td class="value">${orderTime}</td>
    </tr>
    <tr>
      <td class="label">Cashier</td><td class="value">${escapeHtml(header.cashier)}</td>
      <td class="label-r">Print</td><td class="value">${printTime}</td>
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
    ${Number(order.discountAmount) > 0 ? `
    <tr class="subtotal-row">
      <td class="label-cell">Subtotal</td>
      <td class="num">PKR ${formatMoney(Number(order.subtotal))}</td>
    </tr>
    <tr class="discount-row">
      <td class="label-cell">Discount</td>
      <td class="num">- PKR ${formatMoney(Number(order.discountAmount))}</td>
    </tr>` : ""}
    <tr>
      <td class="label-cell">TOTAL</td>
      <td class="num">PKR ${formatMoney(Number(order.total))}</td>
    </tr>
  </table>
  <div class="footer">
    Thank you!
    <span class="small">Serving fresh Juices since 1973</span>
  </div>
</div>
  <script>
    (function () {
      // Wait for the logo to load (or error out) before opening the print dialog —
      // otherwise the printed receipt has a broken-image placeholder where the logo
      // should be.
      function doPrint() { try { window.focus(); window.print(); } catch (e) {} }
      var img = document.querySelector('img.logo');
      if (img && !img.complete) {
        img.addEventListener('load', doPrint);
        img.addEventListener('error', doPrint);
        setTimeout(doPrint, 1500);   // hard fallback so we never block forever
      } else {
        doPrint();
      }
    })();
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
  const win = window.open("", "_blank", "width=1,height=1,left=-9999,top=-9999,noopener");
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
}

function ledgerVoucherHtml(entry: LedgerPrintEntry, accountName: string): string {
  const printedAt = new Date();
  const printDate = printedAt.toLocaleDateString("en-PK", { day: "2-digit", month: "2-digit", year: "numeric" });
  const printTime = printedAt.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });
  const total = parseFloat(entry.total) || 0;
  const cashPaid = parseFloat(entry.cashPaid) || 0;
  const docType =
    total > 0 && cashPaid === 0 ? "PURCHASE ENTRY" :
    total === 0 && cashPaid > 0 ? "PAYMENT VOUCHER" :
    total > 0 && cashPaid > 0   ? "PURCHASE &amp; PAYMENT" :
    "LEDGER VOUCHER";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>${docType} — ${escapeHtml(accountName)}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 500 9pt/1.45 "Arial Narrow", Arial, sans-serif;
    color: #000;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .receipt, .receipt * { page-break-inside: avoid !important; break-inside: avoid !important; }
  .receipt { page-break-after: avoid !important; break-after: avoid !important; }
  .header-row { display: flex; align-items: center; justify-content: space-between; gap: 2mm; margin-bottom: 1.5mm; }
  .header-info { flex: 1; }
  .logo { width: 22mm; height: auto; flex-shrink: 0; filter: contrast(2); -webkit-print-color-adjust: exact; }
  h1 { font-size: 12pt; margin: 0; letter-spacing: 0.5px; font-weight: 900; }
  .addr-line { font-size: 8pt; font-weight: 700; color: #000; margin-top: 1mm; line-height: 1.35; }
  .addr-line b { font-weight: 900; }
  hr { border: 0; border-top: 1px dashed #444; margin: 2.5mm 0; }
  .doc-title { text-align: center; font-size: 11pt; font-weight: 900; letter-spacing: 1px; margin: 1mm 0 0.5mm; }
  .account-name { text-align: center; font-size: 8.5pt; font-weight: 700; margin-bottom: 0.5mm; }
  table.fields { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  table.fields td { padding: 1mm 0; vertical-align: top; }
  table.fields td.lbl { font-weight: 700; white-space: nowrap; width: 32%; padding-right: 2mm; }
  .section-hdr { font-size: 8pt; font-weight: 900; letter-spacing: 0.5px; margin: 1mm 0 0.5mm; }
  table.totals { width: 100%; border-collapse: collapse; margin-top: 1mm; }
  table.totals td { padding: 1.2mm 0; font-size: 9.5pt; font-weight: 700; }
  table.totals .num { text-align: right; }
  table.totals tr.balance-row td { font-size: 11.5pt; font-weight: 900; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 1.5mm 0; }
  .notes { font-size: 8pt; margin-top: 1.5mm; font-style: italic; }
  .footer-line { text-align: center; font-size: 8pt; font-weight: 700; margin-top: 1.5mm; }
</style>
</head><body>
<div class="receipt">
  <div class="header-row">
    <div class="header-info">
      <h1>SABIR JUICE CORNER</h1>
      <div class="addr-line">Clifton Plaza, Multan Cantt.</div>
      <div class="addr-line"><b>Contact</b> 0321-6366000</div>
    </div>
    <img class="logo" src="/logo-mono.png" alt="Sabir Juice Corner" />
  </div>
  <hr />
  <div class="doc-title">${docType}</div>
  <div class="account-name">${escapeHtml(accountName)}</div>
  <hr />
  <table class="fields">
    <tr><td class="lbl">Date</td><td>${escapeHtml(entry.entryDate)}</td></tr>
    ${entry.supplierName ? `<tr><td class="lbl">Supplier</td><td>${escapeHtml(entry.supplierName)}</td></tr>` : ""}
    ${entry.headName ? `<tr><td class="lbl">Head</td><td>${escapeHtml(entry.headName)}</td></tr>` : ""}
  </table>
  <hr />
  <div class="section-hdr">ITEM DETAILS</div>
  <table class="fields">
    <tr><td class="lbl">Product</td><td>${escapeHtml(entry.productName)}</td></tr>
    ${entry.quantity ? `<tr><td class="lbl">Qty</td><td>${escapeHtml(entry.quantity)}</td></tr>` : ""}
    ${entry.rate ? `<tr><td class="lbl">Rate</td><td>PKR ${formatMoney(parseFloat(entry.rate))}</td></tr>` : ""}
  </table>
  <hr />
  <table class="totals">
    ${total > 0 ? `<tr><td>Total Amount</td><td class="num">PKR ${formatMoney(total)}</td></tr>` : ""}
    ${cashPaid > 0 ? `<tr><td>Cash Paid</td><td class="num">PKR ${formatMoney(cashPaid)}</td></tr>` : ""}
    <tr class="balance-row"><td>BALANCE</td><td class="num">PKR ${formatMoney(entry.balance)}</td></tr>
  </table>
  ${entry.description ? `<div class="notes">Notes: ${escapeHtml(entry.description)}</div>` : ""}
  <hr />
  <div class="footer-line">Printed: ${printDate} ${printTime}</div>
  <div class="footer-line" style="font-weight:600;font-style:italic;margin-top:1mm;">Serving fresh Juices since 1973</div>
</div>
<script>
  (function () {
    function doPrint() { try { window.focus(); window.print(); } catch (e) {} }
    var img = document.querySelector('img.logo');
    if (img && !img.complete) {
      img.addEventListener('load', doPrint);
      img.addEventListener('error', doPrint);
      setTimeout(doPrint, 1500);
    } else { doPrint(); }
  })();
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
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
