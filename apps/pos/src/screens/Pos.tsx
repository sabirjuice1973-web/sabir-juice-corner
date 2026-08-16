import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AuthUser } from "../api";
import { BrandLogo } from "../components/BrandLogo";
import { SyncStatus } from "../components/SyncStatus";
import { TodaySalesModal } from "../components/TodaySalesModal";
import { PettyCashModal } from "../components/PettyCashModal";
import { PriceSlipModal } from "../components/PriceSlipModal";
import { BusinessDatePill } from "../components/BusinessDatePill";
import { OrderWindow } from "../pos/OrderWindow";
import { OrderDetails } from "../pos/OrderDetails";
import { BoxGrid } from "../pos/BoxGrid";
import { CreditorModal } from "../pos/CreditorModal";
import { printReceipt } from "../pos/receipt";
import { layoutsEqual, loadBoxLayout, POS_LAYOUT_KEY, saveBoxLayout, type BoxLayout } from "../pos/boxLayout";
import { useZoom } from "../lib/useZoom";
import {
  BOX_COUNT, BOX_LABELS, NAME_OPTIONAL_BOXES, NAME_REQUIRED_BOXES,
  clearDraft, loadState, newLocalId, saveState,
  type BoxOrder, type PosState,
} from "../pos/posState";
import { enqueue } from "../offline/orderQueue";
import { runDrain } from "../offline/syncDrain";
import { emitOrdersChanged } from "../lib/events";

/**
 * POS billing screen — keyboard-first redesign.
 *
 * Workflow:
 *   1. Cashier hits SPACE (when no input is focused) → OrderWindow opens, qty input focused
 *   2. Cashier types qty, ENTER, item code/name, ENTER → line added to draft
 *   3. Repeats steps 1–2 until all items are in
 *   4. Cashier presses Ctrl+1…Ctrl+7 → draft is pushed to the matching box (server commits atomically)
 *   5. The committed order appears as a row in the chosen box
 *   6. Click row → toggles delivered (yellow); icon buttons print, save (pay as Cash), or print+save
 *
 * Global keyboard handler is installed on document so shortcuts work even when no input has focus.
 * The handler is careful to ignore Ctrl+digit / Spacebar when the user is typing in an input field.
 */

function buildBoxOrderLines(items: any[]): BoxOrder["lines"] {
  return items.map((it: any) => {
    const mix = it.isCustomMix && Array.isArray(it.customMixComponents) ? it.customMixComponents : null;
    const displayName = mix && mix.length >= 2
      ? `${mix.map((m: any) => m.name).join("+")} ${mix[0].size === "MEDIUM" ? "Medium" : "Jumbo"}`
      : it.item.name;
    return {
      itemCode: it.item.itemCode,
      name: displayName,
      size: (mix ? mix[0].size : it.item.size) as "MEDIUM" | "JUMBO" | "NA",
      qty: Number(it.qty),
      lineTotal: it.lineTotal,
      ...(mix && mix.length >= 2 ? { mixOf: mix.map((m: any) => m.itemCode) } : {}),
    };
  });
}

