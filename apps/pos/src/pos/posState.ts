/**
 * POS local state — draft + boxes — with localStorage persistence.
 *
 * Why this lives outside the React component:
 *   The cashier's workflow needs to survive a tab refresh (juice counters get
 *   bumped; the cashier hits the wrong shortcut). Keeping everything in one
 *   well-defined object with a single persistence point makes that trivial.
 *
 * Data shape:
 *   draft: lines being assembled in the Order Window modal — no server presence yet
 *   boxes: a fixed array of 7 box slots, each holding an array of committed orders
 *   The same order shape (BoxOrder) is used whether the order came from a successful
 *   server commit OR is a local-only entry that hasn't synced yet (when offline).
 */

const STORAGE_KEY = "sjc.pos.v2";

export type DraftLine = {
  // Regular line (single item from the menu):
  //   isMix=false, itemCode set
  // Custom mix line (cashier typed "7+41"):
  //   isMix=true, mixOf set with N component codes (alphabetically ordered, 2-5 items),
  //   itemCode = the anchor component (alphabetically first),
  //   name = joined name like "Banana+Peach Medium" or "Banana+Mango+Peach Medium",
  //   unitPrice = average of the N component prices.
  itemId: string;
  itemCode: number;
  name: string;
  size: "MEDIUM" | "JUMBO" | "NA";
  qty: number;
  unitPrice: string;            // store as string to avoid float math
  isMix?: boolean;
  mixOf?: number[];             // 2-5 item codes
};

export type Draft = {
  lines: DraftLine[];
};

export type BoxOrder = {
  // What the cashier and waiter see in a box row.
  // `serverId` is set once the server has acknowledged the order; until then
  // we generate a LOCAL-* placeholder and rely on the sync queue to reconcile.
  serverId: string | null;
  localId: string;
  orderNo: string | null;       // assigned by the server on commit
  subtotal: string;             // sum of line totals before discount
  discountAmount: string;       // "0" when no discount applied
  total: string;                // PKR after discount, string for precision
  // Partner / shopkeeper / credit-customer name. Required for box 7 (Market Orders),
  // optional for box 6 (Food Panda) and boxes 1-5. Shown FIRST in the row.
  customerName: string | null;
  lines: {
    itemCode: number;
    name: string;
    size: "MEDIUM" | "JUMBO" | "NA";
    qty: number;
    lineTotal: string;
    mixOf?: number[];   // component item codes for mix lines — needed to re-edit
  }[];
  openedAt: string;             // ISO timestamp captured when committed to box
  deliveredAt: string | null;   // single-click toggles this — UI-only
};

// Seven waiter boxes — arranged 2-2-3 in the grid (rows of 2, 2, then 3).
// Two boxes per row gives long-order rows the horizontal space to read.
export const BOX_COUNT = 7;

// Display labels for boxes that aren't just numbered waiter tokens. Boxes 6
// (Food Panda) and 7 (Market Orders) carry partner/customer orders — the cashier
// is prompted for a name when pushing to box 7 so the row shows whose order it is.
// In the future, boxes 1-5 may also adopt a label for credit-customer tracking.
export const BOX_LABELS: Record<number, string> = {
  6: "Food Panda",
  7: "Market Orders",
};

/** Boxes that REQUIRE a customer / partner name at push time. */
export const NAME_REQUIRED_BOXES = new Set<number>([7]);
/** Boxes that OPTIONALLY prompt for a customer name (cashier can skip).
 *  Currently empty — Box 6 (Food Panda) used to be here but no longer prompts;
 *  the cashier pushes normally and uses the "Push to Account" button on the row. */
export const NAME_OPTIONAL_BOXES = new Set<number>([]);

/** Box index → which account TYPE its "Push to Account" button targets.
 *  Box 6 always goes to the FOODPANDA account (one per branch).
 *  Box 7 uses the captured shopkeeper customerName as the account name (type MARKET).
 *  Boxes 1-5 currently have no push-to-account button. */
export const PUSH_TO_ACCOUNT_BOXES: Record<number, "FOODPANDA" | "MARKET"> = {
  6: "FOODPANDA",
  7: "MARKET",
};

export type PosState = {
  draft: Draft;
  boxes: BoxOrder[][];          // length always BOX_COUNT (9); index 0 = box 1
  windowOpen: boolean;
};

export const EMPTY_STATE: PosState = {
  draft: { lines: [] },
  boxes: Array.from({ length: BOX_COUNT }, () => []),
  windowOpen: false,
};

