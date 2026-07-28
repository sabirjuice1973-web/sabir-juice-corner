import { useEffect, useState } from "react";
import { api } from "../api";

type UserRow = {
  id: string;
  username: string;
  fullName: string;
  status: string;
  lastLoginAt: string | null;
  userRoles: {
    role: { code: string };
    branch: { id: string; code: string; name: string } | null;
  }[];
};

type Branch = { id: string; code: string; name: string };

const ROLE_OPTIONS = [
  { value: "CASHIER",         label: "Cashier / Manager (POS access, restricted view)" },
  { value: "BRANCH_MANAGER",  label: "Branch Manager (POS access, restricted view)" },
  { value: "ACCOUNTANT",      label: "Accountant (admin access)" },
];

export function Users() {
  const [users, setUsers]       = useState<UserRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  // New user form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: "", fullName: "", password: "", roleCode: "CASHIER", branchId: "" });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Change password
  const [pwTarget, setPwTarget] = useState<UserRow | null>(null);
  const [newPw, setNewPw]       = useState("");
  const [pwBusy, setPwBusy]     = useState(false);
  const [pwError, setPwError]   = useState<string | null>(null);
  const [pwOk, setPwOk]         = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [{ users: u }, { branches: b }] = await Promise.all([
        api("GET", "/users"),
        api("GET", "/branches"),
      ]);
      setUsers(u);
      setBranches((b as Branch[]).filter((br: any) => !br.isCentralKitchen));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function createUser() {
    if (!form.username.trim() || !form.fullName.trim() || !form.password.trim()) {
      setFormError("Username, full name, and password are all required."); return;
    }
    setFormBusy(true); setFormError(null);
    try {
      await api("POST", "/users", {
        username: form.username.trim(),
        fullName: form.fullName.trim(),
        password: form.password,
        roleCode: form.roleCode,
        branchId: form.branchId || undefined,
      });
      setShowForm(false);
      setForm({ username: "", fullName: "", password: "", roleCode: "CASHIER", branchId: "" });
      await load();
    } catch (e: any) {
      setFormError(e?.message ?? "Failed to create user");
    } finally {
      setFormBusy(false);
    }
  }

  async function changePassword() {
    if (!pwTarget || !newPw.trim()) return;
    setPwBusy(true); setPwError(null); setPwOk(false);
    try {
      await api("PATCH", `/users/${pwTarget.id}/password`, { password: newPw });
      setPwOk(true);
      setNewPw("");
    } catch (e: any) {
      setPwError(e?.message ?? "Failed to change password");
    } finally {
      setPwBusy(false);
    }
  }

  async function toggleStatus(u: UserRow) {
    const action = u.status === "ACTIVE" ? "deactivate" : "activate";
    if (!confirm(`${action === "deactivate" ? "Deactivate" : "Re-activate"} user "${u.fullName}"?`)) return;
    try {
      await api("PATCH", `/users/${u.id}/${action}`);
      await load();
    } catch (e: any) {
      alert(e?.message ?? "Failed");
    }
  }

  function roleBadge(u: UserRow) {
    if (!u.userRoles.length) return <span className="text-slate-400 text-xs">No role</span>;
    return (
      <div className="space-y-0.5">
        {u.userRoles.map((ur, i) => (
          <div key={i} className="flex items-center gap-1 flex-wrap">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              ur.role.code === "OWNER" ? "bg-amber-100 text-amber-800" :
              ur.role.code === "ACCOUNTANT" ? "bg-purple-100 text-purple-800" :
              "bg-slate-100 text-slate-700"
            }`}>{ur.role.code}</span>
            {ur.branch && <span className="text-xs text-slate-500">{ur.branch.name}</span>}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Users & Accounts</h1>
          <p className="text-sm text-slate-500 mt-1">
            Create login accounts for your managers and cashiers. Non-owner accounts
            have restricted access: Sales, Stats, and Hisaab Reports are hidden.
          </p>
        </div>
        <button className="btn-primary px-4 py-2 text-sm" onClick={() => { setShowForm(true); setFormError(null); }}>
          + New User
        </button>
      </div>

      {/* ── New user form ─────────────────────────────────────────────── */}
      {showForm && (
        <div className="card p-5 border-sjc-200 bg-sjc-50/30 space-y-4">
          <div className="font-semibold text-slate-700">Create New User</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Full Name *</label>
              <input className="input w-full" placeholder="e.g. Ahmed Khan"
                value={form.fullName} onChange={(e) => setForm((p) => ({ ...p, fullName: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Username *</label>
              <input className="input w-full" placeholder="e.g. ahmed" autoComplete="off"
                value={form.username} onChange={(e) => setForm((p) => ({ ...p, username: e.target.value.toLowerCase().replace(/\s/g, "") }))} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Password *</label>
              <input className="input w-full" type="password" placeholder="Min 4 characters" autoComplete="new-password"
                value={form.password} onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Role</label>
              <select className="input w-full" value={form.roleCode} onChange={(e) => setForm((p) => ({ ...p, roleCode: e.target.value }))}>
                {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Branch (optional)</label>
              <select className="input w-full" value={form.branchId} onChange={(e) => setForm((p) => ({ ...p, branchId: e.target.value }))}>
                <option value="">All branches</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
              </select>
            </div>
          </div>
          {formError && <div className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{formError}</div>}
          <div className="flex gap-2">
            <button className="btn-primary px-5 py-2 text-sm" disabled={formBusy} onClick={createUser}>
              {formBusy ? "Creating…" : "Create User"}
            </button>
            <button className="btn-secondary px-4 py-2 text-sm" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── User table ────────────────────────────────────────────────── */}
      {loading ? (
        <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>
      ) : error ? (
        <div className="text-red-600 text-sm">{error}</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Full Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Username</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Role / Branch</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Last Login</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-slate-600 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.id} className={`transition-colors hover:bg-slate-50 ${u.status !== "ACTIVE" ? "opacity-50" : ""}`}>
                  <td className="px-4 py-3 font-medium text-slate-900">{u.fullName}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{u.username}</td>
                  <td className="px-4 py-3">{roleBadge(u)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${u.status === "ACTIVE" ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-500"}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString("en-PK") : "Never"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-blue-100 text-slate-700 hover:text-blue-700"
                        onClick={() => { setPwTarget(u); setNewPw(""); setPwError(null); setPwOk(false); }}
                      >
                        Change Password
                      </button>
                      {/* Deactivating the OWNER account would lock everyone out — never offer it here */}
                      {!u.userRoles.some((r) => r.role.code === "OWNER") && (
                        <button
                          className={`text-xs px-2 py-1 rounded ${u.status === "ACTIVE" ? "bg-slate-100 hover:bg-red-100 text-slate-700 hover:text-red-700" : "bg-slate-100 hover:bg-green-100 text-slate-700 hover:text-green-700"}`}
                          onClick={() => void toggleStatus(u)}
                        >
                          {u.status === "ACTIVE" ? "Deactivate" : "Re-activate (Suspended)"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && (
            <div className="text-center py-10 text-slate-400 text-sm">No users yet — create one above.</div>
          )}
        </div>
      )}

      {/* ── Change password modal ──────────────────────────────────────── */}
      {pwTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="font-semibold text-slate-800">Change Password</div>
            <div className="text-sm text-slate-600">Setting new password for <strong>{pwTarget.fullName}</strong> ({pwTarget.username})</div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">New Password</label>
              <input
                className="input w-full"
                type="password"
                placeholder="Min 4 characters"
                autoComplete="new-password"
                autoFocus
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void changePassword(); }}
              />
            </div>
            {pwError && <div className="text-sm text-red-600">{pwError}</div>}
            {pwOk && <div className="text-sm text-green-700 bg-green-50 rounded px-3 py-2">Password changed successfully.</div>}
            <div className="flex gap-2">
              <button className="btn-primary px-4 py-2 text-sm" disabled={pwBusy || !newPw.trim()} onClick={changePassword}>
                {pwBusy ? "Saving…" : "Save Password"}
              </button>
              <button className="btn-secondary px-4 py-2 text-sm" onClick={() => { setPwTarget(null); setPwOk(false); }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
