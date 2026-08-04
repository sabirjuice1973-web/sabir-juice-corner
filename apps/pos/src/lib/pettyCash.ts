// Petty Cash is saved per (branch, business date) — one overwritable value per
// date, keyed the same way CashTodayModal's Opening Cash already is. Shared
// between PettyCashModal (writes it) and CashTodayModal (reads it to
// auto-fill tomorrow's Opening Cash) so the key format can't drift apart.
function key(branchId: string | number, forDate: string): string {
  return `sjc.pettyCash.${branchId}.${forDate}`;
}

export function getPettyCash(branchId: string | number, forDate: string): string | null {
  return localStorage.getItem(key(branchId, forDate));
}

export function setPettyCash(branchId: string | number, forDate: string, amount: string): void {
  localStorage.setItem(key(branchId, forDate), amount);
}