export function loadState(): PosState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as PosState;
    // Defensive: rebuild missing structure (e.g., after a schema bump or partial write).
    // Existing users may have a stored state with 7 boxes — grow to 9 without losing orders.
    if (!parsed.draft || !Array.isArray(parsed.boxes)) return EMPTY_STATE;
    if (parsed.boxes.length !== BOX_COUNT) {
      // Two-way reconcile: if the persisted state had MORE boxes (we shrank
      // from 9 → 7) any orders that lived in the truncated boxes get folded
      // into the last surviving box so they aren't silently dropped. If FEWER,
      // grow with empty boxes.
      const next: typeof parsed.boxes = [];
      for (let i = 0; i < BOX_COUNT; i++) next.push(parsed.boxes[i] ?? []);
      const overflow = parsed.boxes.slice(BOX_COUNT).flat();
      if (overflow.length > 0) next[BOX_COUNT - 1] = [...next[BOX_COUNT - 1], ...overflow];
      parsed.boxes = next;
    }
    parsed.windowOpen = false;  // never restore the modal open
    return parsed;
  } catch {
    return EMPTY_STATE;
  }
}

export function saveState(s: PosState): void {
  try {
    // Don't persist the windowOpen flag — refresh closes the window cleanly.
    const { windowOpen: _wo, ...rest } = s;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    // Quota exceeded or storage disabled — silently degrade; the cashier still
    // has working in-memory state. We'd surface this via the SyncStatus pill
    // in a future polish pass.
  }
}

export function clearState(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// ─── Pure reducers (no React, no async — easy to unit test later) ──────────

export const draftTotal = (d: Draft): number =>
  d.lines.reduce((s, li) => s + li.qty * Number(li.unitPrice), 0);

/** Unique key for matching identical lines (so cashier punching the same item twice stacks qty). */
function draftLineKey(l: DraftLine): string {
  // Mix key is a stable join of the sorted component codes — so the same mix
  // typed in any order (7+41 vs 41+7) collapses into one draft line.
  return l.isMix && l.mixOf ? `mix:${[...l.mixOf].sort((a, b) => a - b).join("+")}` : `code:${l.itemCode}`;
}

export function addDraftLine(d: Draft, line: DraftLine): Draft {
  // If a matching line (same item, or same mix pair) already exists in the
  // draft, stack the qty instead of appending a duplicate row.
  const key = draftLineKey(line);
  const idx = d.lines.findIndex((l) => draftLineKey(l) === key);
  if (idx >= 0) {
    const next = [...d.lines];
    next[idx] = { ...next[idx], qty: next[idx].qty + line.qty };
    return { lines: next };
  }
  return { lines: [...d.lines, line] };
}

export function removeDraftLine(d: Draft, key: string): Draft {
  return { lines: d.lines.filter((l) => draftLineKey(l) !== key) };
}

/** Adjust the qty of a draft line by `delta` (positive or negative).
 *  If the result is ≤ 0 the line is removed entirely. */
export function adjustDraftLineQty(d: Draft, key: string, delta: number): Draft {
  const idx = d.lines.findIndex((l) => draftLineKey(l) === key);
  if (idx < 0) return d;
  const newQty = Math.round((d.lines[idx].qty + delta) * 1000) / 1000;
  if (newQty <= 0) return removeDraftLine(d, key);
  const next = [...d.lines];
  next[idx] = { ...next[idx], qty: newQty };
  return { lines: next };
}

export { draftLineKey };

export function clearDraft(): Draft {
  return { lines: [] };
}

let localCounter = 0;
export function newLocalId(): string {
  localCounter++;
  return `LOCAL-${Date.now()}-${localCounter}`;
}

/**
 * Customer-facing name = item name + size word, but only if the size isn't
 * already in the name. Used by every UI surface that shows an item to a human
 * (All Orders panel, box rows, Today's Sales, receipt, etc.).
 *
 * Rationale: after the menu import strips the trailing "Medium"/"Jumbo" from
 * names (so the size enum is the single source of truth), the bare name alone
 * is ambiguous — "Mango" could be Medium or Jumbo and the kitchen has no way
 * to tell. This helper re-appends the size word for display.
 *
 *   ("Mango",            MEDIUM) → "Mango Medium"
 *   ("Mango",            JUMBO)  → "Mango Jumbo"
 *   ("Lychee Juice+Plum Medium", MEDIUM) → "Lychee Juice+Plum Medium"  (name already carries it)
 *   ("Marinda",          NA)     → "Marinda"
 *   ("Pomegranate B Dana Large", NA) → "Pomegranate B Dana Large"
 */
export function displayItemName(name: string, size: "MEDIUM" | "JUMBO" | "NA" | string): string {
  const n = name.trim();
  if (size === "NA") return n;
  if (/\b(Medium|Jumbo|Large)\s*$/i.test(n)) return n;
  if (size === "MEDIUM") return `${n} Medium`;
  if (size === "JUMBO")  return `${n} Jumbo`;
  return n;
}
