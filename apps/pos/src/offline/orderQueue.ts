import { get, set, del, keys } from "idb-keyval";

/**
 * Offline order queue (IndexedDB-backed).
 *
 * Why the queue exists:
 *   Internet drops at branches are routine in Multan. We want the cashier to
 *   keep billing through outages, then auto-sync once the connection returns.
 *
 * How it works:
 *   1. The POS calls api.createOrder() etc. through a thin adapter (offlineApi).
 *   2. If the request fails because we're offline (or the API is unreachable),
 *      the adapter enqueues a *full* order spec — branch, shift, waiterBox,
 *      a deterministic items list, and an optional payment — into IndexedDB
 *      with a temporary `localId` like `LOCAL-2026-05-28T13:14:15.123Z-abc`.
 *   3. The UI shows the temp order with an "OFFLINE" badge in its waiter box.
 *   4. When `navigator.onLine` returns true (or `window` fires `online`), we
 *      drain the queue: replay each spec against the live API in order,
 *      promoting the local order to a real one with a server-assigned orderNo.
 *
 * Conflicts the replay can hit:
 *   - The shift was closed before sync. The order is moved to a `needs_attention`
 *     bucket and surfaced to the manager — no money is lost; we just need a
 *     human decision (re-open shift, re-bill, or discard).
 *   - An item code was removed between offline punch and sync. Same treatment.
 *   - The branch lost connectivity for so long that the token expired. The
 *     auth layer above us handles refresh on its own.
 *
 * What lives in IndexedDB:
 *   pending:<localId> → QueuedOrder        — orders waiting to sync
 *   needs:<localId>   → QueuedOrder + err  — orders that failed sync
 *
 * Note: idb-keyval gives us one big key/value store, which is fine because
 * order specs are small (~1 KB each) and we never query by anything but key.
 */

export type QueuedOrderItem = {
  itemCode: number;
  qty: number;
  modifierIds?: number[];
  notes?: string;
};

export type QueuedPayment = {
  method: "CASH" | "CARD" | "WALLET" | "CREDIT" | "BANK_TRANSFER";
  amount: number;
};

export type QueuedOrder = {
  localId: string;
  branchId: string;
  shiftId: string;
  waiterBox: number;
  orderType?: "DINE_IN" | "TAKEAWAY" | "DELIVERY";
  items: QueuedOrderItem[];
  payment?: QueuedPayment;
  capturedAt: string;             // ISO timestamp when the cashier finalised the order locally
  attempts?: number;
  lastError?: string;
};

const PREFIX_PENDING = "pending:";
const PREFIX_NEEDS = "needs:";

function makeLocalId(): string {
  // Random suffix prevents collisions when the cashier punches two orders in the same ms.
  const r = Math.random().toString(36).slice(2, 8);
  return `LOCAL-${new Date().toISOString()}-${r}`;
}

export async function enqueue(order: Omit<QueuedOrder, "localId" | "capturedAt" | "attempts">): Promise<QueuedOrder> {
  const full: QueuedOrder = {
    ...order,
    localId: makeLocalId(),
    capturedAt: new Date().toISOString(),
    attempts: 0,
  };
  await set(PREFIX_PENDING + full.localId, full);
  return full;
}

export async function listPending(): Promise<QueuedOrder[]> {
  const allKeys = await keys();
  const pending: QueuedOrder[] = [];
  for (const k of allKeys) {
    if (typeof k === "string" && k.startsWith(PREFIX_PENDING)) {
      const v = await get<QueuedOrder>(k);
      if (v) pending.push(v);
    }
  }
  pending.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  return pending;
}

export async function listNeedsAttention(): Promise<QueuedOrder[]> {
  const allKeys = await keys();
  const arr: QueuedOrder[] = [];
  for (const k of allKeys) {
    if (typeof k === "string" && k.startsWith(PREFIX_NEEDS)) {
      const v = await get<QueuedOrder>(k);
      if (v) arr.push(v);
    }
  }
  return arr;
}

export async function removePending(localId: string): Promise<void> {
  await del(PREFIX_PENDING + localId);
}

export async function markNeedsAttention(order: QueuedOrder, error: string): Promise<void> {
  await del(PREFIX_PENDING + order.localId);
  await set(PREFIX_NEEDS + order.localId, { ...order, lastError: error });
}

export async function resolveNeedsAttention(localId: string): Promise<void> {
  await del(PREFIX_NEEDS + localId);
}

export async function pendingCount(): Promise<number> {
  const allKeys = await keys();
  return allKeys.filter((k) => typeof k === "string" && k.startsWith(PREFIX_PENDING)).length;
}
