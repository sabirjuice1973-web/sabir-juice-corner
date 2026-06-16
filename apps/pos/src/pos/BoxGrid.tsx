import { useEffect, useRef, useState } from "react";
import { BOX_COUNT, BOX_LABELS, displayItemName, type BoxOrder } from "./posState";
import { type BoxLayout, type BoxWindowState, MIN_WIN_W, MIN_WIN_H } from "./boxLayout";
import { AllOrdersPanel } from "../components/AllOrdersPanel";

type Props = {
  boxes: BoxOrder[][];
  onToggleDelivered: (boxIdx: number, localId: string) => void;
  onPrint: (boxIdx: number, localId: string) => void;
  onSave: (boxIdx: number, localId: string) => void;
  onPrintAndSave: (boxIdx: number, localId: string) => void;
  onOpenDetails: (boxIdx: number, localId: string) => void;
  onSelect: (boxIdx: number, localId: string) => void;
  onPushAllFoodPanda?: () => void;
  selectedKey: { boxIdx: number; localId: string } | null;
  mergeMode?: boolean;
  mergeSelectedIds?: Set<string>;
  onMergeToggle?: (boxIdx: number, localId: string) => void;
  kitchen?: boolean;
  layout: BoxLayout;
  onLayoutChange: (next: BoxLayout) => void;
  /** Per-box today-sales totals (index 0 = box 1). Main POS only — omit for kitchen. */
  boxSales?: number[];
};

export function BoxGrid({
  boxes, onToggleDelivered, onPrint, onSave, onPrintAndSave, onOpenDetails, onSelect,
  onPushAllFoodPanda, selectedKey, mergeMode, mergeSelectedIds, onMergeToggle,
  kitchen = false, layout, onLayoutChange, boxSales,
}: Props) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const trimmed = boxes.slice(0, BOX_COUNT);
  const visibleBoxes = kitchen ? trimmed.map((box) => box.filter((o) => !o.deliveredAt)) : trimmed;

  // Bring panel to top — re-rank all panels 1..N to keep z-indices small and bounded
  function bringToFront(idx: number) {
    const maxZ = Math.max(...layout.windows.map((w) => w.z));
    if (layout.windows[idx].z >= maxZ) return;
    // Sort panels by current z ascending, assign new ranks 1..N, then bump idx to N
    const ranked = [...layout.windows.map((w, i) => ({ i, z: w.z }))]
      .sort((a, b) => a.z - b.z)
      .map((item, rank) => ({ ...item, newZ: rank + 1 }));
    const target = ranked.find((r) => r.i === idx)!;
    target.newZ = ranked.length; // top
    // Compress others that were above target back down
    ranked.filter((r) => r.i !== idx && r.newZ >= target.newZ).forEach((r) => { r.newZ -= 1; });
    const zMap = Object.fromEntries(ranked.map((r) => [r.i, r.newZ]));
    const wins = layout.windows.map((w, i) => ({ ...w, z: zMap[i] }));
    onLayoutChange({ ...layout, windows: wins });
  }

  function updateWindow(idx: number, next: BoxWindowState) {
    const wins = layout.windows.map((w, i) => i === idx ? next : w);
    onLayoutChange({ ...layout, windows: wins });
  }

  // Determine which box has highest today-sales (to highlight)
  const bestBoxIdx: number = (() => {
    if (!boxSales || boxSales.every((s) => s <= 0)) return -1;
    return boxSales.reduce((best, s, i) => (s > boxSales[best] ? i : best), 0);
  })();

  return (
    <div ref={workspaceRef} className="absolute inset-0 bg-slate-300 overflow-hidden select-none">
      {/* AllOrders panel (window index 0) */}
      <FloatingPanel
        win={layout.windows[0]}
        onWinChange={(w) => updateWindow(0, w)}
        onBringToFront={() => bringToFront(0)}
        workspaceRef={workspaceRef}
      >
        <AllOrdersPanel boxes={boxes} largeFont={kitchen} className="flex-1 min-h-0 overflow-hidden" />
      </FloatingPanel>

      {/* Box panels (window indices 1-7) */}
      {Array.from({ length: BOX_COUNT }, (_, i) => (
        <FloatingPanel
          key={i}
          win={layout.windows[i + 1]}
          onWinChange={(w) => updateWindow(i + 1, w)}
          onBringToFront={() => bringToFront(i + 1)}
          workspaceRef={workspaceRef}
        >
          <BoxPanel
            boxNumber={i + 1}
            orders={visibleBoxes[i] ?? []}
            kitchen={kitchen}
            onToggleDelivered={(localId) => onToggleDelivered(i, localId)}
            onPrint={(localId) => onPrint(i, localId)}
            onSave={(localId) => onSave(i, localId)}
            onPrintAndSave={(localId) => onPrintAndSave(i, localId)}
            onOpenDetails={(localId) => onOpenDetails(i, localId)}
            onSelect={(localId) => onSelect(i, localId)}
            onPushAllFoodPanda={i === 5 ? onPushAllFoodPanda : undefined}
            selectedLocalId={selectedKey?.boxIdx === i ? selectedKey.localId : null}
            mergeMode={mergeMode}
            mergeSelectedIds={mergeSelectedIds}
            onMergeToggle={onMergeToggle ? (localId) => onMergeToggle(i, localId) : undefined}
            daySales={boxSales?.[i]}
            isBestSales={i === bestBoxIdx && bestBoxIdx >= 0}
          />
        </FloatingPanel>
      ))}
    </div>
  );
}

