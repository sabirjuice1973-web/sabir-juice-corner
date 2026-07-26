import { LedgerScreen } from "./LedgerScreen";

/**
 * Standalone popup-window wrapper for the Hisaab/Accounts ledger — opened via
 * Pos.tsx's openLedgerWindow() (window.open("/?ledger=1&...")), same pattern
 * as the Kitchen Display window. All the state it needs (branchId, shiftId,
 * businessDate, owner flag) travels in the URL query string rather than being
 * re-derived from localStorage, so it always matches exactly what the POS
 * window had at the moment the cashier clicked "Hisaab".
 */
export function LedgerWindow() {
  const params = new URLSearchParams(window.location.search);
  const branchId = params.get("branchId");
  const shiftId = params.get("shiftId");
  const businessDate = params.get("businessDate");
  const owner = params.get("owner") === "1";

  if (!branchId || !shiftId) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 text-sm">
        Missing branch/shift — open this from the "Hisaab" button on the POS screen.
      </div>
    );
  }

  return (
    <LedgerScreen
      branchId={branchId}
      shiftId={shiftId}
      businessDate={businessDate}
      canViewReports={owner}
      standalone
      onClose={() => window.close()}
    />
  );
}
