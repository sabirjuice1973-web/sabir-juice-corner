import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LedgerAccount, type LedgerEntry } from "../api";

// ─── Window state ─────────────────────────────────────────────────────────────

type WinState = {
  x: number; y: number; w: number; h: number;
  minimized: boolean; maximized: boolean;
};

function defaultWin(): WinState {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(1200, vw * 0.88);
  const h = vh * 0.86;
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h, minimized: false, maximized: false };
}

// ─── Entry form types ─────────────────────────────────────────────────────────

type EntryFormData = {
  entryDate: string;
  productName: string;
  quantity: string;
  rate: string;
  total: string;
  headName: string;
  supplierName: string;
  cashPaid: string;
  description: string;
};

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const EMPTY_FORM = (): EntryFormData => ({
  entryDate: todayIso(), productName: "", quantity: "", rate: "",
  total: "", headName: "", supplierName: "", cashPaid: "", description: "",
});

// ─── Main floating window ────────────────────────────────────────────────────

type Props = { branchId: string; shiftId: string; businessDate: string | null; onClose: () => void };

export function LedgerScreen({ branchId, shiftId, businessDate, onClose }: Props) {
  const [win, setWin] = useState<WinState>(defaultWin);
  const winRef = useRef(win);
  useEffect(() => { winRef.current = win; });

  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // All entries for selected account (sorted ASC for balance calc)
  const [allEntries, setAllEntries] = useState<LedgerEntry[]>([]);
  const [loadingAcc, setLoadingAcc] = useState(true);
  const [loadingEntries, setLoadingEntries] = useState(false);
  // Date filter for the main entry view — defaults to business date (not calendar date)
  const [viewDate, setViewDate] = useState<string>(businessDate ?? todayIso());

  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<LedgerEntry | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [showCashToday, setShowCashToday] = useState(false);

  // ── Drag / resize ──────────────────────────────────────────────────────────
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; ow: number; oh: number; type: string } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { cleanupRef.current?.(); }, []);

  function startDrag(e: React.PointerEvent, type: string) {
    if (winRef.current.maximized) return;
    e.stopPropagation();
    const w = winRef.current;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y, ow: w.w, oh: w.h, type };
    const MIN_W = 480, MIN_H = 320;
    function onMove(ev: PointerEvent) {
      const d = dragRef.current!;
      const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      const origX = d.ox, origY = d.oy, origW = d.ow, origH = d.oh;
      let nx = origX, ny = origY, nw = origW, nh = origH;
      switch (d.type) {
        case "move": nx = origX + dx; ny = origY + dy; break;
        case "e":  nw = Math.max(MIN_W, origW + dx); break;
        case "s":  nh = Math.max(MIN_H, origH + dy); break;
        case "w":  { nw = Math.max(MIN_W, origW - dx); nx = origX + origW - nw; break; }
        case "n":  { nh = Math.max(MIN_H, origH - dy); ny = origY + origH - nh; break; }
        case "se": nw = Math.max(MIN_W, origW + dx); nh = Math.max(MIN_H, origH + dy); break;
        case "sw": { nw = Math.max(MIN_W, origW - dx); nx = origX + origW - nw; nh = Math.max(MIN_H, origH + dy); break; }
        case "ne": { nw = Math.max(MIN_W, origW + dx); nh = Math.max(MIN_H, origH - dy); ny = origY + origH - nh; break; }
        case "nw": { nw = Math.max(MIN_W, origW - dx); nx = origX + origW - nw; nh = Math.max(MIN_H, origH - dy); ny = origY + origH - nh; break; }
      }
      setWin((prev) => ({ ...prev, x: nx, y: ny, w: nw, h: nh }));
    }
    function onUp() {
      dragRef.current = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      cleanupRef.current = null;
    }
    cleanupRef.current = onUp;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function toggleMaximize() {
    setWin((prev) =>
      prev.maximized
        ? { ...prev, maximized: false }
        : { ...prev, maximized: true, minimized: false }
    );
  }
  function toggleMinimize() {
    setWin((prev) => ({ ...prev, minimized: !prev.minimized, maximized: false }));
  }

  // ── Data loading ───────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const { accounts: accs } = await api.ledgerAccounts(branchId);
        setAccounts(accs);
        if (accs.length > 0) setSelectedId(accs[0].id);
      } catch {}
      setLoadingAcc(false);
    })();
  }, [branchId]);

  const loadEntries = useCallback(async (accountId: string, date: string) => {
    setLoadingEntries(true);
    try {
      const { entries: es } = await api.ledgerEntries(accountId, { from: date, to: date, limit: 5000, sort: "asc" });
      setAllEntries(es);
    } catch {}
    setLoadingEntries(false);
  }, []);

  useEffect(() => {
    if (selectedId) void loadEntries(selectedId, viewDate);
  }, [selectedId, viewDate, loadEntries]);

  // Entries sorted desc for display, with running balance (computed on ASC order).
  // Balance = cumulative (Total − CashPaid): positive means money still owed/receivable,
  // negative means more paid out than received.
  const entriesWithBalance = (() => {
    let running = 0;
    return allEntries.map((e) => {
      running += parseFloat(e.total) - parseFloat(e.cashPaid);
      return { ...e, balance: running };
    });
  })();
  const displayEntries = [...entriesWithBalance].reverse(); // newest first

  // ── Rename ─────────────────────────────────────────────────────────────────
  function startRename(acc: LedgerAccount) { setRenamingId(acc.id); setRenameValue(acc.name); }
  async function saveRename() {
    if (!renamingId || !renameValue.trim()) return;
    try {
      const { account } = await api.renameAccount(renamingId, renameValue.trim());
      setAccounts((p) => p.map((a) => (a.id === account.id ? account : a)));
    } catch {}
    setRenamingId(null);
  }

  // ── Delete entry ───────────────────────────────────────────────────────────
  async function handleDelete(entryId: string) {
    if (!confirm("Delete this entry?")) return;
    try {
      await api.deleteLedgerEntry(entryId);
      setAllEntries((p) => p.filter((e) => e.id !== entryId));
    } catch {}
  }

  const selectedAccount = accounts.find((a) => a.id === selectedId) ?? null;

  // ── Window geometry ────────────────────────────────────────────────────────
  const containerStyle: React.CSSProperties = win.maximized
    ? { position: "fixed", inset: 0, zIndex: 60 }
    : win.minimized
    ? { position: "fixed", right: 24, bottom: 0, width: 320, height: 40, zIndex: 60 }
    : { position: "fixed", left: win.x, top: win.y, width: win.w, height: win.h, zIndex: 60 };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop — clicking it minimizes the Hisaab window so cashier can use POS */}
      {!win.minimized && (
        <div className="fixed inset-0 z-50 bg-black/10 cursor-pointer" onClick={toggleMinimize} />
      )}

      <div style={containerStyle} className="flex flex-col bg-white shadow-2xl border border-slate-400 rounded-t-lg overflow-hidden select-none">
        {/* Title bar — draggable */}
        <div
          className="flex items-center justify-between px-3 py-1.5 bg-gradient-to-r from-blue-800 to-blue-600 text-white shrink-0 cursor-move"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            if (!win.maximized && !win.minimized) startDrag(e, "move");
          }}
          onDoubleClick={toggleMaximize}
        >
          <div className="flex items-center gap-2 min-w-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
            <span className="font-semibold text-sm truncate">Accounts / Hisaab Kitaab</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!win.minimized && (
              <>
                <button type="button" onClick={() => setShowCashToday(true)}
                  className="px-2.5 py-0.5 rounded bg-green-500 hover:bg-green-400 text-white text-xs font-semibold">
                  Cash Today
                </button>
                <button type="button" onClick={() => setShowReport(true)}
                  className="px-2.5 py-0.5 rounded bg-blue-400 hover:bg-blue-300 text-white text-xs font-semibold">
                  Report
                </button>
              </>
            )}
            {/* Minimize */}
            <button type="button" onClick={toggleMinimize}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/20 text-white text-base leading-none ml-1"
              title="Minimize">
              <span className="block w-3 h-0.5 bg-white mt-2" />
            </button>
            {/* Maximize / Restore */}
            <button type="button" onClick={toggleMaximize}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/20 text-white"
              title={win.maximized ? "Restore" : "Maximize"}>
              {win.maximized
                ? <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="0" width="8" height="8"/><rect x="0" y="3" width="8" height="8" fill="white" stroke="currentColor"/></svg>
                : <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="0" y="0" width="11" height="11"/></svg>}
            </button>
            {/* Close */}
            <button type="button" onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-500 text-white font-bold text-base leading-none"
              title="Close">×</button>
          </div>
        </div>

        {/* Body — hidden when minimized */}
        {!win.minimized && (
          <div className="flex flex-1 min-h-0">
            {/* Sidebar */}
            <aside className="w-48 shrink-0 bg-slate-800 text-white flex flex-col overflow-y-auto">
              {loadingAcc ? (
                <div className="text-xs text-slate-400 p-3">Loading…</div>
              ) : accounts.map((acc) => (
                <div key={acc.id}>
                  {renamingId === acc.id ? (
                    <div className="px-2 py-1">
                      <input autoFocus value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveRename(); if (e.key === "Escape") setRenamingId(null); }}
                        onBlur={() => void saveRename()}
                        className="w-full text-xs bg-slate-700 text-white rounded px-1 py-0.5 border border-blue-400 outline-none"
                      />
                    </div>
                  ) : (
                    <button type="button"
                      onClick={() => { setSelectedId(acc.id); setShowForm(false); setEditingEntry(null); }}
                      onDoubleClick={() => startRename(acc)}
                      title="Double-click to rename"
                      className={`w-full text-left px-3 py-2 text-xs font-medium transition-colors ${
                        selectedId === acc.id ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      <span className="text-slate-400 mr-1">{acc.position}.</span>{acc.name}
                    </button>
                  )}
                </div>
              ))}
              <div className="mt-auto px-3 py-2 text-[10px] text-slate-500">Double-click to rename</div>
            </aside>

            {/* Main */}
            <div className="flex-1 min-w-0 flex flex-col bg-slate-50">
              {/* Sub-header */}
              <div className="flex items-center justify-between px-4 py-1.5 border-b bg-white shrink-0 gap-2">
                <div className="min-w-0">
                  <span className="font-semibold text-slate-800 text-sm">{selectedAccount?.name ?? "—"}</span>
                  <span className="ml-2 text-slate-400 text-xs">{allEntries.length} entries</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setViewDate(businessDate ?? todayIso())}
                    className={`px-2 py-1 rounded text-xs font-semibold border ${viewDate === (businessDate ?? todayIso()) ? "bg-slate-700 text-white border-slate-700" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`}
                  >
                    Today
                  </button>
                  <input
                    type="date"
                    value={viewDate}
                    onChange={(e) => setViewDate(e.target.value)}
                    className="border border-slate-300 rounded px-1.5 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <button type="button" onClick={() => { setEditingEntry(null); setShowForm(true); }}
                    className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs">
                    + Add Entry
                  </button>
                </div>
              </div>

              {/* Entry table — pr-3 keeps Edit/Del buttons clear of the right-edge resize handle */}
              <div className="flex-1 min-h-0 overflow-y-auto pr-3">
                {loadingEntries ? (
                  <div className="p-6 text-slate-400 text-sm text-center">Loading…</div>
                ) : displayEntries.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 text-slate-400">
                    <div className="text-3xl mb-1">📒</div>
                    <div className="text-xs">{viewDate === (businessDate ?? todayIso()) ? 'No entries today — click "+ Add Entry"' : `No entries on ${viewDate}`}</div>
                  </div>
                ) : (
                  <table className="w-full text-xs border-collapse">
                    <thead className="sticky top-0 bg-slate-100 border-b">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-slate-500 w-24">Date</th>
                        <th className="px-2 py-1.5 text-left text-slate-500">Product</th>
                        <th className="px-2 py-1.5 text-right text-slate-500 w-12">Qty</th>
                        <th className="px-2 py-1.5 text-right text-slate-500 w-20">Rate</th>
                        <th className="px-2 py-1.5 text-right text-slate-500 w-20">Total</th>
                        <th className="px-2 py-1.5 text-left text-slate-500 w-24">Head</th>
                        <th className="px-2 py-1.5 text-left text-slate-500 w-24">Supplier</th>
                        <th className="px-2 py-1.5 text-right text-slate-500 w-20">Cash Paid</th>
                        <th className="px-2 py-1.5 text-right text-slate-500 w-22">Balance</th>
                        <th className="px-2 py-1.5 text-left text-slate-500">Desc</th>
                        <th className="px-2 py-1.5 text-slate-500 w-10">📎</th>
                        <th className="px-2 py-1.5 w-14"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayEntries.map((e, idx) => (
                        <tr key={e.id}
                          className={`border-b hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? "bg-white" : "bg-slate-50"}`}>
                          <td className="px-2 py-1.5 text-slate-400 tabular-nums whitespace-nowrap">{e.entryDate}</td>
                          <td className="px-2 py-1.5 font-medium text-slate-800">{e.productName}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{e.quantity ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{e.rate ? fmtPKR(e.rate) : "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{fmtPKR(e.total)}</td>
                          <td className="px-2 py-1.5 text-slate-500 truncate max-w-[96px]" title={e.headName ?? ""}>{e.headName ?? "—"}</td>
                          <td className="px-2 py-1.5 text-slate-500 truncate max-w-[96px]" title={e.supplierName ?? ""}>{e.supplierName ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-red-700">{fmtPKR(e.cashPaid)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-blue-700">{fmtPKR(e.balance.toFixed(2))}</td>
                          <td className="px-2 py-1.5 text-slate-400 truncate max-w-[100px]" title={e.description ?? ""}>{e.description ?? ""}</td>
                          <td className="px-2 py-1.5 text-center">
                            {e.attachmentUrl && (
                              e.attachmentUrl.match(/\.(jpg|jpeg|png|webp|gif)$/i)
                                ? <a href={e.attachmentUrl} target="_blank" rel="noreferrer">
                                    <img src={e.attachmentUrl} alt="slip" className="h-7 w-7 object-cover rounded border border-slate-200 hover:opacity-80 inline-block" />
                                  </a>
                                : <a href={e.attachmentUrl} target="_blank" rel="noreferrer" title="View attachment" className="text-blue-500 hover:text-blue-700 text-base">📎</a>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1">
                              <button type="button" onClick={() => { setEditingEntry(e); setShowForm(true); }}
                                className="px-1.5 py-0.5 rounded bg-slate-200 hover:bg-blue-200 text-slate-700 text-[10px]">Edit</button>
                              <button type="button" onClick={() => void handleDelete(e.id)}
                                className="px-1.5 py-0.5 rounded bg-slate-200 hover:bg-red-200 text-red-700 text-[10px]">Del</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="sticky bottom-0">
                      <tr className="bg-slate-800 text-white">
                        <td colSpan={4} className="px-3 py-2 text-sm font-bold tracking-wide">TOTAL</td>
                        <td className="px-3 py-2 text-right tabular-nums text-sm font-bold text-white">
                          {fmtPKR(allEntries.reduce((s, e) => s + parseFloat(e.total), 0).toFixed(2))}
                        </td>
                        <td colSpan={2}></td>
                        <td className="px-3 py-2 text-right tabular-nums text-sm font-bold text-red-300">
                          {fmtPKR(allEntries.reduce((s, e) => s + parseFloat(e.cashPaid), 0).toFixed(2))}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-sm font-bold text-yellow-300">
                          {fmtPKR((entriesWithBalance[entriesWithBalance.length - 1]?.balance ?? 0).toFixed(2))}
                        </td>
                        <td colSpan={3}></td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Resize handles (shown when not maximized/minimized) */}
        {!win.maximized && !win.minimized && <>
          {rh("n",  "inset-x-2 top-0 h-1 cursor-n-resize",  "n",  startDrag)}
          {rh("s",  "inset-x-2 bottom-0 h-1 cursor-s-resize","s",  startDrag)}
          {rh("e",  "inset-y-2 right-0 w-1 cursor-e-resize", "e",  startDrag)}
          {rh("w",  "inset-y-2 left-0 w-1 cursor-w-resize",  "w",  startDrag)}
          {rh("nw", "top-0 left-0 w-3 h-3 cursor-nw-resize", "nw", startDrag)}
          {rh("ne", "top-0 right-0 w-3 h-3 cursor-ne-resize","ne", startDrag)}
          {rh("sw", "bottom-0 left-0 w-3 h-3 cursor-sw-resize","sw",startDrag)}
          {rh("se", "bottom-0 right-0 w-3 h-3 cursor-se-resize","se",startDrag)}
        </>}
      </div>

      {/* Entry form modal — hidden while minimized so clicking POS backdrop is unblocked */}
      {showForm && selectedId && !win.minimized && (
        <EntryFormModal
          key={editingEntry?.id ?? "new"}
          branchId={branchId}
          ledgerAccountId={selectedId}
          editing={editingEntry}
          onMinimize={toggleMinimize}
          onSave={() => {
            setShowForm(false);
            setEditingEntry(null);
            if (selectedId) void loadEntries(selectedId, viewDate);
          }}
          onCancel={() => { setShowForm(false); setEditingEntry(null); }}
        />
      )}

      {showReport && !win.minimized && (
        <ReportModal branchId={branchId} accounts={accounts} onMinimize={toggleMinimize} onClose={() => setShowReport(false)} />
      )}
      {showCashToday && !win.minimized && (
        <CashTodayModal branchId={branchId} shiftId={shiftId} onMinimize={toggleMinimize} onClose={() => setShowCashToday(false)} />
      )}
    </>
  );
}

// Resize handle helper
function rh(type: string, cls: string, _t: string, startDrag: (e: React.PointerEvent, t: string) => void) {
  return (
    <div key={type} className={`absolute z-10 ${cls}`}
      onPointerDown={(e) => startDrag(e, type)} />
  );
}

// ─── Entry Form Modal ─────────────────────────────────────────────────────────

const FIELD_ORDER: (keyof EntryFormData)[] = [
  "entryDate", "productName", "quantity", "rate", "total",
  "headName", "supplierName", "cashPaid", "description",
];

function EntryFormModal({
  branchId, ledgerAccountId, editing, onSave, onCancel, onMinimize,
}: {
  branchId: string; ledgerAccountId: string;
  editing: LedgerEntry | null;
  onSave: (e: LedgerEntry) => void;
  onCancel: () => void;
  onMinimize: () => void;
}) {
  const [form, setForm] = useState<EntryFormData>(() =>
    editing
      ? { entryDate: editing.entryDate, productName: editing.productName,
          quantity: editing.quantity ?? "", rate: editing.rate ?? "",
          total: editing.total, headName: editing.headName ?? "",
          supplierName: editing.supplierName ?? "", cashPaid: editing.cashPaid,
          description: editing.description ?? "" }
      : EMPTY_FORM()
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(editing?.attachmentUrl ?? null);
  const [uploading, setUploading] = useState(false);

  // Input refs for Enter-to-next-field
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  function focusNext(current: keyof EntryFormData) {
    const idx = FIELD_ORDER.indexOf(current);
    const next = FIELD_ORDER[idx + 1];
    if (next) inputRefs.current[next]?.focus();
  }
  function onFieldEnter(e: React.KeyboardEvent, field: keyof EntryFormData) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const isLast = FIELD_ORDER.indexOf(field) === FIELD_ORDER.length - 1;
    if (isLast) { void handleSubmit(); }
    else { focusNext(field); }
  }

  // Autocomplete
  type SuggField = "productName" | "supplierName" | "headName";
  const [sugg, setSugg] = useState<Record<SuggField, string[]>>({ productName: [], supplierName: [], headName: [] });
  const [activeSugg, setActiveSugg] = useState<SuggField | null>(null);
  const [suggIdx, setSuggIdx] = useState(-1);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function fetchSugg(field: SuggField, q: string) {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(async () => {
      try {
        const { suggestions } = await api.ledgerSuggestions(branchId, field, q, { accountId: ledgerAccountId });
        setSugg((p) => ({ ...p, [field]: suggestions }));
        setSuggIdx(-1);
      } catch {}
    }, 180);
  }

  function openSugg(field: SuggField, q: string) {
    setActiveSugg(field);
    fetchSugg(field, q);
  }

  function pickSugg(field: SuggField, value: string) {
    setForm((p) => ({ ...p, [field]: value }));
    setSugg((p) => ({ ...p, [field]: [] }));
    setActiveSugg(null);
    setSuggIdx(-1);
    // Move to next field
    focusNext(field);
  }

  function handleSuggKeyDown(e: React.KeyboardEvent, field: SuggField) {
    const list = sugg[field];
    if (!list.length || activeSugg !== field) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggIdx((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggIdx((i) => Math.max(i - 1, -1));
      if (suggIdx <= 0) { setActiveSugg(null); }
    } else if (e.key === "Enter" && suggIdx >= 0) {
      e.preventDefault();
      pickSugg(field, list[suggIdx]);
    } else if (e.key === "Escape") {
      setActiveSugg(null);
    }
  }

  // Auto-compute total = qty × rate; cashPaid mirrors total if not overridden
  const prevTotal = useRef(form.total);
  function handleQtyRate(field: "quantity" | "rate", value: string) {
    const next = { ...form, [field]: value };
    const qty = parseFloat(next.quantity), rate = parseFloat(next.rate);
    if (!isNaN(qty) && !isNaN(rate)) {
      const computed = (qty * rate).toFixed(2);
      const cashWasMirror = form.cashPaid === form.total || form.cashPaid === prevTotal.current;
      next.total = computed;
      if (cashWasMirror) next.cashPaid = computed;
    }
    prevTotal.current = next.total;
    setForm(next);
  }
  function handleTotalChange(value: string) {
    setForm((p) => {
      const sync = p.cashPaid === p.total;
      return { ...p, total: value, cashPaid: sync ? value : p.cashPaid };
    });
    prevTotal.current = value;
  }

  async function handleSubmit() {
    setError("");
    if (!form.productName.trim()) { setError("Product name is required"); return; }
    const totalVal = parseFloat(form.total) || 0;
    const cashVal = parseFloat(form.cashPaid) || 0;
    setBusy(true);
    try {
      if (editing) {
        const { entry } = await api.updateLedgerEntry(editing.id, {
          entryDate: form.entryDate, productName: form.productName.trim(),
          quantity: form.quantity ? parseFloat(form.quantity) : null,
          rate: form.rate ? parseFloat(form.rate) : null,
          total: totalVal, headName: form.headName.trim() || null,
          supplierName: form.supplierName.trim() || null, cashPaid: cashVal,
          description: form.description.trim() || null,
          attachmentUrl,
        });
        onSave(entry);
      } else {
        const { entry } = await api.createLedgerEntry({
          ledgerAccountId, entryDate: form.entryDate,
          productName: form.productName.trim(),
          quantity: form.quantity ? parseFloat(form.quantity) : null,
          rate: form.rate ? parseFloat(form.rate) : null,
          total: totalVal, headName: form.headName.trim() || null,
          supplierName: form.supplierName.trim() || null, cashPaid: cashVal,
          description: form.description.trim() || null,
          attachmentUrl,
        });
        onSave(entry);
      }
    } catch (err: any) {
      setError(err.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function suggestionBox(field: SuggField, label: string, placeholder: string, colSpan?: string) {
    const isActive = activeSugg === field;
    const list = sugg[field];
    return (
      <div className={`relative ${colSpan ?? ""}`}>
        <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
        <input
          ref={(el) => { inputRefs.current[field] = el; }}
          type="text" value={form[field]}
          onChange={(e) => { setForm((p) => ({ ...p, [field]: e.target.value })); openSugg(field, e.target.value); }}
          onFocus={() => openSugg(field, form[field])}
          onBlur={() => setTimeout(() => { setActiveSugg(null); setSuggIdx(-1); }, 160)}
          onKeyDown={(e) => {
            handleSuggKeyDown(e, field);
            if (e.key === "Enter" && suggIdx < 0) onFieldEnter(e, field);
          }}
          placeholder={placeholder}
          className={inputCls}
          autoComplete="off"
        />
        {isActive && list.length > 0 && (
          <ul className="absolute z-50 left-0 right-0 top-full mt-0.5 bg-white border border-slate-200 rounded shadow-lg max-h-36 overflow-y-auto">
            {list.map((item, i) => (
              <li key={item}>
                <button type="button" onMouseDown={() => pickSugg(field, item)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 ${i === suggIdx ? "bg-blue-100" : ""}`}>
                  {item}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onMinimize(); }}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="font-semibold text-slate-800 text-sm">{editing ? "Edit Entry" : "New Entry"}</h2>
          <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        <div className="p-4 grid grid-cols-2 gap-3">

          {/* Date */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Date</label>
            <input ref={(el) => { inputRefs.current.entryDate = el; }} type="date" value={form.entryDate}
              onChange={(e) => setForm((p) => ({ ...p, entryDate: e.target.value }))}
              onKeyDown={(e) => onFieldEnter(e, "entryDate")} className={inputCls} />
          </div>

          {/* Product Name with autocomplete */}
          {suggestionBox("productName", "Product Name *", "e.g. Sugar, Labour, Petrol")}

          {/* Qty */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Quantity</label>
            <input ref={(el) => { inputRefs.current.quantity = el; }} type="number"
              value={form.quantity} onChange={(e) => handleQtyRate("quantity", e.target.value)}
              onKeyDown={(e) => onFieldEnter(e, "quantity")}
              placeholder="0" min="0" step="any" className={inputCls} />
          </div>

          {/* Rate */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Rate (PKR)</label>
            <input ref={(el) => { inputRefs.current.rate = el; }} type="number"
              value={form.rate} onChange={(e) => handleQtyRate("rate", e.target.value)}
              onKeyDown={(e) => onFieldEnter(e, "rate")}
              placeholder="0" min="0" step="any" className={inputCls} />
          </div>

          {/* Total */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Total (PKR)</label>
            <input ref={(el) => { inputRefs.current.total = el; }} type="number"
              value={form.total} onChange={(e) => handleTotalChange(e.target.value)}
              onKeyDown={(e) => onFieldEnter(e, "total")}
              placeholder="0" min="0" step="any" className={inputCls} />
          </div>

          {/* Head Account */}
          {suggestionBox("headName", "Head Account", "e.g. Shop Expense, Salary")}

          {/* Supplier Name */}
          {suggestionBox("supplierName", "Supplier Name", "e.g. Ahmed Store, Ali Bhai")}

          {/* Cash Paid */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Cash Paid (PKR)</label>
            <input ref={(el) => { inputRefs.current.cashPaid = el; }} type="number"
              value={form.cashPaid} onChange={(e) => setForm((p) => ({ ...p, cashPaid: e.target.value }))}
              onKeyDown={(e) => onFieldEnter(e, "cashPaid")}
              placeholder="0" min="0" step="any" className={inputCls} />
          </div>

          {/* Description — last field, Enter = save */}
          <div className="col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">Description / Notes</label>
            <input ref={(el) => { inputRefs.current.description = el; }} type="text"
              value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              onKeyDown={(e) => onFieldEnter(e, "description")}
              placeholder="Optional — Enter to save" className={inputCls} />
          </div>

          {/* Attachment — optional slip/receipt image */}
          <div className="col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">Attachment <span className="text-slate-400 font-normal">(slip / receipt image — optional)</span></label>
            <div className="flex items-start gap-3">
              <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-medium cursor-pointer transition-colors ${uploading ? "bg-slate-100 text-slate-400 border-slate-200" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`}>
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3a1 1 0 0 1 .707.293l3 3a1 1 0 0 1-1.414 1.414L11 6.414V13a1 1 0 1 1-2 0V6.414L7.707 7.707A1 1 0 0 1 6.293 6.293l3-3A1 1 0 0 1 10 3z"/><path d="M3 15a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1z"/></svg>
                {uploading ? "Uploading…" : attachmentUrl ? "Replace" : "Upload image"}
                <input type="file" accept="image/*,.pdf" className="hidden" disabled={uploading}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setUploading(true);
                    try {
                      const { url } = await api.ledgerUploadAttachment(file);
                      setAttachmentUrl(url);
                    } catch { setError("Upload failed — try again"); }
                    finally { setUploading(false); e.target.value = ""; }
                  }} />
              </label>
              {attachmentUrl && (
                <div className="flex items-center gap-2">
                  {attachmentUrl.match(/\.(jpg|jpeg|png|webp|gif)$/i) ? (
                    <a href={attachmentUrl} target="_blank" rel="noreferrer">
                      <img src={attachmentUrl} alt="attachment" className="h-16 w-16 object-cover rounded border border-slate-200 hover:opacity-80" />
                    </a>
                  ) : (
                    <a href={attachmentUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline">View attachment</a>
                  )}
                  <button type="button" onClick={() => setAttachmentUrl(null)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
                </div>
              )}
            </div>
          </div>

          {error && <div className="col-span-2 text-xs text-red-600 bg-red-50 rounded px-3 py-2">{error}</div>}

          <div className="col-span-2 flex justify-end gap-2 pt-1">
            <button type="button" onClick={onCancel} className="px-4 py-1.5 rounded border text-slate-600 hover:bg-slate-50 text-xs">Cancel</button>
            <button type="button" onClick={() => void handleSubmit()} disabled={busy}
              className="px-5 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs disabled:opacity-50">
              {busy ? "Saving…" : editing ? "Update" : "Add Entry"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Report Modal ─────────────────────────────────────────────────────────────

function ReportModal({ branchId, accounts, onClose, onMinimize }: { branchId: string; accounts: LedgerAccount[]; onClose: () => void; onMinimize: () => void }) {
  const today = todayIso();
  const firstOfMonth = today.slice(0, 8) + "01";

  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set(accounts.map((a) => a.id)));
  const [headFilter, setHeadFilter] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [productFilter, setProductFilter] = useState("");

  // Autocomplete for filter fields (date-range-aware)
  type FilterField = "headFilter" | "supplierFilter" | "productFilter";
  const FILTER_API_FIELD: Record<FilterField, "headName" | "supplierName" | "productName"> = {
    headFilter: "headName", supplierFilter: "supplierName", productFilter: "productName",
  };
  const [filterSuggs, setFilterSuggs] = useState<Record<FilterField, string[]>>({ headFilter: [], supplierFilter: [], productFilter: [] });
  const [activeFilterSugg, setActiveFilterSugg] = useState<FilterField | null>(null);
  const [filterSuggIdx, setFilterSuggIdx] = useState(-1);
  const filterDebRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function fetchFilterSugg(field: FilterField, q: string) {
    if (filterDebRef.current) clearTimeout(filterDebRef.current);
    filterDebRef.current = setTimeout(async () => {
      try {
        const { suggestions } = await api.ledgerSuggestions(branchId, FILTER_API_FIELD[field], q, { from, to });
        setFilterSuggs((p) => ({ ...p, [field]: suggestions }));
        setFilterSuggIdx(-1);
      } catch {}
    }, 180);
  }

  function openFilterSugg(field: FilterField, q: string) {
    setActiveFilterSugg(field);
    fetchFilterSugg(field, q);
  }

  function pickFilterSugg(field: FilterField, value: string, setter: (v: string) => void) {
    setter(value);
    setFilterSuggs((p) => ({ ...p, [field]: [] }));
    setActiveFilterSugg(null);
    setFilterSuggIdx(-1);
  }

  function filterSuggKeyDown(e: React.KeyboardEvent, field: FilterField, setter: (v: string) => void) {
    const list = filterSuggs[field];
    if (!list.length || activeFilterSugg !== field) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setFilterSuggIdx((i) => Math.min(i + 1, list.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFilterSuggIdx((i) => Math.max(i - 1, -1)); }
    else if (e.key === "Enter" && filterSuggIdx >= 0) { e.preventDefault(); pickFilterSugg(field, list[filterSuggIdx], setter); }
    else if (e.key === "Escape") { setActiveFilterSugg(null); }
  }

  type ReportGroup = {
    account: { id: string; position: number; name: string };
    entries: LedgerEntry[];
    totalAmount: string;
    totalCashPaid: string;
  };
  type ReportData = { groups: ReportGroup[]; grandTotalAmount: string; grandTotalCashPaid: string; rowCount: number };
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);

  async function runReport() {
    setLoading(true);
    try {
      const result = await api.ledgerReport({
        branchId, from, to,
        accountIds: selectedAccountIds.size === accounts.length ? undefined : [...selectedAccountIds],
        headName: headFilter || undefined,
        supplierName: supplierFilter || undefined,
        productName: productFilter || undefined,
      });
      setData(result);
    } catch {}
    setLoading(false);
  }

  function toggleAccount(id: string) {
    setSelectedAccountIds((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  // Professional print styles
  const printStyle = `
    @media print {
      body * { visibility: hidden !important; }
      .print-area, .print-area * { visibility: visible !important; }
      .print-area { position: fixed !important; inset: 0 !important; overflow: visible !important; }
      .no-print { display: none !important; }
    }
  `;

  const reportTitle = `Sabir Juice Corner — Account Report`;
  const dateRange = `${from} to ${to}`;
  const grandTotalAmount = data ? parseFloat(data.grandTotalAmount) : 0;
  const grandTotalCashPaid = data ? parseFloat(data.grandTotalCashPaid) : 0;
  const grandBalance = grandTotalAmount - grandTotalCashPaid;

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onMinimize(); }}>
      <style>{printStyle}</style>
      <div className="bg-white rounded-xl shadow-2xl flex flex-col w-full max-w-5xl max-h-[92vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0 no-print">
          <h2 className="font-semibold text-slate-800">Account Report</h2>
          <div className="flex gap-2">
            <button type="button" onClick={() => { window.addEventListener("afterprint", onClose, { once: true }); window.print(); }}
              className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold">
              🖨 Print / PDF
            </button>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
          </div>
        </div>

        {/* Filters */}
        <div className="px-5 py-3 border-b shrink-0 no-print flex flex-wrap gap-3 items-end bg-slate-50">
          <div>
            <label className="block text-xs text-slate-500 mb-1">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls + " w-36"} />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls + " w-36"} />
          </div>
          {(["headFilter", "supplierFilter", "productFilter"] as FilterField[]).map((field) => {
            const label = field === "headFilter" ? "Head" : field === "supplierFilter" ? "Supplier" : "Product";
            const value = field === "headFilter" ? headFilter : field === "supplierFilter" ? supplierFilter : productFilter;
            const setter = field === "headFilter" ? setHeadFilter : field === "supplierFilter" ? setSupplierFilter : setProductFilter;
            const isActive = activeFilterSugg === field;
            const list = filterSuggs[field];
            return (
              <div key={field} className="relative">
                <label className="block text-xs text-slate-500 mb-1">{label}</label>
                <input
                  type="text" value={value} placeholder="All"
                  className={inputCls + " w-32"}
                  onChange={(e) => { setter(e.target.value); openFilterSugg(field, e.target.value); }}
                  onFocus={() => openFilterSugg(field, value)}
                  onBlur={() => setTimeout(() => { setActiveFilterSugg(null); setFilterSuggIdx(-1); }, 160)}
                  onKeyDown={(e) => filterSuggKeyDown(e, field, setter)}
                  autoComplete="off"
                />
                {isActive && list.length > 0 && (
                  <ul className="absolute z-[80] left-0 right-0 top-full mt-0.5 bg-white border border-slate-200 rounded shadow-lg max-h-40 overflow-y-auto">
                    {list.map((item, i) => (
                      <li key={item}>
                        <button type="button" onMouseDown={() => pickFilterSugg(field, item, setter)}
                          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 ${i === filterSuggIdx ? "bg-blue-100" : ""}`}>
                          {item}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          <button type="button" onClick={() => void runReport()} disabled={loading}
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold disabled:opacity-50">
            {loading ? "Running…" : "Run Report"}
          </button>
        </div>

        {/* Account checkboxes */}
        <div className="px-5 py-2 border-b shrink-0 no-print flex flex-wrap gap-x-3 gap-y-1 bg-slate-50">
          <button type="button" onClick={() => setSelectedAccountIds(new Set(accounts.map((a) => a.id)))}
            className="text-xs px-2 py-0.5 rounded border border-slate-300 hover:bg-white text-slate-600">All</button>
          <button type="button" onClick={() => setSelectedAccountIds(new Set())}
            className="text-xs px-2 py-0.5 rounded border border-slate-300 hover:bg-white text-slate-600">None</button>
          {accounts.map((acc) => (
            <label key={acc.id} className="flex items-center gap-1 text-xs cursor-pointer">
              <input type="checkbox" checked={selectedAccountIds.has(acc.id)} onChange={() => toggleAccount(acc.id)} className="rounded" />
              <span className="text-slate-700">{acc.name}</span>
            </label>
          ))}
        </div>

        {/* Print area */}
        <div className="flex-1 min-h-0 overflow-y-auto print-area">
          {!data ? (
            <div className="flex items-center justify-center h-32 text-slate-400 text-sm no-print">
              Set filters and click "Run Report"
            </div>
          ) : (
            <div className="p-6 space-y-6">

              {/* ── Report header (printed) ── */}
              <div className="text-center border-b-2 border-blue-700 pb-4">
                <h1 className="text-xl font-bold text-blue-800">{reportTitle}</h1>
                <p className="text-sm text-slate-500 mt-1">Period: <span className="font-medium text-slate-700">{dateRange}</span></p>
                {(headFilter || supplierFilter || productFilter) && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    Filters: {[headFilter && `Head: ${headFilter}`, supplierFilter && `Supplier: ${supplierFilter}`, productFilter && `Product: ${productFilter}`].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>

              {/* ── Summary box at top ── */}
              <div className="grid grid-cols-5 gap-3">
                <div className="rounded-lg border-2 border-blue-200 bg-blue-50 p-3 text-center">
                  <div className="text-xl font-bold text-blue-800">{data.rowCount}</div>
                  <div className="text-[10px] text-blue-600 mt-1 font-medium">Total Entries</div>
                </div>
                <div className="rounded-lg border-2 border-slate-200 bg-slate-50 p-3 text-center">
                  <div className="text-xl font-bold text-slate-700">{data.groups.length}</div>
                  <div className="text-[10px] text-slate-500 mt-1 font-medium">Accounts</div>
                </div>
                <div className="rounded-lg border-2 border-blue-200 bg-blue-50 p-3 text-center">
                  <div className="text-xl font-bold text-blue-700">{fmtPKR(data.grandTotalAmount)}</div>
                  <div className="text-[10px] text-blue-600 mt-1 font-medium">Total Amount</div>
                </div>
                <div className="rounded-lg border-2 border-red-200 bg-red-50 p-3 text-center">
                  <div className="text-xl font-bold text-red-700">{fmtPKR(data.grandTotalCashPaid)}</div>
                  <div className="text-[10px] text-red-600 mt-1 font-medium">Total Cash Paid</div>
                </div>
                <div className={`rounded-lg border-2 p-3 text-center ${grandBalance >= 0 ? "border-green-200 bg-green-50" : "border-orange-200 bg-orange-50"}`}>
                  <div className={`text-xl font-bold ${grandBalance >= 0 ? "text-green-700" : "text-orange-700"}`}>{fmtPKR(Math.abs(grandBalance).toFixed(2))}</div>
                  <div className={`text-[10px] mt-1 font-medium ${grandBalance >= 0 ? "text-green-600" : "text-orange-600"}`}>
                    Balance {grandBalance < 0 ? "(Overpaid)" : ""}
                  </div>
                </div>
              </div>

              {/* ── Per-account summary ── */}
              {data.groups.length > 1 && (
                <div className="rounded-lg border border-slate-200 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead><tr className="bg-slate-700 text-white">
                      <th className="px-3 py-2 text-left">Account</th>
                      <th className="px-3 py-2 text-right">Entries</th>
                      <th className="px-3 py-2 text-right">Total Amount</th>
                      <th className="px-3 py-2 text-right">Cash Paid</th>
                      <th className="px-3 py-2 text-right">Balance</th>
                    </tr></thead>
                    <tbody>
                      {data.groups.map((g, i) => {
                        const bal = parseFloat(g.totalAmount) - parseFloat(g.totalCashPaid);
                        return (
                        <tr key={g.account.id} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                          <td className="px-3 py-1.5 font-medium text-slate-700">{g.account.position}. {g.account.name}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{g.entries.length}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-blue-700">{fmtPKR(g.totalAmount)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-red-700">{fmtPKR(g.totalCashPaid)}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${bal >= 0 ? "text-green-700" : "text-orange-700"}`}>{fmtPKR(bal.toFixed(2))}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                    <tfoot><tr className="bg-slate-100 font-bold border-t-2">
                      <td className="px-3 py-2 text-slate-700">Grand Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{data.rowCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-blue-700">{fmtPKR(data.grandTotalAmount)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-700">{fmtPKR(data.grandTotalCashPaid)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${grandBalance >= 0 ? "text-green-700" : "text-orange-700"}`}>{fmtPKR(grandBalance.toFixed(2))}</td>
                    </tr></tfoot>
                  </table>
                </div>
              )}

              {/* ── Detailed entries per account ── */}
              {data.groups.length === 0 && (
                <div className="text-center text-slate-400 py-8 text-sm">No entries found for the selected criteria.</div>
              )}
              {data.groups.map((g) => {
                let runBal = 0;
                return (
                  <div key={g.account.id}>
                    <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                      <h3 className="font-bold text-blue-800 text-sm">{g.account.position}. {g.account.name}</h3>
                      <div className="flex gap-2 text-xs font-bold">
                        <span className="text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-0.5">
                          Total: {fmtPKR(g.totalAmount)}
                        </span>
                        <span className="text-red-700 bg-red-50 border border-red-200 rounded px-2 py-0.5">
                          Cash Paid: {fmtPKR(g.totalCashPaid)}
                        </span>
                        <span className={`rounded px-2 py-0.5 border ${parseFloat(g.totalAmount) - parseFloat(g.totalCashPaid) >= 0 ? "text-green-700 bg-green-50 border-green-200" : "text-orange-700 bg-orange-50 border-orange-200"}`}>
                          Balance: {fmtPKR((parseFloat(g.totalAmount) - parseFloat(g.totalCashPaid)).toFixed(2))}
                        </span>
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200 overflow-hidden">
                      <table className="w-full text-xs">
                        <thead><tr className="bg-blue-700 text-white">
                          <th className="px-2 py-1.5 text-left">Date</th>
                          <th className="px-2 py-1.5 text-left">Product</th>
                          <th className="px-2 py-1.5 text-right">Qty</th>
                          <th className="px-2 py-1.5 text-right">Rate</th>
                          <th className="px-2 py-1.5 text-right">Total</th>
                          <th className="px-2 py-1.5 text-left">Head</th>
                          <th className="px-2 py-1.5 text-left">Supplier</th>
                          <th className="px-2 py-1.5 text-right">Cash Paid</th>
                          <th className="px-2 py-1.5 text-right">Balance</th>
                          <th className="px-2 py-1.5 text-left">Desc</th>
                        </tr></thead>
                        <tbody>
                          {g.entries.map((e, idx) => {
                            runBal += parseFloat(e.total) - parseFloat(e.cashPaid);
                            return (
                              <tr key={e.id} className={idx % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                                <td className="px-2 py-1.5 tabular-nums text-slate-500">{e.entryDate}</td>
                                <td className="px-2 py-1.5 font-medium text-slate-800">{e.productName}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{e.quantity ?? "—"}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{e.rate ? fmtPKR(e.rate) : "—"}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{fmtPKR(e.total)}</td>
                                <td className="px-2 py-1.5 text-slate-500">{e.headName ?? "—"}</td>
                                <td className="px-2 py-1.5 text-slate-500">{e.supplierName ?? "—"}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-red-700">{fmtPKR(e.cashPaid)}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-blue-700">{fmtPKR(runBal.toFixed(2))}</td>
                                <td className="px-2 py-1.5 text-slate-400 max-w-[80px] truncate">{e.description ?? ""}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot><tr className="bg-blue-50 border-t-2 border-blue-200 font-semibold">
                          <td colSpan={4} className="px-2 py-1.5 text-slate-600">Subtotal</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-blue-700">{fmtPKR(g.totalAmount)}</td>
                          <td colSpan={2}></td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-red-700">{fmtPKR(g.totalCashPaid)}</td>
                          <td className={`px-2 py-1.5 text-right tabular-nums ${runBal >= 0 ? "text-green-700" : "text-orange-700"}`}>{fmtPKR(runBal.toFixed(2))}</td>
                          <td></td>
                        </tr></tfoot>
                      </table>
                    </div>
                  </div>
                );
              })}

              {/* ── Grand total footer ── */}
              {data.groups.length > 0 && (
                <div className="mt-4 pt-4 border-t-2 border-slate-300 flex justify-between items-center flex-wrap gap-3">
                  <span className="text-sm text-slate-500">{data.rowCount} entries · {data.groups.length} accounts · {dateRange}</span>
                  <div className="flex gap-6 text-right">
                    <div>
                      <div className="text-xs text-slate-500">Total Amount</div>
                      <div className="text-lg font-bold text-blue-700">{fmtPKR(data.grandTotalAmount)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Total Cash Paid</div>
                      <div className="text-lg font-bold text-red-700">{fmtPKR(data.grandTotalCashPaid)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Balance</div>
                      <div className={`text-lg font-bold ${grandBalance >= 0 ? "text-green-700" : "text-orange-700"}`}>{fmtPKR(grandBalance.toFixed(2))}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Cash Today Modal ─────────────────────────────────────────────────────────

function CashTodayModal({ branchId, shiftId, onClose, onMinimize }: { branchId: string; shiftId: string; onClose: () => void; onMinimize: () => void }) {
  const today = todayIso();
  const OPENING_KEY = `sjc.openingCash.${branchId}.${today}`;
  const [openingCash, setOpeningCash] = useState<string>(() => localStorage.getItem(OPENING_KEY) ?? "");
  const [todaySale, setTodaySale] = useState("0");
  const [totalExpenses, setTotalExpenses] = useState("0");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [s, e] = await Promise.all([api.todayStats(shiftId), api.ledgerCashToday(branchId, today)]);
        setTodaySale(s.salesTotal);
        setTotalExpenses(e.totalExpenses);
      } catch {}
      setLoading(false);
    })();
  }, [branchId, shiftId, today]);

  function saveOpening(v: string) { setOpeningCash(v); localStorage.setItem(OPENING_KEY, v); }

  const opening = parseFloat(openingCash) || 0;
  const sale = parseFloat(todaySale) || 0;
  const expenses = parseFloat(totalExpenses) || 0;
  const current = opening + sale - expenses;

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onMinimize(); }}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-3 border-b bg-green-700 text-white rounded-t-xl">
          <h2 className="font-semibold text-sm">Cash Today — {today}</h2>
          <button type="button" onClick={onClose} className="text-white/70 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          {loading ? (
            <div className="text-slate-400 text-sm text-center py-4">Loading…</div>
          ) : <>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Opening Cash (Rs)</label>
              <input type="number" value={openingCash} onChange={(e) => saveOpening(e.target.value)}
                placeholder="0" min="0" step="any" autoFocus className={inputCls} />
              <p className="text-[10px] text-slate-400 mt-1">Saved automatically per day</p>
            </div>
            <div className="rounded-lg bg-slate-50 border divide-y text-sm">
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-slate-600">Opening Cash</span>
                <span className="font-medium tabular-nums">{fmtPKR(opening.toFixed(2))}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-green-700 font-medium">+ Today's Sales</span>
                <span className="font-medium text-green-700 tabular-nums">+ {fmtPKR(todaySale)}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-red-600 font-medium">− All Expenses</span>
                <span className="font-medium text-red-600 tabular-nums">− {fmtPKR(totalExpenses)}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5 bg-slate-100 rounded-b-lg">
                <span className="font-bold text-slate-800">= Current Cash</span>
                <span className={`font-bold text-lg tabular-nums ${current >= 0 ? "text-green-700" : "text-red-700"}`}>
                  {fmtPKR(current.toFixed(2))}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-slate-400">Expenses = sum of all Cash Paid in all 10 accounts today.</p>
          </>}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const inputCls = "w-full border border-slate-300 rounded-md px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";

function fmtPKR(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "—";
  return "Rs " + n.toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
