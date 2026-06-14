import { api } from "../api";
import {
  listPending,
  markNeedsAttention,
  pendingCount,
  removePending,
  type QueuedOrder,
} from "./orderQueue";
import { emitOrdersChanged } from "../lib/events";

/**
 * Drain the offline queue.
 *
 * Replay model:
 *   For each pending order in capture order, run the same sequence the online
 *   path would have run: create order → add each line → (apply discount) → pay.
 *   If any step throws because the server rejected it (shift closed, item
 *   removed, etc.), the order is moved to "needs attention" and the drain
 *   continues with the next one. Network failures stop the drain — we'll
 *   retry on the next online event.
 *
 * Concurrency: callers should ensure only one drain runs at a time. The
 * `runDrain` function uses a module-level flag to enforce that.
 */

let inFlight = false;
let listeners: Array<(state: SyncState) => void> = [];

export type SyncState =
  | { kind: "idle"; pending: number }
  | { kind: "syncing"; pending: number; current: string }
  | { kind: "offline"; pending: number };

function notify(state: SyncState) {
  for (const l of listeners) l(state);
}

export function subscribeSyncState(listener: (state: SyncState) => void): () => void {
  listeners.push(listener);
  // Push initial snapshot so subscribers don't have to wait for the next event.
  pendingCount().then((n) => listener(navigator.onLine ? { kind: "idle", pending: n } : { kind: "offline", pending: n }));
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

export async function runDrain(): Promise<{ replayed: number; failed: number }> {
  if (inFlight) return { replayed: 0, failed: 0 };
  if (!navigator.onLine) {
    notify({ kind: "offline", pending: await pendingCount() });
    return { replayed: 0, failed: 0 };
  }
  inFlight = true;
  let replayed = 0;
  let failed = 0;
  try {
    const queue = await listPending();
    for (const q of queue) {
      notify({ kind: "syncing", pending: queue.length - replayed - failed, current: q.localId });
      try {
        await replayOne(q);
        await removePending(q.localId);
        replayed++;
      } catch (e: any) {
        const msg = e?.body?.error || e?.message || "sync failed";
        // Distinguish network errors (retry later) from server-side rejections (park).
        if (isNetworkError(e)) {
          // Stop the drain; we'll resume when online again.
          notify({ kind: "offline", pending: await pendingCount() });
          inFlight = false;
          return { replayed, failed };
        }
        await markNeedsAttention(q, msg);
        failed++;
      }
    }
    notify({ kind: "idle", pending: 0 });
  } finally {
    inFlight = false;
  }
  return { replayed, failed };
}

function isNetworkError(e: any): boolean {
  // fetch throws TypeError on offline / DNS failure / CORS preflight failure.
  return e instanceof TypeError || (typeof e?.message === "string" && /failed to fetch|network/i.test(e.message));
}

async function replayOne(order: QueuedOrder): Promise<void> {
  // 1. Create the order with all items in one atomic call — what the new POS
  //    workflow uses live. This matches the live path exactly so an order
  //    queued offline gets the same server-side handling as one created online.
  const created = await api.createOrderWithItems({
    branchId: order.branchId,
    shiftId: order.shiftId,
    waiterBox: order.waiterBox,
    items: order.items.map((li) => ({ itemCode: li.itemCode, qty: li.qty })),
  });
  // 2. Pay if a payment was captured offline (legacy path — the new workflow
  //    pushes a draft to a box without recording payment; Save records payment
  //    once the order is in the box and the connection is live).
  if (order.payment) {
    await api.pay(created.order.id, order.payment.method, order.payment.amount);
    emitOrdersChanged();
  }
}

/**
 * Wire window online/offline events to auto-drain. Idempotent — calling twice
 * doesn't double-register listeners.
 */
let wired = false;
export function wireAutoDrain() {
  if (wired) return;
  wired = true;
  window.addEventListener("online", () => { void runDrain(); });
  window.addEventListener("offline", async () => {
    notify({ kind: "offline", pending: await pendingCount() });
  });
  // On boot: if we're online and have pending, drain immediately.
  if (navigator.onLine) {
    void runDrain();
  }
}
