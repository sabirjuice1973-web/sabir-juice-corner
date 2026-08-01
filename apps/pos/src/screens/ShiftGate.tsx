import { useEffect, useState } from "react";
import { api, type AuthUser } from "../api";

/**
 * Auto-connect gate: after login, silently attaches to the existing open shift
 * for the single active branch, or opens a new one (0 opening cash) if none is
 * running. The cashier never sees a branch picker or shift form — they log in
 * and land directly on the POS.
 *
 * If more than one non-kitchen branch exists the user still gets a compact
 * branch picker, but no opening-cash prompt (shift opens with 0 automatically).
 *
 * Falls back to a manual error screen if the API is unreachable.
 */
export function ShiftGate({
  user,
  onShiftReady,
  onLogout,
}: {
  user: AuthUser;
  onShiftReady: (branchId: string, shiftId: string) => void;
  onLogout: () => void;
}) {
  type Phase =
    | { kind: "loading"; msg: string }
    | { kind: "pick"; branches: { id: number; code: string; name: string }[] }
    | { kind: "error"; msg: string };

  const [phase, setPhase] = useState<Phase>({ kind: "loading", msg: "Connecting to branch…" });

  async function connectTo(branchId: string) {
    setPhase({ kind: "loading", msg: "Checking shift…" });
    try {
      const { shift } = await api.currentShift(branchId);
      if (shift) {
        onShiftReady(branchId, String(shift.id));
        return;
      }
      setPhase({ kind: "loading", msg: "Starting shift…" });
      const { shift: opened } = await api.openShift(branchId, 0);
      onShiftReady(branchId, String(opened.id));
    } catch (e: any) {
      setPhase({ kind: "error", msg: e?.message ?? "Could not connect to branch" });
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const { branches } = await api.listBranches();
        const outlets = branches.filter((b: any) => !b.isCentralKitchen);
        if (outlets.length === 0) {
          setPhase({ kind: "error", msg: "No active branch found. Please check the server." });
          return;
        }
        if (outlets.length === 1) {
          await connectTo(String(outlets[0].id));
          return;
        }
        // Multiple branches — check which one has an open shift and auto-select it.
        // This covers the common case where the server has several seeded branches
        // but only one is actually in use (has an active shift running).
        setPhase({ kind: "loading", msg: "Detecting active branch…" });
        const checks = await Promise.all(
          outlets.map(async (b: any) => {
            try {
              const { shift } = await api.currentShift(String(b.id));
              return { branch: b, hasShift: !!shift };
            } catch {
              return { branch: b, hasShift: false };
            }
          })
        );
        const withShift = checks.filter((x) => x.hasShift);
        if (withShift.length === 1) {
          // Exactly one branch has an open shift — connect to it silently.
          await connectTo(String(withShift[0].branch.id));
          return;
        }
        // Zero or multiple active branches — show a compact picker.
        setPhase({ kind: "pick", branches: outlets });
      } catch (e: any) {
        setPhase({ kind: "error", msg: e?.message ?? "Could not load branches" });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Loading ─────────────────────────────────────────────────────────────
  if (phase.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-slate-100">
        <div className="card p-8 text-center space-y-4 max-w-xs w-full">
          <svg className="animate-spin w-8 h-8 text-sjc-600 mx-auto" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
          <p className="text-slate-600 text-sm">{phase.msg}</p>
          <p className="text-xs text-slate-400">Signed in as <b>{user.fullName}</b></p>
          <button className="text-xs text-slate-400 hover:text-slate-600" onClick={onLogout}>Sign out</button>
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (phase.kind === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-slate-100">
        <div className="card p-8 text-center space-y-4 max-w-xs w-full">
          <div className="text-red-600 font-semibold">Connection failed</div>
          <p className="text-sm text-slate-600">{phase.msg}</p>
          <button
            className="btn-primary w-full"
            onClick={() => {
              setPhase({ kind: "loading", msg: "Reconnecting…" });
              // Re-run the whole effect by re-mounting isn't easy, so we just retry
              // the last step — load branches again.
              api.listBranches()
                .then(async ({ branches }) => {
                  const outlets = branches.filter((b: any) => !b.isCentralKitchen);
                  if (outlets.length === 1) {
                    await connectTo(String(outlets[0].id));
                  } else {
                    setPhase({ kind: "pick", branches: outlets });
                  }
                })
                .catch((e: any) => setPhase({ kind: "error", msg: e?.message ?? "Still offline" }));
            }}
          >
            Retry
          </button>
          <button className="text-xs text-slate-400 hover:text-slate-600" onClick={onLogout}>Sign out</button>
        </div>
      </div>
    );
  }

  // ── Branch picker (only when multiple outlets) ───────────────────────────
  return (
    <div className="flex h-full items-center justify-center bg-slate-100">
      <div className="card p-8 space-y-5 max-w-xs w-full">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-bold text-sjc-700">Select Branch</div>
            <div className="text-sm text-slate-500">Signed in as <b>{user.fullName}</b></div>
          </div>
          <button className="text-xs text-slate-500 hover:text-slate-700" onClick={onLogout}>Sign out</button>
        </div>
        <div className="space-y-2">
          {phase.branches.map((b) => {
            // Only Cantt Branch (B2) is actually in operation — the other seeded
            // branches are locked out of this picker so a mis-click can't send
            // the day's entries into the wrong branch, requiring a manual fix later.
            const isActive = b.code === "B2";
            return (
              <button
                key={b.id}
                disabled={!isActive}
                title={isActive ? undefined : "Not in use — locked to prevent accidental selection"}
                className={
                  isActive
                    ? "w-full text-left rounded-lg border border-slate-200 hover:border-sjc-400 hover:bg-sjc-50 px-4 py-3 transition-colors"
                    : "w-full text-left rounded-lg border border-slate-100 bg-slate-50 px-4 py-3 cursor-not-allowed opacity-60"
                }
                onClick={() => { if (isActive) void connectTo(String(b.id)); }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className={`font-semibold ${isActive ? "text-slate-800" : "text-slate-400"}`}>{b.name}</div>
                    <div className="text-xs text-slate-500">{b.code}</div>
                  </div>
                  {!isActive && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round" className="text-slate-400 shrink-0">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
