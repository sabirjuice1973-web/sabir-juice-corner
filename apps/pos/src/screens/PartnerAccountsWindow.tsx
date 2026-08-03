import { PartnerAccountsModal } from "../components/PartnerAccountsModal";

/**
 * Standalone popup-window wrapper for Self Loan (Partner Accounts) — opened
 * via Pos.tsx's openPartnerAccountsWindow() (window.open("/?partners=1&...")),
 * same pattern as Payment Schedule, Kitchen Display, Stats, and Ledger.
 *
 * Owner-only. The API rejects non-owners regardless (see partnerAccounts.ts),
 * but we also hide the screen client-side via the owner=1 URL flag so a
 * cashier account can't even see it, not just get an error.
 */
export function PartnerAccountsWindow() {
  const params = new URLSearchParams(window.location.search);
  const branchId = params.get("branchId");
  const owner = params.get("owner") === "1";
  const businessDate = params.get("businessDate");

  if (!branchId) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 text-sm">
        Missing branch — open this from the "Self Loan" button on the POS screen.
      </div>
    );
  }
  if (!owner) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500 text-sm">
        This screen is only available to owner accounts.
      </div>
    );
  }

  return (
    <PartnerAccountsModal
      branchId={branchId}
      businessDate={businessDate}
      standalone
      onClose={() => window.close()}
    />
  );
}
