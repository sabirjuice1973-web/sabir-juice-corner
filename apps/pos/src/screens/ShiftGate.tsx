import { useEffect, useState } from "react";
import { api, type AuthUser } from "../api";

/**
 * After login, the cashier picks (or confirms) the branch and opens a shift.
 * If a shift is already open for that branch, we attach to it instead.
 *
 * Branches available to the user:
 *   • OWNER → any branch (we just hard-list 1..4 from the seed for now;
 *     the admin app will manage this list properly)
 *   • Otherwise → only branches the user has a role at
 */
const KNOWN_BRANCHES = [
  { id: 1, code: "CK", name: "Central Kitchen" },
  { id: 2, code: "B1", name: "Branch 1" },
  { id: 3, code: "B2", name: "Branch 2" },
  { id: 4, code: "B3", name: "Branch 3" },
];

export function ShiftGate({
  user,
  onShiftReady,
  onLogout,
}: {
  user: AuthUser;
  onShiftReady: (branchId: string, shiftId: string) => void;
  onLogout: () => void;
}) {
  const allowedBranches = user.roles.some((r) => r.code === "OWNER")
    ? KNOWN_BRANCHES
    : KNOWN_BRANCHES.filter((b) =>
        user.roles.some((r) => r.branch?.id === String(b.id)),
      );

  const [branchId, setBranchId] = useState<string>(String(allowedBranches[0]?.id ?? ""));
  const [openingCash, setOpeningCash] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openShift, setOpenShift] = useState<any | null>(null);

  useEffect(() => {
    setError(null);
    setOpenShift(null);
    if (!branchId) return;
    api.currentShift(branchId).then((r) => setOpenShift(r.shift)).catch(() => {});
  }, [branchId]);

  async function open() {
    setBusy(true); setError(null);
    try {
      const r = await api.openShift(branchId, Number(openingCash) || 0);
      onShiftReady(branchId, String(r.shift.id));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function attach() {
    if (openShift) onShiftReady(branchId, String(openShift.id));
  }

  return (
    <div className="flex h-full items-center justify-center p-4 bg-slate-100">
      <div className="card w-full max-w-md p-8 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xl font-bold text-sjc-700">Open Shift</div>
            <div className="text-sm text-slate-500">Signed in as <b>{user.fullName}</b></div>
          </div>
          <button className="text-xs text-slate-500 hover:text-slate-700" onClick={onLogout}>Sign out</button>
        </div>

        <label className="block">
          <span className="text-sm text-slate-600">Branch</span>
          <select
            className="input w-full mt-1"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            {allowedBranches.map((b) => (
              <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
            ))}
          </select>
        </label>

        {openShift ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
            <div className="text-sm font-medium text-amber-800">
              A shift is already open for this branch.
            </div>
            <div className="text-xs text-amber-700">
              Opened by <b>{openShift.openedBy?.fullName}</b> at {new Date(openShift.openedAt).toLocaleString()}
              <br />Opening cash: PKR {openShift.openingCash}
            </div>
            <button className="btn-primary w-full" onClick={attach}>
              Continue with this shift
            </button>
          </div>
        ) : (
          <>
            <label className="block">
              <span className="text-sm text-slate-600">Opening cash (PKR)</span>
              <input
                className="input w-full mt-1 font-mono"
                inputMode="numeric"
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value.replace(/[^0-9.]/g, ""))}
              />
            </label>
            {error && <div className="text-sm text-red-600">{error}</div>}
            <button className="btn-primary w-full" disabled={busy} onClick={open}>
              {busy ? "Opening…" : "Open shift"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
