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
  { code: "backup",        label: "Backup & Restore", group: "System" },
  { code: "users",         label: "Users & Accounts", group: "System" },
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

  // Initials for the footer avatar — "Sabir Owner" -> "SO", single name -> first two letters.
  const initials = user.fullName.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="h-full flex bg-slate-100">
      <aside className="w-60 border-r border-slate-200 bg-white flex flex-col shadow-[1px_0_0_0_rgba(0,0,0,0.02),2px_0_12px_rgba(15,23,42,0.03)]">
        <div className="px-4 py-4 border-b border-slate-200 flex items-center gap-3 bg-gradient-to-br from-sjc-100 via-sjc-50 to-white">
          <BrandLogo size={40} withWordmark={false} />
          <div>
            <div className="font-display font-bold text-slate-800 leading-tight">Sabir Juice Corner</div>
            <div className="text-[10px] text-accent-700 uppercase tracking-widest font-semibold">Est. 1973 · Admin</div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
          {[...groups.entries()].map(([group, items]) => (
            <div key={group ?? "_top"}>
              {group && <div className="text-[10px] font-bold uppercase text-slate-400 tracking-widest px-3 mb-1.5">{group}</div>}
              <div className="space-y-0.5">
                {items.map((it) => (
                  <a
                    key={it.code}
                    href="#"
                    onClick={(e) => { e.preventDefault(); onNavigate(it.code); }}
                    className={`nav-link border-l-2 ${screen === it.code ? "nav-link-active border-accent-600" : "border-transparent"}`}
                  >
                    {it.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-slate-200 px-4 py-3 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-accent-600 text-white flex items-center justify-center text-xs font-bold shrink-0 shadow-sm shadow-accent-900/30">
            {initials || "?"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm text-slate-800 truncate">{user.fullName}</div>
            <div className="text-[11px] text-slate-500 truncate">{user.roles.map((r) => r.code).join(", ")}</div>
          </div>
          <button onClick={onLogout} title="Sign out"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-6">{children}</div>
      </main>
    </div>
  );
}
