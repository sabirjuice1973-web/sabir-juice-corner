import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AuthUser } from "../api";
import { LedgerScreen } from "./LedgerScreen";
import { BrandLogo } from "../components/BrandLogo";
import { SyncStatus } from "../components/SyncStatus";
import { TodaySalesModal } from "../components/TodaySalesModal";
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
  const [creditorOpen, setCreditorOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
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
  const [editTarget, setEditTarget] = useState<{ boxIdx: number; localId: string; serverId: string; orderNo: string | null; customerName: string | null } | null>(null);
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
    // In edit mode skip the name prompt — just move the order to the chosen box.
    if (editTarget) {
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
              ? { mixOf: li.mixOf, qty: li.qty }
              : { itemCode: li.itemCode, qty: li.qty },
          ),
          boxNumber,
        );
        emitOrdersChanged();
        const o = result.order;
        const updatedBoxOrder: BoxOrder = {
          serverId: o.id,
          localId: editTarget.localId,
          orderNo: o.orderNo,
          subtotal: o.subtotal,
          discountAmount: o.discountAmount,
          total: o.total,
          customerName: editTarget.customerName,
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
            ? { mixOf: li.mixOf, qty: li.qty }
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
  }, [branchId, shiftId, editTarget]);

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
    setEditTarget({ boxIdx: selectedRow.boxIdx, localId: selectedRow.localId, serverId: order.serverId, orderNo: order.orderNo, customerName: order.customerName });
  }, [selectedRow, state.boxes, state.draft.lines.length]);

  const cancelEdit = useCallback(() => {
    setState((s) => ({ ...s, draft: clearDraft(), windowOpen: false }));
    setEditTarget(null);
  }, []);

  /** Distinguish transport failures (queue + replay) from server-side rejections (surface). */
  function isNetworkError(e: any): boolean {
    if (e?.status) return false;
    if (e instanceof TypeError) return true;
    return typeof e?.message === "string" && /failed to fetch|network|load failed/i.test(e.message);
  }

  // ─── Global keyboard handler ─────────────────────────────────────────────
  useEffect(() => {
    const isTypingInInput = (): boolean => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      // Spacebar → toggle Order Window. Ignore when typing.
      if (e.code === "Space" && !isTypingInInput()) {
        e.preventDefault();
        setWindowOpen(!state.windowOpen);
        return;
      }
      // Escape → close window (does not clear draft)
      if (e.key === "Escape" && state.windowOpen) {
        e.preventDefault();
        setWindowOpen(false);
        return;
      }
      // F2 → open Product / Code Management (in the Admin app, owner-only).
      // We open it in a new tab so the cashier's POS state isn't disrupted.
      if (e.key === "F2") {
        const isOwner = user.roles?.some((r) => r.code === "OWNER");
        e.preventDefault();
        if (!isOwner) {
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
        pushDraftToBox(parseInt(e.key, 10));
        return;
      }
      // Shift+C → edit the selected row's order. Capital C avoids clashing with
      // browser's own Ctrl+C copy. Ignore when typing.
      if ((e.key === "C" || e.key === "c") && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !isTypingInInput()) {
        e.preventDefault();
        enterEditMode();
        return;
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [state.windowOpen, setWindowOpen, pushDraftToBox, enterEditMode, user.roles]);

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
      await api.pay(order.serverId, "CASH", Number(order.total));
      emitOrdersChanged();
      setState((s) => {
        const nextBoxes = s.boxes.map((arr, i) => i === boxIdx ? arr.filter((o) => o.localId !== localId) : arr);
        return { ...s, boxes: nextBoxes };
      });
      void fetchBoxSales();
    } catch (e: any) {
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
      <header className="bg-gradient-to-r from-sjc-500 to-sjc-400 text-slate-900 px-4 py-2 flex items-center justify-between text-sm shadow-sm border-b-2 border-accent-600">
        <div className="flex items-center gap-3">
          <BrandLogo size={32} withWordmark={false} />
          <div className="flex flex-col leading-tight">
            <span className="font-display font-bold text-base">Sabir Juice Corner</span>
            <span className="text-xs text-slate-700">Branch #{branchId} · Shift #{shiftId}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSalesOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/40 border border-slate-900/10 text-slate-800 hover:bg-white/70 hover:border-accent-400 transition-colors text-sm font-medium"
            title="View sales history"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 6h18M3 14h12M3 18h8" /></svg>
            Sales
          </button>
          <button
            type="button"
            onClick={() => setLedgerOpen(true)}
            className="text-slate-800 hover:text-leaf-700 font-medium flex items-center gap-1 border-l border-slate-900/15 pl-3"
            title="Hisaab Kitaab — expense accounts, daily ledger"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              <line x1="8" y1="8" x2="16" y2="8" />
              <line x1="8" y1="12" x2="14" y2="12" />
            </svg>
            Hisaab
          </button>
          <button
            onClick={() => setCreditorOpen(true)}
            className="text-slate-800 hover:text-leaf-700 font-medium flex items-center gap-1 border-l border-slate-900/15 pl-3"
            title="Creditor accounts — view credit balances and record payments"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 12V8H6a2 2 0 0 1 0-4h12v4" />
              <path d="M4 6v12a2 2 0 0 0 2 2h14v-4" />
              <circle cx="16" cy="14" r="2" />
            </svg>
            Accounts
          </button>
          <button
            onClick={openKitchenScreen}
            className="text-slate-800 hover:text-leaf-700 font-medium flex items-center gap-1 border-l border-slate-900/15 pl-3"
            title="Open the Kitchen Display in a new window — drag to the second monitor"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            Kitchen screen
          </button>
          <SyncStatus />
          {/* Owner can jump to the full admin dashboard (reports, accounts, AI assistant) */}
          <a
            href="http://localhost:3100"
            target="_blank"
            rel="noreferrer"
            className="text-slate-800 hover:text-accent-700 font-medium border-l border-slate-900/15 pl-3"
            title="Open Admin (reports, P&L, stock, AI assistant) in a new tab"
          >
            Admin ↗
          </a>
          <span className="font-medium">{user.fullName}</span>
          <button className="text-slate-800 hover:text-accent-700 font-medium" onClick={() => setClosingShift(true)}>Close shift</button>
          <button className="text-slate-700 hover:text-accent-700" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      {/* Business-date strip — pill on the left, drift warning grows from the right
          when the calendar has drifted ahead by ≥ 2 days. The strip is always
          visible so the date is in glanceable view above the boxes. */}
      <div className={`border-b px-4 py-2 flex items-center gap-3 ${driftAlert ? "bg-red-50 border-red-300" : "bg-white border-slate-200"}`}>
        <BusinessDatePill
          branchId={branchId}
          user={user}
          onDateLoaded={setBusinessDate}
          onDateChanged={setBusinessDate}
        />
        {driftDays !== null && driftDays >= 1 && driftDays < 2 && (
          <span className="text-xs text-amber-700">
            Calendar is {driftDays} day ahead — update the business date when convenient.
          </span>
        )}
        {driftAlert && (
          <span className="text-sm font-medium text-red-800 flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Business date is <b>{driftDays} days behind</b> real calendar — please update it.
          </span>
        )}
      </div>

      {/* Hint strip */}
      <div className="bg-white border-b border-slate-200 px-4 py-1.5 text-xs text-slate-600 flex items-center gap-4">
        <span>
          <kbd className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-mono">Space</kbd>
          <span className="ml-1 text-slate-500">open order window</span>
        </span>
        <span className="text-slate-300">·</span>
        <span>
          <kbd className="px-1.5 py-0.5 rounded bg-accent-100 text-accent-800 font-mono">Ctrl</kbd>+<kbd className="px-1.5 py-0.5 rounded bg-accent-100 text-accent-800 font-mono">1</kbd>–<kbd className="px-1.5 py-0.5 rounded bg-accent-100 text-accent-800 font-mono">7</kbd>
          <span className="ml-1 text-slate-500">push to box 1–7</span>
        </span>
        <span className="text-slate-300">·</span>
        <span className="text-slate-500">Click row → <span className="bg-yellow-200 px-1.5 rounded">select + delivered</span> · <kbd className="px-1.5 py-0.5 rounded bg-slate-200 font-mono">Shift+C</kbd> edit selected</span>
        <span className="text-slate-300">·</span>
        {mergeMode ? (
          <span className="text-green-700 font-medium">Merge mode: click orders to select ({mergeSelections.length} selected)</span>
        ) : (
          <button
            type="button"
            onClick={() => { setMergeMode(true); setMergeSelections([]); }}
            className="px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 hover:border-slate-400 font-medium"
          >
            Merge orders
          </button>
        )}
        <span className="ml-auto flex items-center gap-3">
          {/* Zoom controls */}
          <span className="flex items-center gap-1">
            <button type="button" onClick={zoomOut} disabled={pct <= 50} className="w-5 h-5 flex items-center justify-center rounded bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-sm leading-none disabled:opacity-30">−</button>
            <span className="font-mono text-[11px] font-bold text-slate-600 min-w-[32px] text-center">{pct}%</span>
            <button type="button" onClick={zoomIn}  disabled={pct >= 150} className="w-5 h-5 flex items-center justify-center rounded bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-sm leading-none disabled:opacity-30">+</button>
          </span>
          {(zoomDirty || layoutDirty) && (
            <button
              type="button"
              onClick={() => { saveZoom(); saveLayout(); }}
              className="px-3 py-0.5 rounded border border-accent-500 bg-accent-50 text-accent-800 hover:bg-accent-100 font-medium text-xs"
            >
              Save Screen
            </button>
          )}
          <span className="text-slate-400">{busy ? "syncing…" : ""}</span>
        </span>
      </div>

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
          onSelect={(boxIdx, localId) => setSelectedRow({ boxIdx, localId })}
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
      {salesOpen && <TodaySalesModal shiftId={shiftId} onClose={() => setSalesOpen(false)} />}

      {/* Hisaab Kitaab — expense ledger */}
      {ledgerOpen && (
        <LedgerScreen
          branchId={branchId}
          shiftId={shiftId}
          businessDate={businessDate}
          onClose={() => setLedgerOpen(false)}
        />
      )}

      {/* Creditor Accounts modal */}
      {creditorOpen && (
        <CreditorModal
          branchId={branchId}
          branchName={branchName}
          cashierName={user.fullName}
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
          onPushToBox={pushDraftToBox}
          editTarget={editTarget ? { orderNo: editTarget.orderNo, serverId: editTarget.serverId } : null}
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
