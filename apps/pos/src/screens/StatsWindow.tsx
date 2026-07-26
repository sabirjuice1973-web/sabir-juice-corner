import { StatsScreen } from "../components/StatsScreen";

/**
 * Standalone popup-window wrapper for Statistics & Insights — opened via
 * Pos.tsx's openStatsWindow() (window.open("/?stats=1&...")), same pattern as
 * the Kitchen Display window and LedgerWindow.
 */
export function StatsWindow() {
  const params = new URLSearchParams(window.location.search);
  const branchId = params.get("branchId");
  const shiftId = params.get("shiftId");

  if (!branchId || !shiftId) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 text-sm">
        Missing branch/shift — open this from the "Stats" button on the POS screen.
      </div>
    );
  }

  return (
    <StatsScreen
      branchId={branchId}
      shiftId={shiftId}
      standalone
      onClose={() => window.close()}
    />
  );
}
