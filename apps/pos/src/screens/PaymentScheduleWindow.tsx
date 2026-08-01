import { PaymentScheduleModal } from "../components/PaymentScheduleModal";

/**
 * Standalone popup-window wrapper for the Payment Schedule — opened via
 * Pos.tsx's openPaymentScheduleWindow() (window.open("/?schedule=1&...")),
 * same pattern as the Kitchen Display, Stats, and Ledger windows. Being a
 * real separate OS window (not an in-tab modal) means it stays open and
 * keeps its own state independently of the POS tab — no need to reopen it
 * from scratch each time.
 */
export function PaymentScheduleWindow() {
  const params = new URLSearchParams(window.location.search);
  const branchId = params.get("branchId");

  if (!branchId) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 text-sm">
        Missing branch — open this from the "Schedule" button on the POS screen.
      </div>
    );
  }

  return (
    <PaymentScheduleModal
      branchId={branchId}
      standalone
      onClose={() => window.close()}
    />
  );
}
