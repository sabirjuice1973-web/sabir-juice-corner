import { useEffect, useState } from "react";
import { api, clearAuth, getToken, getUser, setRefreshToken, setToken, setUser, type AuthUser } from "./api";
import { Login } from "./screens/Login";
import { ShiftGate } from "./screens/ShiftGate";
import { Pos } from "./screens/Pos";
import { Kitchen } from "./screens/Kitchen";
import { wireAutoDrain } from "./offline/syncDrain";

/**
 * Detect ?kitchen=1 — the kitchen display window. Bypasses login + shift gate
 * because it reads shared localStorage from the already-logged-in POS window
 * (same origin, same machine). If the POS isn't logged in, the kitchen screen
 * just shows empty boxes until it is.
 */
function isKitchenMode(): boolean {
  try { return new URLSearchParams(window.location.search).get("kitchen") === "1"; }
  catch { return false; }
}

type Stage =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "shiftGate"; user: AuthUser }
  | { kind: "pos"; user: AuthUser; branchId: string; shiftId: string };

const BRANCH_KEY = "sjc.branchId";
const SHIFT_KEY  = "sjc.shiftId";

export function App() {
  // Kitchen Display window — short-circuit all auth / shift logic. It reads
  // POS state from localStorage and listens for storage events. Splitting into
  // two components keeps hooks compliant — Kitchen has its own, PosApp has its own.
  if (isKitchenMode()) return <Kitchen />;
  return <PosApp />;
}

function PosApp() {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });

  useEffect(() => {
    // Hook up offline sync: drains the queue on reconnect, listens to online/offline events.
    // Idempotent — safe to call on every mount.
    wireAutoDrain();

    (async () => {
      const token = getToken();
      const user = getUser();
      if (!token || !user) return setStage({ kind: "login" });

      // Verify token still works
      try {
        await api.me();
      } catch {
        setToken(null);
        setUser(null);
        return setStage({ kind: "login" });
      }

      // Try to resume an existing branch/shift
      const branchId = localStorage.getItem(BRANCH_KEY);
      const shiftId = localStorage.getItem(SHIFT_KEY);
      if (branchId && shiftId) {
        // confirm the shift is still open
        try {
          const cur = await api.currentShift(branchId);
          if (cur.shift && String(cur.shift.id) === shiftId) {
            return setStage({ kind: "pos", user, branchId, shiftId });
          }
        } catch {}
      }
      setStage({ kind: "shiftGate", user });
    })();
  }, []);

  function onLoggedIn(user: AuthUser, accessToken: string, refreshToken: string) {
    setToken(accessToken);
    setRefreshToken(refreshToken);
    setUser(user);
    setStage({ kind: "shiftGate", user });
  }

  function onShiftReady(branchId: string, shiftId: string) {
    localStorage.setItem(BRANCH_KEY, branchId);
    localStorage.setItem(SHIFT_KEY, shiftId);
    if (stage.kind === "shiftGate") {
      setStage({ kind: "pos", user: stage.user, branchId, shiftId });
    }
  }

  function logout() {
    api.logout().catch(() => {});
    clearAuth();
    localStorage.removeItem(BRANCH_KEY);
    localStorage.removeItem(SHIFT_KEY);
    setStage({ kind: "login" });
  }

  function endShift() {
    localStorage.removeItem(BRANCH_KEY);
    localStorage.removeItem(SHIFT_KEY);
    if (stage.kind === "pos") {
      setStage({ kind: "shiftGate", user: stage.user });
    }
  }

  if (stage.kind === "loading") {
    return <div className="flex h-full items-center justify-center text-slate-500">Loading…</div>;
  }
  if (stage.kind === "login") {
    return <Login onSuccess={onLoggedIn} />;
  }
  if (stage.kind === "shiftGate") {
    return <ShiftGate user={stage.user} onShiftReady={onShiftReady} onLogout={logout} />;
  }
  return (
    <Pos
      user={stage.user}
      branchId={stage.branchId}
      shiftId={stage.shiftId}
      onEndShift={endShift}
      onLogout={logout}
    />
  );
}