// ─── Floating panel (drag + resize wrapper) ──────────────────────────────────

type DragState = {
  startX: number; startY: number;
  origX: number; origY: number; origW: number; origH: number;
  type: string;
};

function FloatingPanel({
  win, onWinChange, onBringToFront, workspaceRef, children,
}: {
  win: BoxWindowState;
  onWinChange: (next: BoxWindowState) => void;
  onBringToFront: () => void;
  workspaceRef: React.RefObject<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const drag = useRef<DragState | null>(null);

  // Always-current refs so document-level listeners don't capture stale closures
  const winRef = useRef(win);
  const onWinChangeRef = useRef(onWinChange);
  useEffect(() => { winRef.current = win; });
  useEffect(() => { onWinChangeRef.current = onWinChange; });

  // Cleanup listeners if component unmounts during an active drag
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { cleanupRef.current?.(); }, []);

  function startDrag(clientX: number, clientY: number, type: string) {
    drag.current = {
      startX: clientX, startY: clientY,
      origX: win.x, origY: win.y, origW: win.w, origH: win.h,
      type,
    };

    function onMove(e: PointerEvent) {
      if (!drag.current) return;
      const wsRect = workspaceRef.current?.getBoundingClientRect();
      if (!wsRect) return;
      const dx = (e.clientX - drag.current.startX) / wsRect.width;
      const dy = (e.clientY - drag.current.startY) / wsRect.height;
      const { origX, origY, origW, origH, type: t } = drag.current;
      let x = origX, y = origY, w = origW, h = origH;
      switch (t) {
        case "move":
          x = Math.max(0, Math.min(1 - origW, origX + dx));
          y = Math.max(0, Math.min(1 - origH, origY + dy));
          break;
        case "e":  w = Math.max(MIN_WIN_W, origW + dx); break;
        case "s":  h = Math.max(MIN_WIN_H, origH + dy); break;
        case "w":  { const nw = Math.max(MIN_WIN_W, origW - dx); x = origX + origW - nw; w = nw; break; }
        case "n":  { const nh = Math.max(MIN_WIN_H, origH - dy); y = origY + origH - nh; h = nh; break; }
        case "se": w = Math.max(MIN_WIN_W, origW + dx); h = Math.max(MIN_WIN_H, origH + dy); break;
        case "sw": { const nw = Math.max(MIN_WIN_W, origW - dx); x = origX + origW - nw; w = nw; h = Math.max(MIN_WIN_H, origH + dy); break; }
        case "ne": { w = Math.max(MIN_WIN_W, origW + dx); const nh = Math.max(MIN_WIN_H, origH - dy); y = origY + origH - nh; h = nh; break; }
        case "nw": { const nw = Math.max(MIN_WIN_W, origW - dx); x = origX + origW - nw; w = nw; const nh = Math.max(MIN_WIN_H, origH - dy); y = origY + origH - nh; h = nh; break; }
      }
      onWinChangeRef.current({ ...winRef.current, x, y, w, h });
    }

    function onUp() {
      drag.current = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      cleanupRef.current = null;
    }

    cleanupRef.current = onUp;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  function handlePanelPointerDown(e: React.PointerEvent) {
    onBringToFront();
    const target = e.target as HTMLElement;
    // Start move-drag only when clicking the header drag handle (not buttons/inputs)
    if (
      target.closest("[data-drag-handle]") &&
      !target.closest("button, input, a, select")
    ) {
      startDrag(e.clientX, e.clientY, "move");
    }
  }

  function resizeHandle(type: string, className: string, cursor: string) {
    return (
      <div
        key={type}
        className={`absolute z-20 ${className}`}
        style={{ cursor }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onBringToFront();
          startDrag(e.clientX, e.clientY, type);
        }}
      />
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        left: `${win.x * 100}%`,
        top: `${win.y * 100}%`,
        width: `${win.w * 100}%`,
        height: `${win.h * 100}%`,
        zIndex: win.z,
      }}
      className="flex flex-col overflow-hidden border border-black"
      onPointerDown={handlePanelPointerDown}
    >
      {children}

      {/* Edge resize handles (4px wide/tall) */}
      {resizeHandle("n",  "inset-x-3 top-0 h-1",    "n-resize")}
      {resizeHandle("s",  "inset-x-3 bottom-0 h-1",  "s-resize")}
      {resizeHandle("e",  "inset-y-3 right-0 w-1",   "e-resize")}
      {resizeHandle("w",  "inset-y-3 left-0 w-1",    "w-resize")}
      {/* Corner resize handles (10px × 10px) */}
      {resizeHandle("nw", "top-0 left-0 w-2.5 h-2.5",    "nw-resize")}
      {resizeHandle("ne", "top-0 right-0 w-2.5 h-2.5",   "ne-resize")}
      {resizeHandle("sw", "bottom-0 left-0 w-2.5 h-2.5", "sw-resize")}
      {resizeHandle("se", "bottom-0 right-0 w-2.5 h-2.5","se-resize")}
    </div>
  );
}

