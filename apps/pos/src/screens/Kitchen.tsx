import { useEffect, useState } from "react";
import { BoxGrid } from "../pos/BoxGrid";
import { BrandLogo } from "../components/BrandLogo";
import { loadState, type PosState } from "../pos/posState";
import { layoutsEqual, loadBoxLayout, KITCHEN_LAYOUT_KEY, saveBoxLayout, type BoxLayout } from "../pos/boxLayout";

/**
 * Kitchen Display Screen.
 *
 * Use case: the cashier's terminal has a second monitor attached via HDMI/VGA
 * (extended desktop, not mirrored). The cashier opens this screen in a new
 * browser window, drags it onto the kitchen-side monitor, and presses F11 for
 * fullscreen. The kitchen worker sees the same 9 waiter boxes but without
 * prices or action buttons — just items + elapsed minutes.
 *
 * Sync model:
 *   • Both windows are the same origin (localhost:3000) so they share localStorage.
 *   • The POS window persists state to localStorage on every change.
 *   • Browsers fire a `storage` event in *other* tabs/windows when localStorage
 *     changes (but never in the originating tab). We listen for that event and
 *     re-read state, so the kitchen mirror is effectively real-time.
 *   • No API calls from this window — auth/session belong to the POS window.
 *
 * Delivered orders disappear:
 *   When the cashier clicks a row on the main POS to mark delivered, the
 *   row's `deliveredAt` becomes non-null in shared state. BoxGrid's kitchen
 *   mode filters out those rows entirely (no yellow flash, no lingering row).
 *   Clicking again on the POS to undeliver brings it back into the kitchen view.
 */

const STORAGE_KEY = "sjc.pos.v2";

export function Kitchen() {
  const [state, setState] = useState<PosState>(() => loadState());
  const [tick, setTick] = useState(0);

  // Re-load state whenever the POS window writes to localStorage.
  // The "storage" event fires only in OTHER tabs of the same origin, so the
  // POS terminal writing → kitchen window reading is exactly what we want.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key !== STORAGE_KEY) return;
      setState(loadState());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Fallback poll every 1.5s in case a same-origin write somehow doesn't trigger
  // the storage event (some browser/Electron combos drop it). Cheap — reading
  // localStorage is microseconds and we only re-render if a referential change
  // surfaces from loadState.
  useEffect(() => {
    const id = setInterval(() => setState(loadState()), 1500);
    return () => clearInterval(id);
  }, []);

  // Drive the "Xm" elapsed-time refresh on each row. BoxGrid's rows have their
  // own 30s ticker, but we also nudge the whole tree at 30s so the kitchen
  // operator always sees up-to-date timing even when no orders are flowing in.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Resizable box layout — independent from the POS layout (different storage key).
  const [layout, setLayout] = useState<BoxLayout>(() => loadBoxLayout(KITCHEN_LAYOUT_KEY));
  const [savedLayout, setSavedLayout] = useState<BoxLayout>(() => loadBoxLayout(KITCHEN_LAYOUT_KEY));
  const layoutDirty = !layoutsEqual(layout, savedLayout);
  function saveLayout() {
    saveBoxLayout(KITCHEN_LAYOUT_KEY, layout);
    setSavedLayout(layout);
  }

  // No-op handler — kitchen mode never invokes any of the BoxGrid callbacks
  // (clicks are disabled, action buttons aren't rendered). Defined to satisfy
  // the BoxGrid prop types.
  const noopXY = (_b: number, _l: string) => {};

  const now = new Date().toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", hour12: true });

  return (
    <div className="h-full flex flex-col bg-slate-100" data-tick={tick}>
      <header className="bg-gradient-to-r from-leaf-500 to-leaf-400 text-slate-900 px-4 py-2 flex items-center justify-between text-sm shadow-sm border-b-2 border-leaf-700">
        <div className="flex items-center gap-3">
          <BrandLogo size={32} withWordmark={false} />
          <div className="flex flex-col leading-tight">
            <span className="font-display font-bold text-base">Sabir Juice Corner — Kitchen Display</span>
            <span className="text-xs text-slate-700">Read-only view · syncs from the POS terminal</span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {layoutDirty && (
            <button
              type="button"
              onClick={saveLayout}
              className="px-3 py-0.5 rounded border border-white/70 bg-white/30 text-slate-900 hover:bg-white/50 font-medium text-xs"
            >
              Save Screen
            </button>
          )}
          <div className="font-mono font-bold text-base">{now}</div>
          <span className="text-slate-700">|</span>
          <span className="text-slate-700">Press <kbd className="px-1.5 py-0.5 rounded bg-white/50 font-mono">F11</kbd> for fullscreen</span>
        </div>
      </header>

      <div className="flex-1 min-h-0 relative">
        <BoxGrid
          boxes={state.boxes}
          kitchen
          onToggleDelivered={noopXY}
          onPrint={noopXY}
          onSave={noopXY}
          onPrintAndSave={noopXY}
          onOpenDetails={noopXY}
          onSelect={noopXY}
          selectedKey={null}
          layout={layout}
          onLayoutChange={setLayout}
        />
      </div>
    </div>
  );
}
