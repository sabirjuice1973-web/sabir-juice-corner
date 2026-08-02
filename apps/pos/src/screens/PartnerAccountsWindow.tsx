import { PartnerAccountsModal } from "../components/PartnerAccountsModal";

/**
 * Standalone popup-window wrapper for Partner Accounts — opened via
 * Pos.tsx's openPartnerAccountsWindow() (window.open("/?partners=1&...")),
 * same pattern as Payment Schedule, Kitchen Display, Stats, and Ledger.
 */
export function PartnerAccountsWindow() {
  const params = new URLSearchParams(window.location.search);
  const branchId = params.get("branchId");

  if (!branchId) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 text-sm">
        Missing branch — open this from the "Partners" button on the POS screen.
      </div>
    );
  }

  return (
    <PartnerAccountsModal
      branchId={branchId}
      standalone
      onClose={() => window.close()}
    />
  );
}
