import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Modal, Field } from "./RawMaterials";

/**
 * Daily Hisaab — modern replacement for the old desktop software's stack of
 * identical books (SALARY / DAILY HISAAB / MENDI / MARKEET BILL / KAMETY / ALI BHAI HISAAB).
 *
 * Layout matches the owner's old data-entry workflow exactly:
 *   Date | Product Name | Quantity | Rate | Total | Head Account | Supplier Name | Cash Paid | Description | [Save]
 *
 * Why all 9 fields:
 *   • Product Name = what was bought / paid for (autocompletes from history)
 *   • Quantity / Rate / Total = transaction breakdown — Total auto-computes
 *     from Qty × Rate but is editable so the owner can override.
 *   • Cash Paid = what actually left the cash drawer. Differs from Total when
 *     paying an advance (Total=0, Cash=5000) or buying on credit (Total=8500, Cash=0).
 *   • Head Account = the head/category (Salary, Shop Expense, etc.) — dropdown
 *     of categories the owner has added, with + new to create more.
 *   • Supplier Name = payee / vendor — autocompletes from history.
 *   • Description = free-text notes.
 *
 * Keyboard rhythm — same as the desktop software:
 *   ENTER moves to the next field. ENTER on the last field (Description) saves
 *   and resets the row, with focus snapping back to Product Name for the next
 *   entry. The Head Account stays sticky so several rows of the same kind can
 *   be punched in a row without re-picking.
 *
 * Filters: multi-select Head Account, plus contains-match for Supplier and Product.
 */

type Category = { id: string; name: string };
type Expense = {
  id: string;
  amount: string;                  // Cash Paid
  productName: string | null;
  quantity: string | null;
  rate: string | null;
  total: string | null;
  vendor: string | null;           // Supplier Name
  notes: string | null;            // Description
  businessDate: string;            // YYYY-MM-DD
  paidAt: string;                  // ISO
  category: { id: string; name: string };
  branch: { id: string; code: string; name: string };
  paidBy: { id: string; fullName: string; username: string } | null;
};

const BRANCH_ID = "2";   // single-branch dev install