// ─── Box panel ───────────────────────────────────────────────────────────────

type BoxProps = {
  boxNumber: number;
  orders: BoxOrder[];
  kitchen: boolean;
  onToggleDelivered: (localId: string) => void;
  onPrint: (localId: string) => void;
  onSave: (localId: string) => void;
  onPrintAndSave: (localId: string) => void;
  onOpenDetails: (localId: string) => void;
  onSelect: (localId: string) => void;
  onPushAllFoodPanda?: () => void;
  selectedLocalId: string | null;
  mergeMode?: boolean;
  mergeSelectedIds?: Set<string>;
  onMergeToggle?: (localId: string) => void;
  daySales?: number;
  isBestSales?: boolean;
};

function BoxPanel({
  boxNumber, orders, kitchen, onToggleDelivered, onPrint, onSave, onPrintAndSave,
  onOpenDetails, onSelect, onPushAllFoodPanda, selectedLocalId, mergeMode,
  mergeSelectedIds, onMergeToggle, daySales, isBestSales,
}: BoxProps) {
  const total = orders.reduce((s, o) => s + Number(o.total), 0);
  const shortcut = `Ctrl+${boxNumber}`;
  const customLabel = BOX_LABELS[boxNumber];
  const headerLabel = customLabel ?? `Box ${boxNumber}`;

  const headerBg = "bg-slate-900 border-b border-slate-700";

  return (
    <div className="card flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header — data-drag-handle makes this the FloatingPanel drag zone */}
      <div
        className={`px-3 py-2 flex items-center justify-between cursor-move ${headerBg}`}
        data-drag-handle="true"
      >
        <div className="flex items-center gap-2">
          {!kitchen && (
            <kbd className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-200 font-mono text-xs cursor-move">
              {shortcut}
            </kbd>
          )}
          <span className={kitchen ? "font-bold text-lg text-white" : "font-bold text-white"}>{headerLabel}</span>
          {isBestSales && !kitchen && (
            <span title="Best sales today!" className="text-yellow-400 text-xs">★</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!kitchen && daySales !== undefined && daySales > 0 && (
            <span
              className={`text-xs font-bold tabular-nums ${isBestSales ? "text-yellow-300" : "text-green-300"}`}
              title="Today's sales generated from this box"
            >
              Rs {daySales.toFixed(0)}
            </span>
          )}
          <div className="text-xs text-slate-300">
            {orders.length === 0
              ? "empty"
              : kitchen
                ? <>{orders.length} order{orders.length === 1 ? "" : "s"}</>
                : <>{orders.length} order{orders.length === 1 ? "" : "s"} · <span className="font-mono font-medium">PKR {total.toFixed(0)}</span></>}
          </div>
          {!kitchen && onPushAllFoodPanda && orders.length > 0 && (
            <button
              type="button"
              title="Push all Food Panda orders to account in one click"
              onClick={(e) => { e.stopPropagation(); onPushAllFoodPanda(); }}
              className="px-2 py-0.5 rounded text-xs font-medium bg-leaf-600 text-white hover:bg-leaf-700 whitespace-nowrap cursor-pointer"
            >
              Push all → FP
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {orders.length === 0 ? (
          <div className="text-center text-slate-300 text-xs py-6">empty</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {orders.map((o) => (
              <OrderRow
                key={o.localId}
                order={o}
                kitchen={kitchen}
                selected={!mergeMode && o.localId === selectedLocalId}
                selectedForMerge={!!mergeMode && (mergeSelectedIds?.has(o.localId) ?? false)}
                onToggleDelivered={() => onToggleDelivered(o.localId)}
                onPrint={() => onPrint(o.localId)}
                onSave={() => onSave(o.localId)}
                onPrintAndSave={() => onPrintAndSave(o.localId)}
                onOpenDetails={() => onOpenDetails(o.localId)}
                onSelect={() => onSelect(o.localId)}
                mergeMode={mergeMode}
                onMergeToggle={onMergeToggle ? () => onMergeToggle(o.localId) : undefined}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Order row ───────────────────────────────────────────────────────────────

type RowProps = {
  order: BoxOrder;
  kitchen: boolean;
  selected: boolean;
  selectedForMerge: boolean;
  onToggleDelivered: () => void;
  onPrint: () => void;
  onSave: () => void;
  onPrintAndSave: () => void;
  onOpenDetails: () => void;
  onSelect: () => void;
  mergeMode?: boolean;
  onMergeToggle?: () => void;
};

function OrderRow({
  order, kitchen, selected, selectedForMerge, onToggleDelivered, onPrint,
  onSave, onPrintAndSave, onOpenDetails, onSelect, mergeMode, onMergeToggle,
}: RowProps) {
  // Build JSX for the items summary so (M) and (J) can be bold
  const itemsJsx = order.lines.map((li, i) => {
    const bare = li.name.replace(/\s+(medium|med|jumbo|jum)$/i, "").trim();
    const suffix = li.size === "MEDIUM" ? "(M)" : li.size === "JUMBO" ? "(J)" : "";
    const qty = Number.isInteger(li.qty) ? `${li.qty}` : li.qty.toFixed(2).replace(/\.?0+$/, "");
    return (
      <span key={i}>
        {i > 0 && " "}
        <span className="inline-flex items-center justify-center rounded-full bg-red-600 text-white font-bold text-[10px] leading-none min-w-[16px] h-4 px-1 mr-0.5">{qty}</span>{bare}{suffix && <b>{suffix}</b>}
      </span>
    );
  });

  const isDelivered = !!order.deliveredAt;

  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);

  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const elapsedMin = Math.max(0, Math.floor((Date.now() - new Date(order.openedAt).getTime()) / 60_000));

  const clickTimer = useRef<number | null>(null);
  function handleClick(e: React.MouseEvent) {
    if (mergeMode) {
      if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
      onMergeToggle?.();
      return;
    }
    if (e.shiftKey) {
      if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
      onSelect();
      return;
    }
    if (e.detail === 2) {
      if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
      onOpenDetails();
      return;
    }
    if (clickTimer.current) clearTimeout(clickTimer.current);
    onSelect();
    clickTimer.current = window.setTimeout(() => {
      onToggleDelivered();
      clickTimer.current = null;
    }, 250);
  }

  const OVERDUE_MIN = 10;
  const isOverdue = !isDelivered && elapsedMin >= OVERDUE_MIN;

  if (kitchen) {
    return (
      <li className={`px-2 py-2 flex items-center gap-2 text-base select-none ${isOverdue ? "bg-red-100 ring-1 ring-inset ring-red-400" : "bg-white"}`}>
        <span className={`flex-1 ${isOverdue ? "text-red-900 font-semibold" : "text-slate-900"}`}>
          {order.customerName && <b className="text-accent-700 mr-2">{order.customerName}:</b>}
          {itemsJsx}
        </span>
        <span
          className={`font-mono text-sm tabular-nums w-12 text-right ${elapsedMin >= 5 ? "text-red-600 font-bold" : elapsedMin >= 3 ? "text-amber-600 font-semibold" : "text-slate-500"}`}
          title={`${elapsedMin} minutes since this order entered the box`}
        >
          {elapsedMin}m
        </span>
      </li>
    );
  }

  return (
    <li
      className={`px-2 py-1.5 flex items-center gap-2 cursor-pointer transition-colors text-sm select-none ${
        selectedForMerge ? "ring-2 ring-inset ring-green-500 bg-green-50" :
        selected && isDelivered ? "ring-2 ring-inset ring-red-500 bg-yellow-200/70" :
        selected ? "ring-2 ring-inset ring-red-500 bg-white" :
        isDelivered ? "bg-yellow-200/70 hover:bg-yellow-200" :
        isOverdue ? "bg-red-100 hover:bg-red-200 ring-1 ring-inset ring-red-400" :
        "bg-white hover:bg-slate-50"
      }`}
      onClick={handleClick}
      title={mergeMode ? "Click to select/deselect for merge" : "Click: select (red border) + mark delivered (yellow) · Double-click: details · Shift+C: edit selected"}
    >
      <span
        className={`flex-1 truncate ${isOverdue ? "text-red-900 font-semibold" : "text-slate-800"}`}
        onMouseEnter={(e) => setHoverRect(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHoverRect(null)}
      >
        {order.customerName && <b className="text-accent-700 mr-2">{order.customerName}:</b>}
        {itemsJsx}
      </span>
      {hoverRect && (
        <div
          style={{
            position: "fixed",
            left: Math.min(hoverRect.left, window.innerWidth - 280),
            top: hoverRect.bottom + 6 + (hoverRect.bottom + 6 + order.lines.length * 36 + 52 > window.innerHeight ? -(order.lines.length * 36 + 52 + 12) : 0),
            zIndex: 9999,
            minWidth: 240,
          }}
          className="pointer-events-none bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden"
        >
          {order.customerName && (
            <div className="px-3 py-2 bg-accent-700 text-white text-xs font-bold tracking-wide">
              {order.customerName}
            </div>
          )}
          <div className="divide-y divide-slate-100">
            {order.lines.map((li, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2">
                <span className="w-7 h-7 flex items-center justify-center rounded-full bg-blue-50 text-blue-700 text-xs font-bold tabular-nums shrink-0">{li.qty}×</span>
                <span className="flex-1 text-sm font-medium text-slate-800 leading-tight">{displayItemName(li.name, li.size)}</span>
                <span className="text-sm tabular-nums font-semibold text-slate-600 ml-2">Rs {Number(li.lineTotal).toFixed(0)}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between px-3 py-2 bg-slate-800 text-white">
            <span className="text-xs font-bold tracking-wide uppercase">Total</span>
            <span className="text-sm font-bold tabular-nums">Rs {Number(order.total).toFixed(0)}</span>
          </div>
        </div>
      )}
      <span className="font-mono font-semibold text-sm text-slate-900 w-20 text-right">Rs {Number(order.total).toFixed(0)}</span>
      <RowIcons
        elapsedMin={elapsedMin}
        onPrint={onPrint}
        onSave={onSave}
        onPrintAndSave={onPrintAndSave}
      />
    </li>
  );
}

function RowIcons({ elapsedMin, onPrint, onSave, onPrintAndSave }: { elapsedMin: number; onPrint: () => void; onSave: () => void; onPrintAndSave: () => void }) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div className="flex items-center gap-0.5 text-slate-500">
      <button
        type="button"
        title="Print bill (reprint, does not save)"
        onClick={stop(onPrint)}
        className="p-1 rounded hover:bg-slate-200 hover:text-slate-800 cursor-pointer"
        aria-label="Print"
      >
        <PrinterIcon />
      </button>
      <button
        type="button"
        title="Save (mark paid as Cash, remove from box)"
        onClick={stop(onSave)}
        className="p-1 rounded hover:bg-leaf-500/15 hover:text-leaf-600 cursor-pointer"
        aria-label="Save"
      >
        <SaveIcon />
      </button>
      <button
        type="button"
        title="Print + Save"
        onClick={stop(onPrintAndSave)}
        className="p-1 rounded hover:bg-accent-100 hover:text-accent-700 cursor-pointer"
        aria-label="Print and save"
      >
        <PrintSaveIcon />
      </button>
      <span
        title={`${elapsedMin} minutes since this order entered the box`}
        className="ml-1 text-xs font-mono text-slate-400 w-8 text-right tabular-nums"
      >
        {elapsedMin}m
      </span>
    </div>
  );
}

// ─── Inline SVG icons ────────────────────────────────────────────────────────

function PrinterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}
function SaveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function PrintSaveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <polyline points="9 14 11 16 15 12" />
    </svg>
  );
}
