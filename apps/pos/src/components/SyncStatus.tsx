import { useEffect, useState } from "react";
import { subscribeSyncState, runDrain, type SyncState } from "../offline/syncDrain";

/**
 * Pill in the POS header showing online/offline + pending-sync count.
 * Clicking it triggers a manual drain attempt (useful right after the
 * internet comes back if the cashier doesn't want to wait).
 */
export function SyncStatus() {
  const [state, setState] = useState<SyncState | null>(null);
  useEffect(() => subscribeSyncState(setState), []);

  if (!state) return null;

  const base = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer transition";

  if (state.kind === "offline") {
    return (
      <button onClick={() => runDrain()} className={`${base} bg-red-50 text-red-700 border-red-200 hover:bg-red-100`}>
        <span className="inline-block h-2 w-2 rounded-full bg-red-500"></span>
        Offline{state.pending > 0 && ` · ${state.pending} queued`}
      </button>
    );
  }
  if (state.kind === "syncing") {
    return (
      <span className={`${base} bg-amber-50 text-amber-700 border-amber-200`}>
        <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse"></span>
        Syncing… {state.pending} left
      </span>
    );
  }
  // idle
  if (state.pending > 0) {
    return (
      <button onClick={() => runDrain()} className={`${base} bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100`}>
        <span className="inline-block h-2 w-2 rounded-full bg-amber-500"></span>
        {state.pending} pending
      </button>
    );
  }
  return (
    <span className={`${base} bg-emerald-50 text-emerald-700 border-emerald-200`}>
      <span className="inline-block h-2 w-2 rounded-full bg-emerald-500"></span>
      Online
    </span>
  );
}