export function Hisaab() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [rows, setRows] = useState<Expense[]>([]);
  const [totals, setTotals] = useState<{ count: number; amount: string; total: string }>({ count: 0, amount: "0", total: "0" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  // Autocomplete sources — populated from /expenses/suggestions on mount and
  // after each save so newly-typed values become re-usable immediately.
  const [productSuggestions, setProductSuggestions] = useState<string[]>([]);
  const [supplierSuggestions, setSupplierSuggestions] = useState<string[]>([]);

  // ─── Filters ──────────────────────────────────────────────────────────
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const [filterCategoryIds, setFilterCategoryIds] = useState<Set<string>>(new Set());
  const [vendorFilter, setVendorFilter] = useState<string>("");
  const [productFilter, setProductFilter] = useState<string>("");

  // ─── Entry-form state ────────────────────────────────────────────────
  const [date, setDate] = useState(todayIso);
  const [productName, setProductName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [rate, setRate] = useState("");
  const [total, setTotal] = useState("");
  const [totalEdited, setTotalEdited] = useState(false);   // tracks whether user overrode the auto-Total
  // Head Account is now a free-text combobox — type any name. On save, an
  // existing category with that name is reused (case-insensitive); otherwise a
  // new category gets created automatically. Same UX as Product Name and Supplier Name.
  const [headAccount, setHeadAccount] = useState<string>("");
  const [supplierName, setSupplierName] = useState("");
  const [cashPaid, setCashPaid] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // Refs for tab-Enter navigation. Order matches visual layout left-to-right.
  const refDate     = useRef<HTMLInputElement>(null);
  const refProduct  = useRef<HTMLInputElement>(null);
  const refQty      = useRef<HTMLInputElement>(null);
  const refRate     = useRef<HTMLInputElement>(null);
  const refTotal    = useRef<HTMLInputElement>(null);
  const refHead     = useRef<HTMLInputElement>(null);
  const refSupplier = useRef<HTMLInputElement>(null);
  const refCash     = useRef<HTMLInputElement>(null);
  const refDesc     = useRef<HTMLInputElement>(null);

  const [editing, setEditing] = useState<Expense | null>(null);

  // ─── Loaders ─────────────────────────────────────────────────────────
  async function loadCategories() {
    try {
      const r = await api<{ categories: Category[] }>("GET", "/expenses/categories");
      setCategories(r.categories);
    } catch (e: any) { setError(e.body?.error || e.message); }
  }

  async function loadSuggestions() {
    try {
      const r = await api<{ products: string[]; suppliers: string[] }>("GET", `/expenses/suggestions?branchId=${BRANCH_ID}`);
      setProductSuggestions(r.products);
      setSupplierSuggestions(r.suppliers);
    } catch { /* non-fatal */ }
  }

  async function loadRows() {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ branchId: BRANCH_ID, from, to, limit: "200" });
      if (filterCategoryIds.size > 0) qs.set("categoryIds", [...filterCategoryIds].join(","));
      if (vendorFilter.trim()) qs.set("vendor", vendorFilter.trim());
      if (productFilter.trim()) qs.set("productName", productFilter.trim());
      const r = await api<{ expenses: Expense[]; totals: { count: number; amount: string; total: string } }>(
        "GET", `/expenses?${qs}`,
      );
      setRows(r.expenses);
      setTotals(r.totals);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadCategories(); loadSuggestions(); }, []);
  useEffect(() => {
    const t = setTimeout(loadRows, 200);
    return () => clearTimeout(t);
  }, [from, to, filterCategoryIds, vendorFilter, productFilter]);

  function flash(msg: string) {
    setSavedToast(msg);
    setTimeout(() => setSavedToast(null), 2500);
  }

  // ─── Auto-Total = Qty × Rate (unless the user manually edited Total) ──
  // The owner can override the computed total (e.g. round the figure, apply
  // a small discount inline). Touching Quantity or Rate resets the override.
  useEffect(() => {
    if (totalEdited) return;
    const q = parseFloat(quantity);
    const r = parseFloat(rate);
    if (!Number.isFinite(q) || !Number.isFinite(r)) { setTotal(""); return; }
    const t = q * r;
    setTotal(t === 0 ? "" : t.toFixed(2).replace(/\.?0+$/, ""));
  }, [quantity, rate, totalEdited]);

  /**
   * Resolve the typed Head Account string into a categoryId.
   *   • If an existing category matches (case-insensitive, trimmed), use its id.
   *   • Otherwise, create a new category with the typed name and use the new id.
   * Returns null and sets an error if the name is empty / creation fails.
   */
  async function resolveOrCreateCategory(name: string): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) { setError("Head account is required"); return null; }
    const existing = categories.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing.id;
    try {
      const r = await api<{ category: Category }>("POST", "/expenses/categories", { name: trimmed });
      // Insert into local list so future typeahead picks it up immediately.
      setCategories((cs) => [...cs, r.category].sort((a, b) => a.name.localeCompare(b.name)));
      return r.category.id;
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not create head account");
      return null;
    }
  }

  // ─── Save ────────────────────────────────────────────────────────────
  async function saveEntry() {
    if (!cashPaid && !total) { setError("Either Total or Cash Paid is required"); return; }
    setSaving(true); setError(null);
    try {
      const resolvedCategoryId = await resolveOrCreateCategory(headAccount);
      if (!resolvedCategoryId) { setSaving(false); return; }
      const r = await api<{ expense: Expense }>("POST", "/expenses", {
        branchId: Number(BRANCH_ID),
        categoryId: Number(resolvedCategoryId),
        amount: Number(cashPaid) || 0,                    // Cash Paid
        productName: productName.trim() || undefined,
        quantity: quantity ? Number(quantity) : undefined,
        rate: rate ? Number(rate) : undefined,
        total: total ? Number(total) : undefined,
        vendor: supplierName.trim() || undefined,
        notes: description.trim() || undefined,
        businessDate: date,
      });
      setRows((cur) => [r.expense, ...cur]);
      setTotals((t) => ({
        count: t.count + 1,
        amount: (Number(t.amount) + Number(r.expense.amount)).toFixed(2),
        total:  (Number(t.total)  + Number(r.expense.total ?? 0)).toFixed(2),
      }));
      // Update suggestions if the user typed a brand-new product / supplier
      if (productName.trim() && !productSuggestions.includes(productName.trim())) {
        setProductSuggestions((s) => [...s, productName.trim()].sort());
      }
      if (supplierName.trim() && !supplierSuggestions.includes(supplierName.trim())) {
        setSupplierSuggestions((s) => [...s, supplierName.trim()].sort());
      }
      flash(`Saved · PKR ${Number(r.expense.amount).toLocaleString("en-PK")} → ${r.expense.category.name}${r.expense.vendor ? " · " + r.expense.vendor : ""}`);
      resetForm({ keepCategory: true, keepDate: true });
      // Focus snaps back to Product Name for the next row
      refProduct.current?.focus();
    } catch (e: any) {
      setError(e.body?.error || e.message || "Could not save");
    } finally { setSaving(false); }
  }

  function resetForm(opts: { keepCategory?: boolean; keepDate?: boolean } = {}) {
    if (!opts.keepDate) setDate(todayIso);
    setProductName("");
    setQuantity("");
    setRate("");
    setTotal("");
    setTotalEdited(false);
    // Head Account stays sticky between consecutive entries — the owner usually
    // punches several rows under the same head (Salary, Salary, Salary…).
    if (!opts.keepCategory) setHeadAccount("");
    setSupplierName("");
    setCashPaid("");
    setDescription("");
  }

  async function deleteEntry(row: Expense) {
    const ok = window.confirm(
      `Delete this entry?\n\n  ${row.businessDate}  PKR ${row.amount}  ${row.category.name}\n  ${row.vendor ?? ""}\n\nThis can't be undone.`,
    );
    if (!ok) return;
    try {
      await api("DELETE", `/expenses/${row.id}`);
      setRows((cur) => cur.filter((r) => r.id !== row.id));
      setTotals((t) => ({
        count: Math.max(0, t.count - 1),
        amount: (Number(t.amount) - Number(row.amount)).toFixed(2),
        total:  (Number(t.total)  - Number(row.total ?? 0)).toFixed(2),
      }));
      flash("Deleted");
    } catch (e: any) { setError(e.body?.error || e.message); }
  }

  // ─── Enter-to-next-field navigation ───────────────────────────────────
  // We attach onKeyDown to every form input. ENTER on intermediate inputs
  // shifts focus to the next ref. ENTER on the LAST input (Description)
  // triggers save. SHIFT+ENTER inserts a newline normally (description is
  // a regular input so this isn't applicable but keeps the pattern clear).
  function onEnter(e: React.KeyboardEvent, nextRef: React.RefObject<HTMLInputElement | HTMLSelectElement>) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    nextRef.current?.focus();
    if (nextRef.current instanceof HTMLInputElement) nextRef.current.select();
  }
  /**
   * ENTER on Supplier Name → move to Cash Paid, and PRE-FILL Cash Paid with
   * the Total value if it's empty. The most common case is "Cash Paid == Total"
   * (a normal purchase paid in full); pre-filling means the owner doesn't have
   * to retype the same number. They can still type over it (the field auto-
   * selects on focus) when it's an advance or a credit purchase.
   */
  function onSupplierEnter(e: React.KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (!cashPaid && total) setCashPaid(total);
    refCash.current?.focus();
    refCash.current?.select();
  }
  function onEnterSave(e: React.KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    saveEntry();
  }

  // ─── Filter helpers ──────────────────────────────────────────────────
  function toggleCategoryFilter(id: string) {
    setFilterCategoryIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* Header strip — title + cash-out total */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Daily Hisaab</h1>
          <div className="text-xs text-slate-500 mt-0.5">
            Date · Product · Qty · Rate · Total · Head Account · Supplier · Cash Paid · Description. ENTER moves to the next field; last ENTER saves.
          </div>
        </div>
        <div className="flex gap-2">
          <div className="rounded-lg bg-slate-100 border border-slate-200 px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-slate-600">Filtered total value</div>
            <div className="font-mono font-bold text-base text-slate-900">PKR {Number(totals.total).toLocaleString("en-PK")}</div>
          </div>
          <div className="rounded-lg bg-accent-50 border-2 border-accent-300 px-4 py-2 text-right">
            <div className="text-[10px] uppercase tracking-wider text-accent-700">Filtered cash paid</div>
            <div className="font-mono font-bold text-xl text-accent-900">PKR {Number(totals.amount).toLocaleString("en-PK")}</div>
            <div className="text-[10px] text-slate-500">{totals.count} {totals.count === 1 ? "entry" : "entries"}</div>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="card p-3 space-y-3">
        <div className="grid grid-cols-12 gap-3 items-end">
          <Field label="From">
            <input type="date" className="input w-full" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" className="input w-full" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="col-span-3">
            <div className="text-xs text-slate-600 mb-1">Supplier (contains)</div>
            <input className="input w-full" placeholder="e.g. M.Karimullah" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} list="supplier-suggestions" />
          </div>
          <div className="col-span-3">
            <div className="text-xs text-slate-600 mb-1">Product (contains)</div>
            <input className="input w-full" placeholder="e.g. Petrol" value={productFilter} onChange={(e) => setProductFilter(e.target.value)} list="product-suggestions" />
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <button className="btn-secondary text-xs" onClick={() => { setFrom(todayIso); setTo(todayIso); setFilterCategoryIds(new Set()); setVendorFilter(""); setProductFilter(""); }}>
              Today only
            </button>
          </div>
        </div>
        {/* Head Account multi-select pills */}
        <div>
          <div className="text-xs text-slate-600 mb-1.5 flex items-center justify-between">
            <span>Head accounts ({filterCategoryIds.size === 0 ? "All" : `${filterCategoryIds.size} selected`})</span>
            {filterCategoryIds.size > 0 && (
              <button className="text-[10px] text-slate-500 hover:underline" onClick={() => setFilterCategoryIds(new Set())}>clear</button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {categories.length === 0 && <div className="text-xs text-slate-400 italic">No head accounts yet — add one from the entry row below with "+ new".</div>}
            {categories.map((c) => {
              const on = filterCategoryIds.has(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleCategoryFilter(c.id)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${on ? "bg-accent-600 text-white border-accent-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
                >
                  {on && "✓ "}{c.name}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ─── Entry row ─────────────────────────────────────────────────── */}
      <div className="card border-2 border-leaf-500 p-3 bg-leaf-500/5">
        <div className="grid grid-cols-12 gap-2 items-end">
          {/* Date — col 1 */}
          <div className="col-span-1">
            <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Date</div>
            <input
              ref={refDate}
              type="date"
              className="input w-full font-mono text-xs"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              onKeyDown={(e) => onEnter(e, refProduct)}
            />
          </div>
          {/* Product Name — col 2 */}
          <div className="col-span-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Product Name</div>
            <input
              ref={refProduct}
              className="input w-full"
              placeholder="e.g. Petrol Motorcycle"
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              onKeyDown={(e) => onEnter(e, refQty)}
              list="product-suggestions"
            />
          </div>
          {/* Quantity */}
          <div className="col-span-1">
            <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Quantity</div>
            <input
              ref={refQty}
              type="text" inputMode="decimal"
              className="input w-full font-mono text-right"
              value={quantity}
              onChange={(e) => { setQuantity(e.target.value.replace(/[^0-9.]/g, "")); setTotalEdited(false); }}
              onKeyDown={(e) => onEnter(e, refRate)}
            />
          </div>
          {/* Rate */}
          <div className="col-span-1">
            <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Rate</div>
            <input
              ref={refRate}
              type="text" inputMode="decimal"
              className="input w-full font-mono text-right"
              value={rate}
              onChange={(e) => { setRate(e.target.value.replace(/[^0-9.]/g, "")); setTotalEdited(false); }}
              onKeyDown={(e) => onEnter(e, refTotal)}
            />
          </div>
          {/* Total — auto from Qty × Rate, editable */}
          <div className="col-span-1">
            <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Total</div>
            <input
              ref={refTotal}
              type="text" inputMode="decimal"
              className={`input w-full font-mono text-right ${totalEdited ? "bg-amber-50" : ""}`}
              value={total}
              onChange={(e) => { setTotal(e.target.value.replace(/[^0-9.]/g, "")); setTotalEdited(true); }}
              onKeyDown={(e) => onEnter(e, refHead)}
              title={totalEdited ? "Total was overridden manually — touch Qty or Rate to recompute." : ""}
            />
          </div>
          {/* Head Account — combobox: type freely. Existing categories appear
              as autocomplete suggestions via the datalist. Anything you type
              that doesn't match an existing head gets auto-created on save. */}
          <div className="col-span-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Head Account</div>
            <input
              ref={refHead}
              className="input w-full"
              placeholder="e.g. Salary, Shop Expense"
              value={headAccount}
              onChange={(e) => setHeadAccount(e.target.value)}
              onKeyDown={(e) => onEnter(e, refSupplier)}
              list="head-account-suggestions"
            />
          </div>
          {/* Supplier Name */}
          <div className="col-span-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Supplier Name</div>
            <input
              ref={refSupplier}
              className="input w-full"
              placeholder="e.g. M.Karimullah"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              onKeyDown={onSupplierEnter}
              list="supplier-suggestions"
            />
          </div>
          {/* Cash Paid */}
          <div className="col-span-1">
            <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Cash Paid</div>
            <input
              ref={refCash}
              type="text" inputMode="decimal"
              className="input w-full font-mono text-right"
              value={cashPaid}
              onChange={(e) => setCashPaid(e.target.value.replace(/[^0-9.]/g, ""))}
              onKeyDown={(e) => onEnter(e, refDesc)}
            />
          </div>
          {/* Description */}
          <div className="col-span-1">
            <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Description</div>
            <input
              ref={refDesc}
              className="input w-full"
              placeholder="optional"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={onEnterSave}
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 mt-3 pt-2 border-t border-leaf-500/30">
          <div className="text-[10px] text-slate-500 mr-auto">
            <kbd className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-mono text-[10px]">ENTER</kbd>
            <span className="ml-1">moves to next field · last ENTER (on Description) saves</span>
          </div>
          <button className="btn-secondary text-xs" onClick={() => resetForm()}>Clear</button>
          <button className="btn-primary px-6" onClick={saveEntry} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>

      {error && <div className="card p-3 text-sm text-red-700 bg-red-50 border border-red-200">{error}</div>}

      {/* Ledger table */}
      <div className="card overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="w-24">Date</th>
              <th>Product</th>
              <th className="text-right w-16">Qty</th>
              <th className="text-right w-20">Rate</th>
              <th className="text-right w-24">Total</th>
              <th>Head Account</th>
              <th>Supplier</th>
              <th className="text-right w-24">Cash Paid</th>
              <th>Description</th>
              <th className="w-24 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td colSpan={10} className="text-center text-slate-400 py-6">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={10} className="text-center text-slate-400 py-8">No entries match this filter.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.businessDate}</td>
                <td className="text-sm">{r.productName ?? <span className="text-slate-300">—</span>}</td>
                <td className="text-right font-mono text-xs">{r.quantity ? Number(r.quantity).toLocaleString("en-PK") : <span className="text-slate-300">—</span>}</td>
                <td className="text-right font-mono text-xs">{r.rate ? Number(r.rate).toLocaleString("en-PK") : <span className="text-slate-300">—</span>}</td>
                <td className="text-right font-mono">{r.total ? Number(r.total).toLocaleString("en-PK") : <span className="text-slate-300">—</span>}</td>
                <td><span className="pill bg-slate-100 text-slate-700 text-xs">{r.category.name}</span></td>
                <td className="text-sm">{r.vendor ?? <span className="text-slate-300">—</span>}</td>
                <td className="text-right font-mono font-medium">{Number(r.amount).toLocaleString("en-PK")}</td>
                <td className="text-xs text-slate-600">{r.notes ?? <span className="text-slate-300">—</span>}</td>
                <td className="text-right space-x-1 whitespace-nowrap">
                  <button className="btn-ghost text-xs py-1" onClick={() => setEditing(r)}>Edit</button>
                  <button className="btn-ghost text-xs py-1 text-red-700 hover:bg-red-50" onClick={() => deleteEntry(r)}>Del</button>
                </td>
              </tr>
            ))}
            {rows.length > 0 && (
              <tr className="bg-slate-50 font-bold border-t-2 border-slate-300">
                <td colSpan={4} className="text-right uppercase text-xs tracking-wider text-slate-600 py-2">Totals</td>
                <td className="text-right font-mono">{Number(totals.total).toLocaleString("en-PK")}</td>
                <td colSpan={2}></td>
                <td className="text-right font-mono">{Number(totals.amount).toLocaleString("en-PK")}</td>
                <td colSpan={2}></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* HTML5 datalists provide the autocomplete dropdowns the inputs reference */}
      <datalist id="product-suggestions">
        {productSuggestions.map((p) => <option key={p} value={p} />)}
      </datalist>
      <datalist id="supplier-suggestions">
        {supplierSuggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
      <datalist id="head-account-suggestions">
        {categories.map((c) => <option key={c.id} value={c.name} />)}
      </datalist>

      {editing && (
        <EditEntryModal
          row={editing}
          categories={categories}
          productSuggestions={productSuggestions}
          supplierSuggestions={supplierSuggestions}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setRows((cur) => cur.map((r) => r.id === updated.id ? updated : r));
            setTotals((t) => {
              const old = rows.find((r) => r.id === updated.id);
              const deltaAmount = old ? Number(updated.amount) - Number(old.amount) : 0;
              const deltaTotal  = old ? (Number(updated.total ?? 0) - Number(old.total ?? 0)) : 0;
              return { count: t.count, amount: (Number(t.amount) + deltaAmount).toFixed(2), total: (Number(t.total) + deltaTotal).toFixed(2) };
            });
            setEditing(null);
            flash("Saved");
          }}
        />
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

// ─── Edit modal ────────────────────────────────────────────────────────

function EditEntryModal({ row, categories, productSuggestions: _ps, supplierSuggestions: _ss, onClose, onSaved }: {
  row: Expense;
  categories: Category[];
  productSuggestions: string[];
  supplierSuggestions: string[];
  onClose: () => void;
  onSaved: (updated: Expense) => void;
}) {
  const [date, setDate] = useState(row.businessDate);
  const [productName, setProductName] = useState(row.productName ?? "");
  const [quantity, setQuantity] = useState(row.quantity ?? "");
  const [rate, setRate] = useState(row.rate ?? "");
  const [total, setTotal] = useState(row.total ?? "");
  const [totalEdited, setTotalEdited] = useState(true);   // assume edited so we don't fight the user's saved value
  // Same combobox UX as the main entry row — type any head-account name.
  const [headAccount, setHeadAccount] = useState(row.category.name);
  const [supplierName, setSupplierName] = useState(row.vendor ?? "");
  const [cashPaid, setCashPaid] = useState(row.amount);
  const [description, setDescription] = useState(row.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (totalEdited) return;
    const q = parseFloat(quantity);
    const r = parseFloat(rate);
    if (!Number.isFinite(q) || !Number.isFinite(r)) return;
    setTotal((q * r).toFixed(2).replace(/\.?0+$/, ""));
  }, [quantity, rate, totalEdited]);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      // Resolve/create the head-account name → categoryId. Same logic as the
      // main entry form, inlined here so the modal stays self-contained.
      const trimmed = headAccount.trim();
      if (!trimmed) { setError("Head account is required"); setBusy(false); return; }
      let categoryId: string;
      const existing = categories.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
      if (existing) {
        categoryId = existing.id;
      } else {
        const created = await api<{ category: Category }>("POST", "/expenses/categories", { name: trimmed });
        categoryId = created.category.id;
      }
      const r = await api<{ expense: Expense }>("PATCH", `/expenses/${row.id}`, {
        amount: Number(cashPaid) || 0,
        categoryId: Number(categoryId),
        productName: productName.trim() || null,
        quantity: quantity ? Number(quantity) : null,
        rate: rate ? Number(rate) : null,
        total: total ? Number(total) : null,
        vendor: supplierName.trim() || null,
        notes: description.trim() || null,
        businessDate: date,
      });
      onSaved(r.expense);
    } catch (e: any) { setError(e.body?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Edit entry`} onClose={onClose} wide>
      <form onSubmit={save} className="grid grid-cols-12 gap-3">
        <Field label="Date"><input type="date" className="input w-full font-mono" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <div className="col-span-3"><div className="text-xs text-slate-600 mb-1">Product Name</div><input className="input w-full" value={productName} onChange={(e) => setProductName(e.target.value)} list="product-suggestions" /></div>
        <Field label="Qty"><input className="input w-full font-mono text-right" value={quantity} onChange={(e) => { setQuantity(e.target.value.replace(/[^0-9.]/g, "")); setTotalEdited(false); }} /></Field>
        <Field label="Rate"><input className="input w-full font-mono text-right" value={rate} onChange={(e) => { setRate(e.target.value.replace(/[^0-9.]/g, "")); setTotalEdited(false); }} /></Field>
        <Field label="Total"><input className="input w-full font-mono text-right" value={total} onChange={(e) => { setTotal(e.target.value.replace(/[^0-9.]/g, "")); setTotalEdited(true); }} /></Field>
        <div className="col-span-3"><div className="text-xs text-slate-600 mb-1">Head Account</div><input className="input w-full" value={headAccount} onChange={(e) => setHeadAccount(e.target.value)} list="head-account-suggestions" /></div>
        <div className="col-span-4"><div className="text-xs text-slate-600 mb-1">Supplier Name</div><input className="input w-full" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} list="supplier-suggestions" /></div>
        <Field label="Cash Paid"><input className="input w-full font-mono text-right" value={cashPaid} onChange={(e) => setCashPaid(e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
        <div className="col-span-12"><div className="text-xs text-slate-600 mb-1">Description</div><input className="input w-full" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        {error && <div className="col-span-12 text-sm text-red-600">{error}</div>}
        <div className="col-span-12 flex gap-2 pt-2 border-t">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
    </Modal>
  );
}

