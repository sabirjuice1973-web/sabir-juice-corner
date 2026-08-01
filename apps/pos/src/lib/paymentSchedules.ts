/**
 * Named saved Payment Schedule date ranges (e.g. "August 2026" → 08/01–08/31),
 * persisted per-branch in localStorage so the standalone Payment Schedule
 * window can jump straight to one with a click instead of re-picking both
 * date fields every time.
 */

const SAVED_KEY_PREFIX = "sjc.paymentSchedule.saved.";

export type SavedSchedule = { name: string; from: string; to: string };

export function loadSavedSchedules(branchId: string): SavedSchedule[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY_PREFIX + branchId);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

export function writeSavedSchedules(branchId: string, list: SavedSchedule[]): void {
  try { localStorage.setItem(SAVED_KEY_PREFIX + branchId, JSON.stringify(list)); } catch { /* ignore */ }
}
