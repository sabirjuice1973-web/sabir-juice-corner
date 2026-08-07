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

// Reserve Cash — money set aside in the shop locker (separate from the
// Opening Cash/petty float above). Entered alongside Petty Cash for the same
// next business date, but never printed on the Petty Cash slip and never
// folded into Cash Today's Current Cash math — it's a second pool, shown on
// Cash Today purely so whoever's reconciling the next day (e.g. the brother
// on a morning shift) can see both the till float AND the locker reserve.
function reserveKey(branchId: string | number, forDate: string): string {
  return `sjc.reserveCash.${branchId}.${forDate}`;
}

export function getReserveCash(branchId: string | number, forDate: string): string | null {
  return localStorage.getItem(reserveKey(branchId, forDate));
}

export function setReserveCash(branchId: string | number, forDate: string, amount: string): void {
  localStorage.setItem(reserveKey(branchId, forDate), amount);
}
