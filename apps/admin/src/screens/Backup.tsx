import { useRef, useState } from "react";
import { tokenStore } from "../api";

export function Backup() {
  const [dlBusy, setDlBusy] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);

  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function downloadBackup() {
    setDlBusy(true);
    setDlError(null);
    try {
      const token = tokenStore.get();
      const res = await fetch("/api/v1/backup/export", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(cd);
      a.download = match?.[1] ?? "sjc-backup.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setDlError(e.message ?? "Download failed");
    } finally {
      setDlBusy(false);
    }
  }

  async function doRestore() {
    if (!restoreFile || !confirmed) return;
    setRestoreBusy(true);
    setRestoreMsg(null);
    try {
      const text = await restoreFile.text();
      const json = JSON.parse(text);
      const token = tokenStore.get();
      const res = await fetch("/api/v1/backup/restore", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(json),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setRestoreMsg({ ok: true, text: "Database restored successfully. Please refresh all open tabs." });
      setRestoreFile(null);
      setConfirmed(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e: any) {
      setRestoreMsg({ ok: false, text: e.message ?? "Restore failed" });
    } finally {
      setRestoreBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Backup &amp; Restore</h1>
        <p className="text-sm text-slate-500 mt-1">
          Download a full JSON backup of all sales, accounts, ledger, and user data.
          Store it on a USB drive or cloud folder. Restore from any backup to recover after a system failure.
        </p>
      </div>

      {/* ── Download ─────────────────────────────────────────────────── */}
      <section className="card p-6 space-y-4">
        <h2 className="font-semibold text-slate-700">Download Backup</h2>
        <p className="text-sm text-slate-500">
          Downloads a <strong>sjc-backup-YYYY-MM-DD.json</strong> file containing all orders,
          credit accounts, ledger entries, expenses, menu prices, and user accounts up to this moment.
          Do this <strong>weekly</strong> and save the file to a USB drive or email it to yourself.
        </p>
        {dlError && (
          <div className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{dlError}</div>
        )}
        <button
          className="btn-primary px-6 py-2.5 text-base flex items-center gap-2"
          disabled={dlBusy}
          onClick={downloadBackup}
        >
          {dlBusy ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Preparing…
            </>
          ) : (
            <>
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd"/>
              </svg>
              Download Backup Now
            </>
          )}
        </button>
        <div className="text-xs text-slate-400 border-t pt-3 space-y-1">
          <div><strong>What is backed up:</strong> Orders · Credit accounts &amp; payments · Ledger (Hisaab Kitaab) · Expenses · Menu prices · User accounts</div>
          <div><strong>What is NOT backed up:</strong> Inventory stock levels · Production batches · Raw material recipes (these can be re-entered if needed)</div>
        </div>
      </section>

      {/* ── How to restore ───────────────────────────────────────────── */}
      <section className="card p-6 space-y-3 bg-slate-50">
        <h2 className="font-semibold text-slate-700">How to Use Your Backup</h2>
        <ol className="text-sm text-slate-600 space-y-2 list-decimal list-inside">
          <li>Install the software on the new PC and make sure it is running.</li>
          <li>Log in to the Admin panel with your owner password.</li>
          <li>Go to <strong>Backup &amp; Restore</strong> → scroll to the Restore section below.</li>
          <li>Select the backup <code className="bg-slate-200 px-1 rounded">.json</code> file you downloaded.</li>
          <li>Tick the confirmation checkbox, then click <strong>Restore Database</strong>.</li>
          <li>Wait for the green success message. All data is now recovered.</li>
          <li>Close and reopen all browser tabs for the POS and Admin panel.</li>
        </ol>
        <p className="text-xs text-slate-400">
          The restore replaces <em>all</em> current data with the backup. Only do this on a fresh installation
          or when recovering from data loss.
        </p>
      </section>

      {/* ── Restore ──────────────────────────────────────────────────── */}
      <section className="card p-6 space-y-4 border-red-200 bg-red-50">
        <h2 className="font-semibold text-red-700 flex items-center gap-2">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"/>
          </svg>
          Restore Database from Backup
        </h2>
        <p className="text-sm text-red-700">
          <strong>Warning:</strong> This will permanently DELETE all current data and replace it
          with the data from the selected backup file. There is no undo.
          Only do this on a fresh PC or when recovering from data loss.
        </p>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Select backup file (.json)
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="block text-sm text-slate-700 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-slate-300 file:text-sm file:bg-white hover:file:bg-slate-50"
            onChange={(e) => {
              setRestoreFile(e.target.files?.[0] ?? null);
              setRestoreMsg(null);
              setConfirmed(false);
            }}
          />
          {restoreFile && (
            <p className="text-xs text-slate-500 mt-1">
              Selected: <strong>{restoreFile.name}</strong> ({(restoreFile.size / 1024).toFixed(0)} KB)
            </p>
          )}
        </div>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span className="text-sm text-red-800">
            I understand this will <strong>permanently delete all current data</strong> and replace it with the backup.
          </span>
        </label>

        {restoreMsg && (
          <div className={`text-sm rounded px-3 py-2 ${restoreMsg.ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
            {restoreMsg.text}
          </div>
        )}

        <button
          className="px-5 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold text-sm disabled:opacity-40 flex items-center gap-2"
          disabled={!restoreFile || !confirmed || restoreBusy}
          onClick={doRestore}
        >
          {restoreBusy ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Restoring… (may take a minute)
            </>
          ) : "Restore Database"}
        </button>
      </section>
    </div>
  );
}
