import { useState } from "react";
import { api, type AuthUser } from "../api";
import { BrandLogo } from "../components/BrandLogo";

export function Login({ onSuccess }: { onSuccess: (user: AuthUser, token: string, refreshToken: string) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ user: AuthUser; accessToken: string; refreshToken: string }>("POST", "/auth/login", { username, password });
      onSuccess(r.user, r.accessToken, r.refreshToken);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-gradient-to-br from-sjc-100 via-sjc-200 to-sjc-300">
      {/* Soft decorative glow blobs — purely atmospheric, sit behind the card. */}
      <div className="pointer-events-none absolute -top-24 -left-24 w-96 h-96 rounded-full bg-accent-400/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-16 w-[28rem] h-[28rem] rounded-full bg-sjc-500/25 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 right-1/4 w-64 h-64 rounded-full bg-leaf-400/10 blur-3xl" />

      <form onSubmit={submit} className="relative card w-full max-w-sm p-8 space-y-5 shadow-2xl shadow-black/10">
        <div className="flex flex-col items-center text-center">
          <BrandLogo variant="stacked" size={170} />
          <div className="text-xs text-slate-500 uppercase tracking-widest mt-2">Est. 1973 · Multan</div>
          <div className="text-sm text-accent-700 font-medium mt-3">Admin — sign in</div>
        </div>
        <label className="block">
          <span className="text-sm text-slate-600">Username</span>
          <input className="input w-full mt-1" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm text-slate-600">Password</span>
          <input className="input w-full mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}
