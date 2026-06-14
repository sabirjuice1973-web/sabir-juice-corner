/**
 * Floating-window layout for the box workspace.
 *
 * Each window (AllOrders panel + 7 waiter boxes) is independently positioned
 * and sized inside a `position: relative` workspace container. Positions and
 * sizes are stored as fractions (0.0–1.0) of the workspace dimensions so the
 * layout is resolution-independent. Z-index controls stacking order.
 *
 * Array layout (8 entries):
 *   index 0  = AllOrders aggregation panel
 *   index 1  = Box 1
 *   …
 *   index 7  = Box 7
 *
 * Two independent storage keys so the POS and Kitchen screens each have their
 * own saved layout.
 */

export const POS_LAYOUT_KEY     = "sjc.pos.boxlayout";
export const KITCHEN_LAYOUT_KEY = "sjc.kitchen.boxlayout";

/** Minimum window width as a fraction of workspace width. */
export const MIN_WIN_W = 0.06;
/** Minimum window height as a fraction of workspace height. */
export const MIN_WIN_H = 0.05;

export type BoxWindowState = {
  x: number;   // left edge, fraction of workspace width
  y: number;   // top edge, fraction of workspace height
  w: number;   // width as fraction of workspace width
  h: number;   // height as fraction of workspace height
  z: number;   // CSS z-index stacking order
};

/** 8 windows: index 0 = AllOrders, indices 1-7 = Box 1-7. */
export type BoxLayout = {
  windows: BoxWindowState[];
};

/** Default: 2-2-3 arrangement matching the previous fixed grid. */
export const DEFAULT_BOX_LAYOUT: BoxLayout = {
  windows: [
    { x: 0.000, y: 0.000, w: 0.130, h: 1.000, z: 1 }, // AllOrders
    { x: 0.135, y: 0.000, w: 0.433, h: 0.330, z: 2 }, // Box 1
    { x: 0.568, y: 0.000, w: 0.432, h: 0.330, z: 3 }, // Box 2
    { x: 0.135, y: 0.340, w: 0.433, h: 0.330, z: 4 }, // Box 3
    { x: 0.568, y: 0.340, w: 0.432, h: 0.330, z: 5 }, // Box 4
    { x: 0.135, y: 0.680, w: 0.289, h: 0.320, z: 6 }, // Box 5
    { x: 0.424, y: 0.680, w: 0.288, h: 0.320, z: 7 }, // Box 6
    { x: 0.712, y: 0.680, w: 0.288, h: 0.320, z: 8 }, // Box 7
  ],
};

export function loadBoxLayout(key: string): BoxLayout {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT_BOX_LAYOUT;
    const p = JSON.parse(raw) as BoxLayout;
    if (!Array.isArray(p.windows) || p.windows.length !== 8) return DEFAULT_BOX_LAYOUT;
    return p;
  } catch { return DEFAULT_BOX_LAYOUT; }
}

export function saveBoxLayout(key: string, layout: BoxLayout): void {
  try { localStorage.setItem(key, JSON.stringify(layout)); } catch {}
}

/**
 * Position/size equality check. Z-index is intentionally excluded: clicking a
 * box to bring it to front doesn't count as a "layout change" that requires
 * saving.
 */
export function layoutsEqual(a: BoxLayout, b: BoxLayout): boolean {
  if (a.windows.length !== b.windows.length) return false;
  return a.windows.every((w, i) => {
    const bw = b.windows[i];
    return (
      Math.abs(w.x - bw.x) < 0.001 &&
      Math.abs(w.y - bw.y) < 0.001 &&
      Math.abs(w.w - bw.w) < 0.001 &&
      Math.abs(w.h - bw.h) < 0.001
    );
  });
}
