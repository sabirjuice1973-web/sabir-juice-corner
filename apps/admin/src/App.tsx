import { useEffect, useState } from "react";
import { api, tokenStore, type AuthUser } from "./api";
import { Login } from "./screens/Login";
import { Layout } from "./Layout";
import { Dashboard } from "./screens/Dashboard";
import { RawMaterials } from "./screens/RawMaterials";
import { Suppliers } from "./screens/Suppliers";
import { Purchases } from "./screens/Purchases";
import { Production } from "./screens/Production";
import { Recipes } from "./screens/Recipes";
import { Transfers } from "./screens/Transfers";
import { StockLevels } from "./screens/StockLevels";
import { Reports } from "./screens/Reports";
import { Alerts } from "./screens/Alerts";
import { Assistant } from "./screens/Assistant";
import { Products } from "./screens/Products";
import { Hisaab } from "./screens/Hisaab";
import { Yields } from "./screens/Yields";
import { Participations } from "./screens/Participations";
import { DailyClose } from "./screens/DailyClose";
import { Accounts } from "./screens/Accounts";

export type Screen =
  | "dashboard"
  | "products"
  | "rawMaterials"
  | "suppliers"
  | "purchases"
  | "production"
  | "recipes"
  | "transfers"
  | "stockLevels"
  | "reports"
  | "alerts"
  | "assistant"
  | "hisaab"
  | "yields"
  | "participations"
  | "dailyClose"
  | "accounts";

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  // Honor ?screen=products etc. when launched from a deep link (e.g. POS F2
  // opens /?screen=products in a new tab). Anything not in the Screen union
  // falls back to the dashboard.
  const [screen, setScreen] = useState<Screen>(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("screen");
    const valid: Screen[] = [
      "dashboard", "products", "rawMaterials", "suppliers", "purchases",
      "production", "recipes", "transfers", "stockLevels", "reports", "alerts", "assistant",
      "hisaab", "yields", "participations", "dailyClose", "accounts",
    ];
    return (valid as string[]).includes(requested ?? "") ? requested as Screen : "dashboard";
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const token = tokenStore.get();
      const u = tokenStore.getUser();
      if (!token || !u) { setLoading(false); return; }
      try {
        await api("GET", "/auth/me");
        setUser(u);
      } catch {
        tokenStore.set(null);
        tokenStore.setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Global F2 → jump to Products (Item / Code Management). Ignore the keystroke
  // while the user is typing in an input so it doesn't hijack search boxes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "F2") return;
      const el = document.activeElement as HTMLElement | null;
      const inEditable = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (inEditable) return;
      e.preventDefault();
      setScreen("products");
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (loading) return <div className="flex h-full items-center justify-center text-slate-500">Loading…</div>;
  if (!user) {
    return <Login onSuccess={(u, token, refreshToken) => {
      tokenStore.set(token);
      tokenStore.setRefresh(refreshToken);
      tokenStore.setUser(u);
      setUser(u);
    }} />;
  }

  return (
    <Layout
      user={user}
      screen={screen}
      onNavigate={setScreen}
      onLogout={() => {
        api("POST", "/auth/logout").catch(() => {});
        tokenStore.clear();
        setUser(null);
      }}
    >
      {screen === "dashboard"    && <Dashboard onNavigate={setScreen} />}
      {screen === "rawMaterials" && <RawMaterials />}
      {screen === "suppliers"    && <Suppliers />}
      {screen === "purchases"    && <Purchases />}
      {screen === "production"   && <Production />}
      {screen === "recipes"      && <Recipes />}
      {screen === "transfers"    && <Transfers />}
      {screen === "stockLevels"  && <StockLevels />}
      {screen === "reports"      && <Reports />}
      {screen === "alerts"       && <Alerts />}
      {screen === "assistant"    && <Assistant />}
      {screen === "products"      && <Products />}
      {screen === "hisaab"        && <Hisaab />}
      {screen === "yields"        && <Yields />}
      {screen === "participations" && <Participations />}
      {screen === "dailyClose"    && <DailyClose />}
      {screen === "accounts"      && <Accounts />}
    </Layout>
  );
}