export function Pos({
  user, branchId, shiftId, onEndShift, onLogout,
}: {
  user: AuthUser;
  branchId: string;
  shiftId: string;
  onEndShift: () => void;
  onLogout: () => void;
}) {
  const isOwner = user.roles.some((r) => r.code === "OWNER");

  const [state, setState] = useState<PosState>(() => loadState());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closingShift, setClosingShift] = useState(false);
  const [closeAmount, setCloseAmount] = useState("");
  // Double-clicking a row opens the Order Details modal for that row.
  // Tracked by { boxIdx, localId } so we can resolve it on demand without
  // duplicating the BoxOrder data.
  const [detailsTarget, setDetailsTarget] = useState<{ boxIdx: number; localId: string } | null>(null);
  const [salesOpen, setSalesOpen] = useState(false);
  const [pettyCashOpen, setPettyCashOpen] = useState(false);
  const [priceSlipOpen, setPriceSlipOpen] = useState(false);
  const [creditorOpen, setCreditorOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Row selection state — Shift+click on a row sets this; Shift+C reads it.
  const [selectedRow, setSelectedRow] = useState<{ boxIdx: number; localId: string } | null>(null);
  // Active branch business date (YYYY-MM-DD), loaded from /branches/:id/business-date.
  // Used to compute drift against the calendar date.
  const [businessDate, setBusinessDate] = useState<string | null>(null);
  // Recomputed every minute so the drift banner appears the moment the clock
  // crosses the threshold without needing the user to do anything.
  const [calendarTick, setCalendarTick] = useState(0);
  // Edit-mode state — when set, OrderWindow runs in edit mode; pushing to a box
  // calls replace-items (moves the order) rather than creating a new one.
  const [editTarget, setEditTarget] = useState<{ boxIdx: number; localId: string; serverId: string; orderNo: string | null; customerName: string | null; openedAt: string } | null>(null);
  // Merge-mode state — user selects 2+ order rows, then confirms merge.

  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelections, setMergeSelections] = useState<{ boxIdx: number; localId: string }[]>([]);
  // Pending push state — when a box requires/offers a customer name, the
  // pushDraftToBox call stashes the box number here and the NamePromptModal
  // renders. On confirm/skip the modal calls performPushToBox with the value.
  const [pendingPush, setPendingPush] = useState<{ boxNumber: number } | null>(null);

  // Persist on every change. Tiny payload (~few KB), so just write whole state.
  useEffect(() => { saveState(state); }, [state]);

  // Defensive box-count migration. loadState() trims the persisted state to
  // BOX_COUNT, but if the in-memory state ever drifts out of sync (e.g. HMR
  // preserves an older runtime state across a code change that lowered the
  // count, or a future change raises it), this effect reconciles in-place.
  // Overflow from boxes beyond BOX_COUNT is folded into the last surviving box.
  useEffect(() => {
    if (state.boxes.length === BOX_COUNT) return;
    setState((s) => {
      const next: BoxOrder[][] = [];
      for (let i = 0; i < BOX_COUNT; i++) next.push(s.boxes[i] ?? []);
      const overflow = s.boxes.slice(BOX_COUNT).flat();
      if (overflow.length > 0) next[BOX_COUNT - 1] = [...next[BOX_COUNT - 1], ...overflow];
      return { ...s, boxes: next };
    });
  }, [state.boxes.length]);

  // Re-render every minute so the drift banner appears the instant the calendar
  // crosses the warning threshold (calendar - businessDate ≥ 2 days). Cheap
  // because the rest of the tree memoises on `state`.
  useEffect(() => {
    const id = setInterval(() => setCalendarTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // How many days the calendar is AHEAD of the business date.
  // < 0 (calendar behind biz) and 0 (same) → no banner.
  // ≥ 2 → red drift banner with repeated "please update" nudge.
  const driftDays: number | null = (() => {
    void calendarTick;   // reference the tick so the memo re-evaluates each minute
    if (!businessDate) return null;
    const [y, m, d] = businessDate.split("-").map(Number);
    const bizUtc = Date.UTC(y, m - 1, d);
    const now = new Date();
    const calUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((calUtc - bizUtc) / 86_400_000);
  })();
  const driftAlert = driftDays !== null && driftDays >= 2;

  // Always-current draft ref so performPushToBox never captures a stale draft,
  // even when useCallback dependencies haven't updated yet between renders.
  const draftRef = useRef(state.draft);
  useEffect(() => { draftRef.current = state.draft; });

  // Convenience updaters that don't trigger spurious re-renders
  const setDraft = useCallback((next: PosState["draft"]) => {
    // Update the ref synchronously so rapid callers (keyboard handler) get
    // the latest lines even before the React re-render completes.
    draftRef.current = next;
    setState((s) => ({ ...s, draft: next }));
  }, []);
  const setWindowOpen = useCallback((open: boolean) => {
    setState((s) => ({ ...s, windowOpen: open }));
  }, []);

  // Live "this will be order #N" counter for the Order Window — refetched on
  // mount and after every successful push, so it stays accurate even across
  // page refreshes or a business-date rollover mid-shift.
  const [nextOrderSeq, setNextOrderSeq] = useState<number | null>(null);
  const refreshNextOrderSeq = useCallback(() => {
    api.nextOrderNumber(branchId).then((r) => setNextOrderSeq(r.nextSeq)).catch(() => {});
  }, [branchId]);
  useEffect(() => { refreshNextOrderSeq(); }, [refreshNextOrderSeq]);

  /**
   * Public push: validates the draft, then either:
   *   - opens the name-prompt modal (box 6/7) and waits for the cashier to enter
   *     a customer/shopkeeper name; or
   *   - calls performPushToBox directly (boxes 1-5).
   */
  const pushDraftToBox = useCallback(async (boxNumber: number) => {
    if (busy) return;
    if (state.draft.lines.length === 0) {
      setError(`Draft is empty — punch some items first, then Ctrl+${boxNumber}`);
      setTimeout(() => setError(null), 1500);
      return;
    }
    // In edit mode, skip the name prompt — the order being moved already has
    // whatever name it started with. EXCEPT: Box 7 requires a shopkeeper name,
    // so an order that doesn't already have one (e.g. it started in another
    // box, or was pushed to Box 7 before this check existed) must still be
    // prompted — otherwise it silently lands in Box 7 nameless.
    if (editTarget) {
      if (boxNumber === 7 && !editTarget.customerName) {
        setPendingPush({ boxNumber });
        return;
      }
      await performPushToBox(boxNumber, null);
      return;
    }
    if (NAME_REQUIRED_BOXES.has(boxNumber) || NAME_OPTIONAL_BOXES.has(boxNumber)) {
      setPendingPush({ boxNumber });
      return;
    }
    await performPushToBox(boxNumber, null);
  }, [busy, state.draft.lines.length, editTarget]);

  /** Actual commit — called either directly or via the name-prompt modal.
   *  When editTarget is set: updates the existing order's items + moves it to the new box. */
  const performPushToBox = useCallback(async (boxNumber: number, customerName: string | null) => {
    // Always read from draftRef so we get the latest draft even if the React
    // re-render from a recent addDraftLine hasn't completed yet.
    const draft = draftRef.current;
    setBusy(true);
    setError(null);
    try {
      // ── Edit mode: replace items + move box ────────────────────────────────
      if (editTarget) {
        const result = await api.replaceOrderItems(
          editTarget.serverId,
          draft.lines.map((li) =>
            li.isMix && li.mixOf
              ? { mixOf: li.mixOf, qty: li.qty, unitPriceOverride: Number(li.unitPrice) }
              : { itemCode: li.itemCode, qty: li.qty },
          ),
          boxNumber,
          customerName ?? undefined,
        );
        emitOrdersChanged();
        const o = result.order;
        const updatedBoxOrder: BoxOrder = {
          serverId: o.id,
          localId: editTarget.localId,
          orderNo: o.orderNo,
          subtotal: o.subtotal,
          discountAmount: o.discountAmount,
          deliveryCharge: o.deliveryCharge,
          total: o.total,
          customerName: customerName ?? editTarget.customerName,
          lines: buildBoxOrderLines(o.items),
          openedAt: o.openedAt,
          deliveredAt: null,
        };
        setState((s) => {
          const without = s.boxes.map((arr, i) =>
            i === editTarget.boxIdx ? arr.filter((b) => b.localId !== editTarget.localId) : arr,
          );
          const withNew = without.map((arr, i) =>
            i === boxNumber - 1 ? [...arr, updatedBoxOrder] : arr,
          );
          return { ...s, boxes: withNew, draft: clearDraft(), windowOpen: false };
        });
        setEditTarget(null);
        setSelectedRow(null);
        return;
      }

      // ── Normal mode: create new order ─────────────────────────────────────
      const result = await api.createOrderWithItems({
        branchId,
        shiftId,
        waiterBox: boxNumber,
        customerName: customerName ?? undefined,
        items: draft.lines.map((li) =>
          li.isMix && li.mixOf
            ? { mixOf: li.mixOf, qty: li.qty, unitPriceOverride: Number(li.unitPrice) }
            : { itemCode: li.itemCode, qty: li.qty },
        ),
      });
      const o = result.order;
      const boxOrder: BoxOrder = {
        serverId: o.id,
        localId: newLocalId(),
        orderNo: o.orderNo,
        subtotal: o.subtotal,
        discountAmount: o.discountAmount,
        deliveryCharge: o.deliveryCharge,
        total: o.total,
        customerName,
        lines: buildBoxOrderLines(o.items),
        openedAt: o.openedAt,
        deliveredAt: null,
      };
      setState((s) => {
        const nextBoxes = s.boxes.map((arr, i) => i === boxNumber - 1 ? [...arr, boxOrder] : arr);
        return { ...s, boxes: nextBoxes, draft: clearDraft(), windowOpen: true };
      });
      setPendingPush(null);
      refreshNextOrderSeq();
    } catch (e: any) {
      if (isNetworkError(e)) {
        try {
          await enqueue({
            branchId,
            shiftId,
            waiterBox: boxNumber,
            items: draft.lines.map((li) => ({ itemCode: li.itemCode, qty: li.qty })),
          });
          const localTotal = draft.lines.reduce((s, li) => s + li.qty * Number(li.unitPrice), 0);
          const localBoxOrder: BoxOrder = {
            serverId: null,
            localId: newLocalId(),
            orderNo: null,
            subtotal: localTotal.toFixed(2),
            discountAmount: "0",
            total: localTotal.toFixed(2),
            customerName,
            lines: draft.lines.map((li) => ({
              itemCode: li.itemCode,
              name: li.name,
              size: li.size,
              qty: li.qty,
              lineTotal: (li.qty * Number(li.unitPrice)).toFixed(2),
            })),
            openedAt: new Date().toISOString(),
            deliveredAt: null,
          };
          setState((s) => {
            const nextBoxes = s.boxes.map((arr, i) => i === boxNumber - 1 ? [...arr, localBoxOrder] : arr);
            return { ...s, boxes: nextBoxes, draft: clearDraft(), windowOpen: true };
          });
          setPendingPush(null);
          void runDrain();
        } catch (queueErr: any) {
          setError("Could not save offline draft: " + (queueErr?.message ?? "unknown"));
        }
      } else {
        setError(e.body?.error || e.message || "Failed to push order");
      }
    } finally {
      setBusy(false);
    }
  }, [branchId, shiftId, editTarget, refreshNextOrderSeq]);

  // ─── Edit-order flow (click row → Shift+C) ──────────────────────────────
  //
  // The cashier clicks a row (it's selected with a blue ring) then presses
  // Shift+C. We dump the order's items into the draft, open the Order Window in
  // edit mode, and clicking any box button calls replace-items + moves the order.
  const enterEditMode = useCallback(() => {
    if (!selectedRow) {
      setError("Click a row to select it, then press Shift+C to edit.");
      setTimeout(() => setError(null), 2500);
      return;
    }
    const order = state.boxes[selectedRow.boxIdx]?.find((o) => o.localId === selectedRow.localId);
    if (!order) { setSelectedRow(null); return; }
    if (!order.serverId) {
      setError("This row hasn't synced yet — wait for the green Online pill, then try again.");
      setTimeout(() => setError(null), 2500);
      return;
    }
    if (state.draft.lines.length > 0) {
      const ok = window.confirm(
        `You have ${state.draft.lines.length} item(s) in the current draft. ` +
        `Entering edit mode will REPLACE the draft with this order's items. Continue?`,
      );
      if (!ok) return;
    }
    // Reconstruct DraftLines from the BoxOrder. Each line now carries `mixOf`
    // (stored when the order was first committed) so mix lines can be re-edited
    // just like regular lines — no filtering needed.
    const draftLines = order.lines.map((li) => ({
      itemId: "",
      itemCode: li.itemCode,
      name: li.name,
      size: li.size,
      qty: li.qty,
      unitPrice: (Number(li.lineTotal) / li.qty).toFixed(2),
      ...(li.mixOf && li.mixOf.length >= 2 ? { isMix: true as const, mixOf: li.mixOf } : {}),
    }));
    setState((s) => ({ ...s, draft: { lines: draftLines }, windowOpen: true }));
    setEditTarget({ boxIdx: selectedRow.boxIdx, localId: selectedRow.localId, serverId: order.serverId, orderNo: order.orderNo, customerName: order.customerName, openedAt: order.openedAt });
  }, [selectedRow, state.boxes, state.draft.lines.length]);

  const cancelEdit = useCallback(() => {
    setState((s) => ({ ...s, draft: clearDraft(), windowOpen: false }));
    setEditTarget(null);
  }, []);

  /** Distinguish transport failures (queue + replay) from server-side rejections (surface). */
  function isNetworkError(e: any): boolean {
    if (e?.name === "AbortError") return true; // 20 s fetch timeout
    if (e?.status) return false;
    if (e instanceof TypeError) return true;
    return typeof e?.message === "string" && /failed to fetch|network|load failed/i.test(e.message);
  }

  /** True when the server says the order is already closed (PAID/VOIDED/CANCELLED).
   *  This happens when payment succeeded server-side but the page refreshed before
   *  the box cleared — the order is a stale ghost in localStorage. Safe to remove. */
  function isOrderClosed(e: any): boolean {
    if (e?.status !== 409) return false;
    const msg: string = e?.body?.error ?? "";
    return /^Order is (PAID|VOIDED|CANCELLED)|already fully paid/i.test(msg);
  }

  // Always-current snapshot of everything the global keyboard handler needs.
  // openLedgerWindow/openPartnerAccountsWindow are plain function declarations
  // (a new reference every render) and pushDraftToBox/enterEditMode change on
  // nearly every order update — depending on them directly in the effect below
  // meant the document keydown listener was torn down and re-attached on
  // essentially every render during normal order-punching. That churn is the
  // likely cause of Shift+C going silent after "a few orders": a keypress
  // landing in the brief window between remove and re-add sees no listener at
  // all. Registering the listener exactly once (empty deps) and reading
  // everything through this ref instead removes that window entirely.
  const keyHandlersRef = useRef({
    windowOpen: state.windowOpen, setWindowOpen, pushDraftToBox, enterEditMode,
    isOwner, userRoles: user.roles, openPartnerAccountsWindow, openLedgerWindow,
  });
  useEffect(() => {
    keyHandlersRef.current = {
      windowOpen: state.windowOpen, setWindowOpen, pushDraftToBox, enterEditMode,
      isOwner, userRoles: user.roles, openPartnerAccountsWindow, openLedgerWindow,
    };
  });

  // ─── Global keyboard handler ─────────────────────────────────────────────
  useEffect(() => {
    const isTypingInInput = (): boolean => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      const h = keyHandlersRef.current;
      // Spacebar → toggle Order Window. Ignore when typing.
      if (e.code === "Space" && !isTypingInInput()) {
        e.preventDefault();
        h.setWindowOpen(!h.windowOpen);
        return;
      }
      // Escape → close window (does not clear draft)
      if (e.key === "Escape" && h.windowOpen) {
        e.preventDefault();
        h.setWindowOpen(false);
        return;
      }
      // F2 → open Product / Code Management (in the Admin app, owner-only).
      // We open it in a new tab so the cashier's POS state isn't disrupted.
      if (e.key === "F2") {
        e.preventDefault();
        if (!h.isOwner) {
          setError("Product Management is owner-only.");
          setTimeout(() => setError(null), 2000);
          return;
        }
        window.open("http://localhost:3100/?screen=products", "_blank", "noopener");
        return;
      }
      // Ctrl+1 … Ctrl+7 → push draft to the matching box (7-box 2-2-3 layout).
      // Why Ctrl+digit not F4-F12: most cashier laptops have Fn-locked F-keys
      // (they fire media controls by default), and the digit row is consistent
      // across keyboards. preventDefault on Ctrl+1..7 stops Chrome from switching
      // browser tabs — works in all current Chromium/Firefox versions.
      // Disabled while editing an existing order — Save changes is the only exit.
      if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-7]$/.test(e.key)) {
        e.preventDefault();
        h.pushDraftToBox(parseInt(e.key, 10));
        return;
      }
      // Ctrl+8 → Partner Accounts window (owner-only, mirrors the header button).
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "8") {
        e.preventDefault();
        if (h.isOwner) h.openPartnerAccountsWindow();
        return;
      }
      // Ctrl+9 → Hisaab / Accounts ledger window.
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "9") {
        e.preventDefault();
        h.openLedgerWindow();
        return;
      }
      // Shift+C → edit the selected row's order. Capital C avoids clashing with
      // browser's own Ctrl+C copy. Ignore when typing.
      if ((e.key === "C" || e.key === "c") && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !isTypingInInput()) {
        e.preventDefault();
        h.enterEditMode();
        return;
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true } as any);
  }, []);

  // ─── Box row actions ─────────────────────────────────────────────────────

  const toggleDelivered = useCallback((boxIdx: number, localId: string) => {
    setState((s) => {
      const nextBoxes = s.boxes.map((arr, i) => {
        if (i !== boxIdx) return arr;
        return arr.map((o) => o.localId === localId ? { ...o, deliveredAt: o.deliveredAt ? null : new Date().toISOString() } : o);
      });
      return { ...s, boxes: nextBoxes };
    });
  }, []);

  const togglePrepaid = useCallback((boxIdx: number, localId: string) => {
    setState((s) => {
      const nextBoxes = s.boxes.map((arr, i) => {
        if (i !== boxIdx) return arr;
        return arr.map((o) => o.localId === localId ? { ...o, prepaid: !o.prepaid } : o);
      });
      return { ...s, boxes: nextBoxes };
    });
  }, []);

  // Branch name — fetched from the API (getBranchBusinessDate returns it) because
  // OWNER roles have branchId=null so the role-array lookup always fails for owners.
  const [branchName, setBranchName] = useState<string>(() => {
    const match = user.roles.find((r) => r.branch?.id?.toString() === branchId);
    return match?.branch?.name ?? "";
  });
  useEffect(() => {
    api.getBranchBusinessDate(branchId).then((r) => { if (r.name) setBranchName(r.name); }).catch(() => {});
  }, [branchId]);

  // Independent zoom for the POS content area (not the header/strips).
  const { zoom, pct, zoomIn, zoomOut, save: saveZoom, dirty: zoomDirty } = useZoom("sjc.zoom.pos");

  // Floating box layout — each window has independent position + size.
  const [layout, setLayout] = useState<BoxLayout>(() => loadBoxLayout(POS_LAYOUT_KEY));
  const [savedLayout, setSavedLayout] = useState<BoxLayout>(() => loadBoxLayout(POS_LAYOUT_KEY));
  const layoutDirty = !layoutsEqual(layout, savedLayout);
  function saveLayout() {
    saveBoxLayout(POS_LAYOUT_KEY, layout);
    setSavedLayout(layout);
  }

  // Per-box today's sales totals — shown in box headers to reward the best waiter.
  const [boxSales, setBoxSales] = useState<number[]>(() => Array(BOX_COUNT).fill(0));
  const [boxDoneCounts, setBoxDoneCounts] = useState<number[]>(() => Array(BOX_COUNT).fill(0));
  const fetchBoxSales = useCallback(async () => {
    try {
      const { orders } = await api.todayOrders(shiftId);
      const sales = Array<number>(BOX_COUNT).fill(0);
      const done  = Array<number>(BOX_COUNT).fill(0);
      for (const o of orders) {
        if (o.status === "PAID" && o.waiterBox != null && o.waiterBox >= 1 && o.waiterBox <= BOX_COUNT) {
          sales[o.waiterBox - 1] += Number(o.total);
          done[o.waiterBox - 1]  += 1;
        }
      }
      setBoxSales(sales);
      setBoxDoneCounts(done);
    } catch {}
  }, [shiftId]);
  useEffect(() => {
    void fetchBoxSales();
    const id = setInterval(fetchBoxSales, 60_000);
    return () => clearInterval(id);
  }, [fetchBoxSales]);

  // Close the header menu when the user clicks anywhere outside it.
  useEffect(() => {
    if (!menuOpen) return;
    function onOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [menuOpen]);

  // On mount: fetch all OPEN orders for this BRANCH (not just this shift —
  // closing a shift doesn't require its open orders to be settled first, so
  // e.g. a Box 7 Market order left open overnight must still show up after
  // the next shift starts) and rebuild the boxes from that authoritative
  // list. This also ensures a cashier or manager logging in mid-shift
  // immediately sees every order already in the boxes, regardless of which
  // browser session placed them.
  useEffect(() => {
    async function hydrateFromServer() {
      try {
        const { orders } = await api.listOpenOrders(branchId);
        setState((prev) => {
          // Preserve any offline-queue orders (no serverId) — not yet synced.
          const offline = prev.boxes.map((box) => box.filter((o) => !o.serverId));

          // Rebuild box arrays from the server list.
          const serverBoxes: BoxOrder[][] = Array.from({ length: BOX_COUNT }, () => []);
          for (const o of orders) {
            const boxIdx = (o.waiterBox ?? 1) - 1;
            if (boxIdx < 0 || boxIdx >= BOX_COUNT) continue;
            // Carry forward local UI state (deliveredAt toggle, prepaid flag).
            const local = prev.boxes.flat().find((b) => b.serverId === o.id);
            serverBoxes[boxIdx].push({
              serverId: o.id,
              localId: local?.localId ?? newLocalId(),
              orderNo: o.orderNo,
              subtotal: o.subtotal,
              discountAmount: o.discountAmount,
              deliveryCharge: o.deliveryCharge,
              total: o.total,
              customerName: local?.customerName ?? o.customerName ?? null,
              lines: buildBoxOrderLines((o as any).items),
              openedAt: o.openedAt,
              deliveredAt: local?.deliveredAt ?? null,
              ...(local?.prepaid ? { prepaid: true } : {}),
            });
          }

          // Merge: server orders fill the boxes; offline-only orders go after.
          const merged: BoxOrder[][] = serverBoxes.map((sBox, i) => [
            ...sBox,
            ...(offline[i] ?? []),
          ]);

          return { ...prev, boxes: merged };
        });
      } catch {
        // Server unreachable — keep whatever is in localStorage (offline mode).
      }
    }
    void hydrateFromServer();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const printOnly = useCallback((boxIdx: number, localId: string) => {
    const order = state.boxes[boxIdx].find((o) => o.localId === localId);
    if (!order) return;
    printReceipt(order, { branchName, cashier: user.fullName });
  }, [state.boxes, branchName, user.fullName]);

  const saveOnly = useCallback(async (boxIdx: number, localId: string) => {
    const order = state.boxes[boxIdx].find((o) => o.localId === localId);
    if (!order?.serverId) {
      setError("Offline orders sync first, then can be saved. Wait for the green status pill.");
      setTimeout(() => setError(null), 2000);
      return;
    }
    setBusy(true);
    try {
      const { order: updated } = await api.pay(order.serverId, "CASH", Number(order.total));
      emitOrdersChanged();
      if (updated.status !== "PAID") {
        // The amount we sent didn't cover the server's actual total — most
        // likely `order.total` here was stale (e.g. a discount/delivery
        // charge applied elsewhere hadn't synced back to this local row yet).
        // The payment was still recorded server-side, so DON'T remove the
        // row — an order that silently vanishes from the box while still
        // OPEN and short-paid on the server is a real-money problem nobody
        // would notice until reconciliation. Refresh this row's totals from
        // the server instead so the shortfall is visible and payable.
        setState((s) => {
          const nextBoxes = s.boxes.map((arr, i) =>
            i === boxIdx
              ? arr.map((o) => (o.localId === localId
                  ? { ...o, subtotal: updated.subtotal, discountAmount: updated.discountAmount, deliveryCharge: updated.deliveryCharge, total: updated.total }
                  : o))
              : arr,
          );
          return { ...s, boxes: nextBoxes };
        });
        const due = Number(updated.total) - updated.payments.reduce((s, p) => s + Number(p.amount), 0);
        setError(`Order still owes PKR ${due.toFixed(0)} — total changed since this row last synced. Try again.`);
        setTimeout(() => setError(null), 4000);
        return;
      }
      setState((s) => {
        const nextBoxes = s.boxes.map((arr, i) => i === boxIdx ? arr.filter((o) => o.localId !== localId) : arr);
        return { ...s, boxes: nextBoxes };
      });
      void fetchBoxSales();
    } catch (e: any) {
      // If the server says the order is already closed, it's been recorded — remove
      // the stale ghost entry from the box so the cashier isn't stuck with it.
      if (isOrderClosed(e)) {
        setState((s) => {
          const nextBoxes = s.boxes.map((arr, i) => i === boxIdx ? arr.filter((o) => o.localId !== localId) : arr);
          return { ...s, boxes: nextBoxes };
        });
        void fetchBoxSales();
        return;
      }
      setError(e.body?.error || e.message);
    } finally {
      setBusy(false);
    }
  }, [state.boxes, fetchBoxSales]);

  const printAndSave = useCallback(async (boxIdx: number, localId: string) => {
    const order = state.boxes[boxIdx].find((o) => o.localId === localId);
    if (!order) return;
    printReceipt(order, { branchName, cashier: user.fullName });
    await saveOnly(boxIdx, localId);
  }, [state.boxes, branchName, user.fullName, saveOnly]);

  /** Push all Box 6 (Food Panda) orders to the FP account in one click. */
  const pushAllFoodPandaOrders = useCallback(async () => {
    const box6 = state.boxes[5];
    const unsynced = box6.filter((o) => !o.serverId);
    if (unsynced.length > 0) {
      setError(`${unsynced.length} order(s) not synced yet — wait for Online status, then try again.`);
      setTimeout(() => setError(null), 3000);
    }
    const ready = box6.filter((o) => o.serverId);
    if (ready.length === 0) return;
    setBusy(true); setError(null);
    const failed: string[] = [];
    for (const order of ready) {
      try {
        await api.pushOrderToAccount({ orderId: order.serverId!, type: "FOODPANDA", name: "Food Panda" });
        emitOrdersChanged();
        setState((s) => ({
          ...s,
          boxes: s.boxes.map((arr, i) => i === 5 ? arr.filter((o) => o.localId !== order.localId) : arr),
        }));
      } catch (e: any) {
        failed.push(order.orderNo ?? order.localId);
      }
    }
    if (failed.length > 0) setError(`Failed to push: ${failed.join(", ")}`);
    setBusy(false);
  }, [state.boxes]);

  // ─── Merge-order flow ────────────────────────────────────────────────────
  const toggleMergeSelection = useCallback((boxIdx: number, localId: string) => {
    setMergeSelections((s) => {
      const exists = s.some((x) => x.boxIdx === boxIdx && x.localId === localId);
      return exists
        ? s.filter((x) => !(x.boxIdx === boxIdx && x.localId === localId))
        : [...s, { boxIdx, localId }];
    });
  }, []);

  const executeMerge = useCallback(async () => {
    if (mergeSelections.length < 2) return;
    const orders = mergeSelections
      .map(({ boxIdx, localId }) => state.boxes[boxIdx]?.find((o) => o.localId === localId))
      .filter(Boolean) as BoxOrder[];

    const unsynced = orders.filter((o) => !o.serverId);
    if (unsynced.length > 0) {
      setError(`${unsynced.length} order(s) not synced yet — wait for Online status, then try again.`);
      setTimeout(() => setError(null), 3000);
      return;
    }
    setBusy(true); setError(null);
    try {
      const result = await api.mergeOrders(orders.map((o) => o.serverId!));
      emitOrdersChanged();
      const mergedOrder = result.order;
      const targetSel = mergeSelections[0];
      const targetOld = orders[0];
      const boxOrder: BoxOrder = {
        serverId: mergedOrder.id,
        localId: targetSel.localId,
        orderNo: mergedOrder.orderNo,
        subtotal: mergedOrder.subtotal,
        discountAmount: mergedOrder.discountAmount,
        total: mergedOrder.total,
        customerName: targetOld.customerName,
        lines: buildBoxOrderLines(mergedOrder.items),
        openedAt: targetOld.openedAt,
        deliveredAt: null,
      };
      setState((s) => {
        const selSet = new Set(mergeSelections.map((sel) => `${sel.boxIdx}:${sel.localId}`));
        const cleaned = s.boxes.map((arr, i) => arr.filter((o) => !selSet.has(`${i}:${o.localId}`)));
        cleaned[targetSel.boxIdx] = [...cleaned[targetSel.boxIdx], boxOrder];
        return { ...s, boxes: cleaned };
      });
      setMergeMode(false);
      setMergeSelections([]);
    } catch (e: any) {
      setError(e.body?.error || e.message || "Merge failed");
    } finally {
      setBusy(false);
    }
  }, [mergeSelections, state.boxes]);

  // Enter key while in merge mode → same as clicking "Merge N orders" button.
  useEffect(() => {
    if (!mergeMode) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "Enter" && !typing && mergeSelections.length >= 2) {
        e.preventDefault();
        executeMerge();
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [mergeMode, mergeSelections, executeMerge]);

  const openDetails = useCallback((boxIdx: number, localId: string) => {
    setDetailsTarget({ boxIdx, localId });
  }, []);

  // Resolve the currently-targeted order for the Details modal
  const detailOrder = detailsTarget
    ? state.boxes[detailsTarget.boxIdx]?.find((o) => o.localId === detailsTarget.localId) ?? null
    : null;

  // Open the Kitchen Display in a new window. Sized to typical 1080p secondary
  // monitors but the user will drag it onto the second display and press F11
  // for fullscreen. Reusing window.name lets a second click focus an already-open
  // kitchen window instead of stacking duplicates.
  function openKitchenScreen() {
    const w = window.open("/?kitchen=1", "sjc-kitchen", "noopener,popup,width=1600,height=900");
    if (!w) {
      setError("Browser blocked the kitchen window — allow popups for this site.");
      setTimeout(() => setError(null), 4000);
    }
  }

  // Statistics and Hisaab/Accounts open in their own popup window (same
  // mechanism as Kitchen) so the cashier can minimize/switch away and come
  // back without losing their place. Reusing window.name lets a second click
  // focus the already-open window instead of stacking duplicates.
  function openStatsWindow() {
    const params = new URLSearchParams({ stats: "1", branchId, shiftId });
    if (businessDate) params.set("businessDate", businessDate);
    const w = window.open(`/?${params}`, "sjc-stats", "noopener,popup,width=1400,height=900");
    if (!w) {
      setError("Browser blocked the statistics window — allow popups for this site.");
      setTimeout(() => setError(null), 4000);
    }
  }
  function openLedgerWindow() {
    const params = new URLSearchParams({ ledger: "1", branchId, shiftId, owner: isOwner ? "1" : "0" });
    if (businessDate) params.set("businessDate", businessDate);
    const w = window.open(`/?${params}`, "sjc-ledger", "noopener,popup,width=1400,height=900");
    if (!w) {
      setError("Browser blocked the accounts window — allow popups for this site.");
      setTimeout(() => setError(null), 4000);
    }
  }
  function openPaymentScheduleWindow() {
    const params = new URLSearchParams({ schedule: "1", branchId });
    const w = window.open(`/?${params}`, "sjc-payment-schedule", "noopener,popup,width=1400,height=900");
    if (!w) {
      setError("Browser blocked the schedule window — allow popups for this site.");
      setTimeout(() => setError(null), 4000);
    }
  }
  function openPartnerAccountsWindow() {
    // owner=1 lets the standalone window hide itself entirely for non-owners
    // who might guess/bookmark the URL — the API is OWNER-only regardless,
    // this is just so a cashier account can't even see the screen.
    const params = new URLSearchParams({ partners: "1", branchId, owner: isOwner ? "1" : "0" });
    if (businessDate) params.set("businessDate", businessDate);
    const w = window.open(`/?${params}`, "sjc-partner-accounts", "noopener,popup,width=1200,height=800");
    if (!w) {
      setError("Browser blocked the Self Loan window — allow popups for this site.");
      setTimeout(() => setError(null), 4000);
    }
  }

  // ─── Close shift ─────────────────────────────────────────────────────────
  async function closeShift() {
    setBusy(true); setError(null);
    try {
      await api.closeShift(shiftId, Number(closeAmount) || 0);
      onEndShift();
    } catch (e: any) {
      setError(e.body?.error || e.message);
    } finally {
      setBusy(false);
      setClosingShift(false);
    }
  }

  return (
    <div className="h-full flex flex-col bg-slate-100">
      <header
        className="px-5 flex items-center gap-4 shadow-lg"
        style={{
          background: "linear-gradient(135deg, #022c22 0%, #064e3b 55%, #065f46 100%)",
          borderBottom: driftAlert ? "3px solid #ef4444" : "3px solid #10b981",
          minHeight: "52px",
        }}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 shrink-0">
          <BrandLogo size={36} withWordmark={false} />
          <div className="flex flex-col leading-tight">
            <span className="font-display font-bold text-base text-white tracking-wide">Sabir Juice Corner</span>
            <span className="text-[11px] text-emerald-300/70">Branch #{branchId} · Shift #{shiftId}</span>
          </div>
        </div>

        {/* Divider */}
        <span className="w-px self-stretch bg-white/10 shrink-0" />

        {/* Business date + drift */}
        <div className="flex items-center gap-3 shrink-0">
          <BusinessDatePill
            branchId={branchId}
            user={user}
            onDateLoaded={setBusinessDate}
            onDateChanged={setBusinessDate}
          />
          {driftDays !== null && driftDays >= 1 && driftDays < 2 && (
            <span className="text-xs text-amber-300 font-medium">
              Calendar {driftDays}d ahead — update date.
            </span>
          )}
          {driftAlert && (
            <span className="text-xs font-bold text-white bg-red-500/80 px-2.5 py-1 rounded-lg flex items-center gap-1.5">
              ⚠ Date {driftDays}d behind — update now!
            </span>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Utility controls: zoom + merge + save */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1 bg-black/20 rounded-lg px-1 py-0.5">
            <button type="button" onClick={zoomOut} disabled={pct <= 50}
              className="w-7 h-7 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white font-bold text-base leading-none disabled:opacity-30 transition-colors">−</button>
            <span className="font-mono text-sm font-bold text-white/90 min-w-[38px] text-center">{pct}%</span>
            <button type="button" onClick={zoomIn} disabled={pct >= 150}
              className="w-7 h-7 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white font-bold text-base leading-none disabled:opacity-30 transition-colors">+</button>
          </div>

          {mergeMode ? (
            <span className="text-xs text-emerald-200 font-semibold bg-emerald-900/60 px-3 py-1.5 rounded-lg border border-emerald-400/30">
              {mergeSelections.length === 0 ? "Click orders to select" : `${mergeSelections.length} selected`}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => { setMergeMode(true); setMergeSelections([]); }}
              className="px-3 py-1.5 rounded-lg border border-white/20 bg-white/10 text-white hover:bg-white/20 font-medium text-sm transition-colors"
            >
              Merge
            </button>
          )}

          {(zoomDirty || layoutDirty) && (
            <button
              type="button"
              onClick={() => { saveZoom(); saveLayout(); }}
              className="px-3 py-1.5 rounded-lg border border-emerald-400/60 bg-emerald-500/25 text-emerald-200 hover:bg-emerald-500/40 font-semibold text-sm transition-colors"
            >
              Save
            </button>
          )}
          {busy && <span className="text-emerald-400/60 text-xs">syncing…</span>}
        </div>

        {/* Divider */}
        <span className="w-px self-stretch bg-white/10 shrink-0" />

        {/* Primary nav — Sales + Kitchen always visible; everything else in the Menu dropdown */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isOwner && (
            <NavPill color="emerald" onClick={() => setSalesOpen(true)} label="Sales"
              icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10h18M3 6h18M3 14h12M3 18h8" /></svg>} />
          )}
          <NavPill color="cyan" onClick={openKitchenScreen} label="Kitchen"
            icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
            </svg>} />

          {/* ── Menu dropdown ── */}
          <div ref={menuRef} className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white font-semibold text-sm transition-colors border border-white/20"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
              Menu
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: menuOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {menuOpen && (
              <div className="absolute left-0 top-full mt-1.5 w-52 rounded-xl shadow-2xl z-50 overflow-hidden"
                style={{ background: "linear-gradient(160deg, #022c22 0%, #064e3b 100%)", border: "1px solid rgba(255,255,255,0.15)" }}>

                {/* Owner-only section */}
                {isOwner && <>
                  <div className="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-emerald-400/60">Owner</div>
                  <MenuDropItem label="Stats" color="#3b82f6"
                    icon={<><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></>}
                    onClick={() => { openStatsWindow(); setMenuOpen(false); }} />
                  <MenuDropItem label="Schedule" color="#8b5cf6"
                    icon={<><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>}
                    onClick={() => { openPaymentScheduleWindow(); setMenuOpen(false); }} />
                  <MenuDropItem label="Self Loan" color="#f59e0b"
                    icon={<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>}
                    onClick={() => { openPartnerAccountsWindow(); setMenuOpen(false); }} />
                  <div className="mx-3 my-1 border-t border-white/10" />
                </>}

                {/* All users */}
                <div className="px-3 pt-1 pb-1 text-[10px] font-bold uppercase tracking-widest text-emerald-400/60">Screens</div>
                <MenuDropItem label="Hisaab Kitaab" color="#14b8a6"
                  icon={<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="14" y2="12" /></>}
                  onClick={() => { openLedgerWindow(); setMenuOpen(false); }} />
                <MenuDropItem label="Accounts" color="#f43f5e"
                  icon={<><path d="M20 12V8H6a2 2 0 0 1 0-4h12v4" /><path d="M4 6v12a2 2 0 0 0 2 2h14v-4" /><circle cx="16" cy="14" r="2" /></>}
                  onClick={() => { setCreditorOpen(true); setMenuOpen(false); }} />

                <div className="mx-3 my-1 border-t border-white/10" />

                {/* Session actions */}
                <MenuDropItem label="Petty Cash" color="#94a3b8"
                  icon={<><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></>}
                  onClick={() => { setPettyCashOpen(true); setMenuOpen(false); }} />
                <MenuDropItem label="Price Slip" color="#94a3b8"
                  icon={<><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L4 3a1 1 0 0 0-1 1l.24 5.59a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l4.35-4.35a2 2 0 0 0 0-2.83Z" /><circle cx="7.5" cy="7.5" r="1.5" /></>}
                  onClick={() => { setPriceSlipOpen(true); setMenuOpen(false); }} />
                <div className="pb-1.5">
                  <button
                    onClick={() => { setClosingShift(true); setMenuOpen(false); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 transition-colors text-left"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 8h1a4 4 0 0 1 0 8h-1" /><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" /><line x1="6" y1="1" x2="6" y2="4" /><line x1="10" y1="1" x2="10" y2="4" /><line x1="14" y1="1" x2="14" y2="4" />
                    </svg>
                    Close Shift
                  </button>
                  <div className="mx-3 mb-1 border-t border-white/10" />
                  <a
                    href="http://localhost:3100"
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setMenuOpen(false)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                    Admin Dashboard ↗
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>

        <SyncStatus />

        {/* Spacer pushes the session cluster to the far right */}
        <div className="flex-1" />

        {/* Divider */}
        <span className="w-px self-stretch bg-white/10 shrink-0" />

        {/* Account / session */}
        <div className="flex items-center gap-2 shrink-0 text-sm">
          <span className="flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-lg bg-white/10 text-white font-semibold">
            {user.fullName}
            {isOwner && <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-800 bg-emerald-300 px-1.5 py-0.5 rounded">Owner</span>}
          </span>
          <button
            className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            onClick={onLogout}
            title="Sign out"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      {/* Merge-mode action bar — floats above the boxes when 2+ orders are selected */}
      {mergeMode && (
        <div className="bg-green-50 border-b border-green-300 px-4 py-2 flex items-center gap-3">
          <span className="text-sm text-green-800 font-medium">
            {mergeSelections.length === 0 && "Click orders from any box to select them for merging."}
            {mergeSelections.length === 1 && "Select at least one more order to merge."}
            {mergeSelections.length >= 2 && `${mergeSelections.length} orders selected — merged into the first one you clicked.`}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => { setMergeMode(false); setMergeSelections([]); }}
              className="px-3 py-1 rounded border border-green-400 text-green-800 hover:bg-green-100 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={executeMerge}
              disabled={mergeSelections.length < 2 || busy}
              className="px-4 py-1 rounded bg-green-600 text-white hover:bg-green-700 text-sm font-medium disabled:opacity-40"
            >
              {busy ? "Merging…" : `Merge ${mergeSelections.length} orders`}
            </button>
          </div>
        </div>
      )}

      {/* Error toast — shows briefly after misuse */}
      {error && (
        <div className="bg-red-50 border-y border-red-200 px-4 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Main work area — all panels float inside a relative workspace */}
      <div className="flex-1 min-h-0 relative overflow-auto" style={{ zoom }}>
        <BoxGrid
          boxes={state.boxes}
          onToggleDelivered={toggleDelivered}
          onPrint={printOnly}
          onSave={saveOnly}
          onPrintAndSave={printAndSave}
          onOpenDetails={openDetails}
          onSelect={(boxIdx, localId) => {
            // Selecting a row is a clear signal the cashier wants keyboard
            // shortcuts (Shift+C) active, not text entry — but if some input
            // elsewhere (a box-rename field, a name-prompt input, etc.) is
            // still focused, the global keydown handler's isTypingInInput()
            // guard silently swallows Shift+C with zero feedback. Clicking a
            // row doesn't reliably blur a stray focused input on its own
            // (a handler upstream may have preventDefault'd the natural
            // focus-shift), so force it here.
            (document.activeElement as HTMLElement | null)?.blur?.();
            setSelectedRow({ boxIdx, localId });
          }}
          onTogglePrepaid={togglePrepaid}
          onPushAllFoodPanda={pushAllFoodPandaOrders}
          selectedKey={mergeMode ? null : selectedRow}
          mergeMode={mergeMode}
          mergeSelectedIds={new Set(mergeSelections.map((s) => s.localId))}
          onMergeToggle={toggleMergeSelection}
          layout={layout}
          onLayoutChange={setLayout}
          boxSales={boxSales}
          boxDoneCounts={boxDoneCounts}
        />
      </div>

      {/* Order Details modal — opens on row double-click */}
      {detailOrder && detailsTarget && (
        <OrderDetails
          order={detailOrder}
          branchId={branchId}
          branchName={branchName}
          boxNumber={detailsTarget.boxIdx + 1}
          cashierName={user.fullName}
          onClose={() => setDetailsTarget(null)}
          onPrintOnly={() => setDetailsTarget(null)}
          onSaved={() => {
            setState((s) => {
              const nextBoxes = s.boxes.map((arr, i) =>
                i === detailsTarget.boxIdx ? arr.filter((o) => o.localId !== detailsTarget.localId) : arr,
              );
              return { ...s, boxes: nextBoxes };
            });
            setDetailsTarget(null);
          }}
          onPrintAndSaved={() => {
            setState((s) => {
              const nextBoxes = s.boxes.map((arr, i) =>
                i === detailsTarget.boxIdx ? arr.filter((o) => o.localId !== detailsTarget.localId) : arr,
              );
              return { ...s, boxes: nextBoxes };
            });
            setDetailsTarget(null);
          }}
          onPushedToAccount={() => {
            setState((s) => {
              const nextBoxes = s.boxes.map((arr, i) =>
                i === detailsTarget.boxIdx ? arr.filter((o) => o.localId !== detailsTarget.localId) : arr,
              );
              return { ...s, boxes: nextBoxes };
            });
            setDetailsTarget(null);
          }}
          onTotalsChanged={(totals) => {
            setState((s) => {
              const nextBoxes = s.boxes.map((arr, i) =>
                i === detailsTarget.boxIdx
                  ? arr.map((o) => (o.localId === detailsTarget.localId ? { ...o, ...totals } : o))
                  : arr,
              );
              return { ...s, boxes: nextBoxes };
            });
          }}
        />
      )}

      {/* Floating "open window" button — fallback for non-keyboard users */}
      {!state.windowOpen && (
        <button
          onClick={() => setWindowOpen(true)}
          className="fixed bottom-6 right-6 btn-primary text-lg px-6 py-3 shadow-lg rounded-full z-30"
          title="Open order window (Spacebar)"
        >
          + New order <span className="ml-2 text-xs opacity-80">Space</span>
        </button>
      )}

      {/* Today's Sales panel */}
      {salesOpen && <TodaySalesModal shiftId={shiftId} branchId={branchId} onClose={() => setSalesOpen(false)} />}
      {pettyCashOpen && <PettyCashModal branchId={branchId} onClose={() => setPettyCashOpen(false)} />}
      {priceSlipOpen && <PriceSlipModal onClose={() => setPriceSlipOpen(false)} />}

      {/* Statistics & Insights and Hisaab Kitaab now open in their own popup
          window (openStatsWindow / openLedgerWindow above) instead of as
          in-app overlays — see StatsWindow / LedgerWindow. */}

      {/* Creditor Accounts modal */}
      {creditorOpen && (
        <CreditorModal
          branchId={branchId}
          branchName={branchName}
          cashierName={user.fullName}
          isOwner={isOwner}
          onClose={() => setCreditorOpen(false)}
        />
      )}

      {/* Customer-name prompt — fires when pushing to box 6 (Food Panda) or 7 (Market) */}
      {pendingPush && (
        <NamePromptModal
          boxNumber={pendingPush.boxNumber}
          required={NAME_REQUIRED_BOXES.has(pendingPush.boxNumber)}
          busy={busy}
          branchId={branchId}
          onCancel={() => setPendingPush(null)}
          onSubmit={(name) => performPushToBox(pendingPush.boxNumber, name)}
        />
      )}

      {/* Order Window modal */}
      {state.windowOpen && (
        <OrderWindow
          draft={state.draft}
          onDraftChange={setDraft}
          onClose={editTarget ? cancelEdit : () => setWindowOpen(false)}
          onClear={() => setDraft(clearDraft())}
          editTarget={editTarget ? { orderNo: editTarget.orderNo, serverId: editTarget.serverId, openedAt: editTarget.openedAt } : null}
          nextOrderSeq={nextOrderSeq}
        />
      )}

      {/* Close-shift dialog (unchanged) */}
      {closingShift && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="card w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Close shift</h2>
              <button onClick={() => setClosingShift(false)} className="text-slate-400 hover:text-slate-700">×</button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="text-sm text-slate-600">Counted cash in drawer (PKR)</span>
                <input
                  className="input w-full mt-1 font-mono"
                  inputMode="numeric"
                  value={closeAmount}
                  onChange={(e) => setCloseAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                />
              </label>
              {error && <div className="text-sm text-red-600">{error}</div>}
              <div className="flex gap-2 pt-2">
                <button className="btn-secondary flex-1" onClick={() => setClosingShift(false)}>Cancel</button>
                <button className="btn-primary flex-1" onClick={closeShift} disabled={busy}>
                  {busy ? "Closing…" : "Close shift"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A row inside the header Menu dropdown. */
function MenuDropItem({ label, icon, color, onClick }: {
  label: string;
  icon: React.ReactNode;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium text-white/85 hover:bg-white/10 transition-colors text-left"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {icon}
      </svg>
      {label}
    </button>
  );
}

/** One of the header's colored nav pills (Sales / Kitchen) —
 * a solid color chip rather than ghost-on-dark so each feature is distinguishable at a glance. */
function NavPill({ onClick, color, icon, label }: {
  onClick: () => void;
  color: "emerald" | "blue" | "violet" | "teal" | "rose" | "cyan" | "amber";
  icon: React.ReactNode;
  label: string;
}) {
  const styles: Record<typeof color, string> = {
    emerald: "bg-emerald-500 text-white hover:bg-emerald-400",
    blue:    "bg-blue-500 text-white hover:bg-blue-400",
    violet:  "bg-violet-500 text-white hover:bg-violet-400",
    teal:    "bg-teal-500 text-white hover:bg-teal-400",
    rose:    "bg-rose-500 text-white hover:bg-rose-400",
    cyan:    "bg-cyan-500 text-white hover:bg-cyan-400",
    amber:   "bg-amber-500 text-white hover:bg-amber-400",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-semibold text-sm shadow-sm transition-colors ${styles[color]}`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Name-prompt modal — used when the cashier pushes a draft to box 6 (Food Panda)
 * or box 7 (Market Orders). Box 7 requires a non-empty name; box 6 allows skip
 * (Food Panda orders come in named on the tablet — sometimes the cashier just
 * wants to push the order and move on).
 */
function NamePromptModal({ boxNumber, required, busy, branchId, onCancel, onSubmit }: {
  boxNumber: number; required: boolean; busy: boolean; branchId: string;
  onCancel: () => void; onSubmit: (name: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSugg, setShowSugg] = useState(false);
  const label = BOX_LABELS[boxNumber] ?? `Box ${boxNumber}`;
  const trimmed = name.trim();
  const canSubmit = !busy && (!required || trimmed.length > 0);

  // Fetch matching account names as the user types
  useEffect(() => {
    const q = trimmed;
    if (q.length < 1) { setSuggestions([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.listAccounts(branchId, "MARKET", q).then((r) => {
        if (!cancelled) setSuggestions(r.accounts.map((a: any) => a.name as string));
      }).catch(() => {});
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [trimmed, branchId]);

  function pick(s: string) {
    setName(s);
    setSuggestions([]);
    setShowSugg(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(trimmed || null);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[600] p-4" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form onSubmit={submit} className="card w-full max-w-md p-5 space-y-3">
        <div className="border-b pb-3">
          <div className="text-xs uppercase tracking-wider text-accent-700 font-medium">Pushing to {label}</div>
          <div className="font-bold text-lg mt-1">
            {boxNumber === 7 ? "Shopkeeper name" : boxNumber === 6 ? "Food Panda customer (optional)" : "Customer name"}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {boxNumber === 7
              ? "Required. The name shows on the box row and on the bill. We'll bill them at end of day or in 1-2 days."
              : "Optional. If the Food Panda order has a customer name, type it here so the row is identifiable."}
          </div>
        </div>
        <div className="relative">
          <input
            autoFocus
            className="input w-full text-lg"
            placeholder={boxNumber === 7 ? "e.g. Ali Shopkeeper, Karim Bhai" : "e.g. Foodpanda customer name"}
            value={name}
            onChange={(e) => { setName(e.target.value); setShowSugg(true); }}
            onFocus={() => setShowSugg(true)}
            onBlur={() => setTimeout(() => setShowSugg(false), 150)}
            maxLength={120}
            autoComplete="off"
          />
          {showSugg && suggestions.length > 0 && (
            <ul className="absolute z-10 left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
              {suggestions.map((s) => (
                <li
                  key={s}
                  className="px-4 py-2.5 cursor-pointer hover:bg-accent-50 hover:text-accent-800 text-slate-800 text-sm border-b last:border-0 border-slate-100"
                  onMouseDown={() => pick(s)}
                >
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onCancel} disabled={busy}>Cancel</button>
          {!required && (
            <button type="button" className="btn-ghost flex-1" onClick={() => onSubmit(null)} disabled={busy}>Skip & push</button>
          )}
          <button type="submit" className="btn-primary flex-1" disabled={!canSubmit}>
            {busy ? "Pushing…" : `Push to ${label}`}
          </button>
        </div>
      </form>
    </div>
  );
}
