/**
 * Lightweight global event bus for "something changed on the server" signals.
 *
 * Why a window event and not a React context: the events fire from many places
 * (saveOnly in Pos, PayDialog, OrderDetails, the offline sync drain in a worker-
 * adjacent module). Prop-drilling a callback through all of those is noisy and
 * fragile. A window event is one call from any code path and any component can
 * listen without being a descendant of the emitter.
 *
 * Current channels:
 *   "sjc:orders-changed" — fires after pay / void / replace-items succeeds.
 *                          TodayStats and the TodaySalesModal refetch on this.
 */

export const ORDERS_CHANGED = "sjc:orders-changed";

export function emitOrdersChanged(): void {
  try {
    window.dispatchEvent(new Event(ORDERS_CHANGED));
  } catch {
    // SSR or test env — ignore silently.
  }
}
