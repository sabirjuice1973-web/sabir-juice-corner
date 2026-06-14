import type { ReactNode } from "react";
import type { Screen } from "./App";
import type { AuthUser } from "./api";
import { BrandLogo } from "./components/BrandLogo";

const NAV: { code: Screen; label: string; group?: string }[] = [
  { code: "dashboard",     label: "Dashboard" },
  { code: "hisaab",        label: "Daily Hisaab",     group: "Accounts" },
  { code: "accounts",      label: "Credit Accounts",  group: "Accounts" },
  { code: "dailyClose",    label: "Daily Branch Close",  group: "Reconciliation" },
  { code: "yields",        label: "Yield Config",        group: "Reconciliation" },
  { code: "participations",label: "Item Participations", group: "Reconciliation" },
  { code: "assistant",     label: "Assistant",        group: "Insights" },
  { code: "reports",       label: "Reports",          group: "Insights" },
  { code: "alerts",        label: "Alerts",           group: "Insights" },
  { code: "stockLevels",   label: "Stock levels",     group: "Inventory" },
  { code: "rawMaterials",  label: "Raw materials",    group: "Inventory" },
  { code: "production",    label: "Production",       group: "Inventory" },
  { code: "transfers",     label: "Transfers",        group: "Inventory" },
  { code: "suppliers",     label: "Suppliers",        group: "Procurement" },
  { code: "purchases",     label: "Purchase orders",  group: "Procurement" },
  { code: "products",      label: "Products  (F2)",   group: "Catalog" },
  { code: "recipes",       label: "Recipes",          group: "Catalog" },
];

export function Layout({
  user, screen, onNavigate, onLogout, children,
}: {
  user: AuthUser;
  screen: Screen;
  onNavigate: (s: Screen) => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const groups = new Map<string | undefined, typeof NAV>();
  for (const item of NAV) {
    const g = item.group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(item);
  }

  return (
    <div className="h-full flex">
      <aside className="w-60 border-r border-slate-200 bg-white flex flex-col">
        <div className="px-4 py-4 border-b border-slate-200 flex items-center gap-3 bg-gradient-to-r from-sjc-100 to-white">
          <BrandLogo size={40} withWordmark={false} />
          <div>
            <div className="font-display font-bold text-slate-800 leading-tight">Sabir Juice Corner</div>
            <div className="text-[10px] text-accent-700 uppercase tracking-widest">Est. 1973 · Admin</div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-3 space-y-3 overflow-y-auto">
          {[...groups.entries()].map(([group, items]) => (
            <div key={group ?? "_top"}>
              {group && <div className="text-[10px] font-semibold uppercase text-slate-400 tracking-wider px-3 mb-1">{group}</div>}
              <div className="space-y-0.5">
                {items.map((it) => (
                  <a
                    key={it.code}
                    href="#"
                    onClick={(e) => { e.preventDefault(); onNavigate(it.code); }}
                    className={`nav-link ${screen === it.code ? "nav-link-active" : ""}`}
                  >
                    {it.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-slate-200 px-4 py-3 text-sm">
          <div className="font-medium">{user.fullName}</div>
          <div className="text-xs text-slate-500 mb-2">{user.roles.map((r) => r.code).join(", ")}</div>
          <button onClick={onLogout} className="text-xs text-slate-500 hover:text-slate-800">Sign out</button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto bg-slate-50">
        <div className="max-w-6xl mx-auto p-6">{children}</div>
      </main>
    </div>
  );
}
