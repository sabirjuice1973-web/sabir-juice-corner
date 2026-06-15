// Thin API client. The dev server proxies /api to http://localhost:4000.
// Access + refresh tokens live in localStorage. On 401 we silently exchange
// the refresh token for a new access token and replay the original request,
// so a long cashier shift doesn't bounce them to login every hour.

const TOKEN_KEY = "sjc.accessToken";
const REFRESH_KEY = "sjc.refreshToken";
const USER_KEY = "sjc.user";

export type AuthUser = {
  id: string;
  username: string;
  fullName: string;
  roles: { code: string; branch: { id: string; code: string; name: string } | null }[];
};

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}
export function setRefreshToken(token: string | null) {
  if (token) localStorage.setItem(REFRESH_KEY, token);
  else localStorage.removeItem(REFRESH_KEY);
}
export function getUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}
export function setUser(user: AuthUser | null) {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
}
export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

// Single shared refresh promise so concurrent 401s collapse into one refresh call.
let refreshPromise: Promise<string | null> | null = null;
async function tryRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  const rt = getRefreshToken();
  if (!rt) return null;
  refreshPromise = (async () => {
    try {
      const res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) {
        // Refresh itself failed — clear so the next 401 surfaces to the UI.
        clearAuth();
        return null;
      }
      const data = await res.json();
      setToken(data.accessToken);
      return data.accessToken as string;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const fire = async (token: string | null) => {
    // Only set Content-Type when we're actually sending a JSON body — Fastify
    // 5's default JSON parser rejects "Content-Type: application/json" with
    // an empty body (FST_ERR_CTP_EMPTY_JSON_BODY), which breaks DELETE / body-less POST.
    const hasBody = body !== undefined && body !== null;
    return fetch(`/api/v1${path}`, {
      method,
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
  };

  let res = await fire(getToken());

  // On 401, try a silent refresh once and replay. Skip on /auth/* endpoints
  // themselves so a failing login doesn't loop.
  if (res.status === 401 && getRefreshToken() && !path.startsWith("/auth/")) {
    const fresh = await tryRefresh();
    if (fresh) res = await fire(fresh);
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err: any = new Error(json?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json as T;
}

export const api = {
  // auth
  login: (username: string, password: string) =>
    request<{ user: AuthUser; accessToken: string; refreshToken: string }>("POST", "/auth/login", { username, password }),
  logout: () => request<void>("POST", "/auth/logout"),
  me: () => request<{ user: AuthUser; roles: any[] }>("GET", "/auth/me"),

  // branch business date (per-branch manual clock for all entries)
  getBranchBusinessDate: (branchId: string | number) =>
    request<{ branchId: string; code: string; name: string; businessDate: string }>("GET", `/branches/${branchId}/business-date`),
  setBranchBusinessDate: (branchId: string | number, date: string) =>
    request<{ branchId: string; businessDate: string; changed: boolean }>("PATCH", `/branches/${branchId}/business-date`, { date }),

  // shifts
  currentShift: (branchId: string | number) =>
    request<{ shift: any | null }>("GET", `/shifts/current?branchId=${branchId}`),
  openShift: (branchId: string | number, openingCash: number) =>
    request<{ shift: any }>("POST", "/shifts/open", { branchId: Number(branchId), openingCash }),
  closeShift: (shiftId: string | number, closingCash: number) =>
    request<{ shift: any; summary: any }>("POST", `/shifts/${shiftId}/close`, { closingCash }),

  // items
  itemByCode: (code: number) => request<Item>("GET", `/items/by-code/${code}`),
  searchItems: (q: string, limit = 12) =>
    request<{ items: Item[]; nextCursor: string | null }>("GET", `/items?q=${encodeURIComponent(q)}&limit=${limit}`),

  // orders
  listOpenOrders: (branchId: string | number, shiftId: string | number) =>
    request<{ orders: Order[] }>("GET", `/orders?branchId=${branchId}&shiftId=${shiftId}&status=OPEN&limit=50`),
  getOrder: (orderId: string | number) =>
    request<{ order: Order }>("GET", `/orders/${orderId}`),
  replaceOrderItems: (orderId: string | number, items: ({ itemCode: number; qty: number } | { mixOf: number[]; qty: number })[], toBox?: number) =>
    request<{ order: Order }>("PUT", `/orders/${orderId}/replace-items`, { items, ...(toBox !== undefined ? { toBox } : {}) }),
  mergeOrders: (orderIds: (string | number)[]) =>
    request<{ order: Order }>("POST", "/orders/merge", { orderIds: orderIds.map(Number) }),

  // accounts — push order to credit account, list accounts
  pushOrderToAccount: (args: { orderId: string | number; accountId?: string | number; type?: "FOODPANDA" | "MARKET" | "CUSTOMER"; name?: string; phone?: string }) =>
    request<{ ok: boolean; order: { id: string; status: string; accountId: string }; currentBalance: string; orderCount: number }>("POST", "/accounts/push-order", args),
  listAccounts: (branchId: string | number, type?: "FOODPANDA" | "MARKET" | "CUSTOMER", search?: string) => {
    const qs = new URLSearchParams({ branchId: String(branchId) });
    if (type) qs.set("type", type);
    if (search) qs.set("search", search);
    return request<{ accounts: any[] }>("GET", `/accounts?${qs}`);
  },
  getAccount: (accountId: string | number) =>
    request<any>("GET", `/accounts/${accountId}`),
  recordAccountPayment: (accountId: string | number, args: { amount: number; discount?: number; notes?: string; orderApplications?: { orderId: string; appliedAmount: number }[] }) =>
    request<any>("POST", `/accounts/${accountId}/payments`, { method: "CASH", ...args }),
  createOrder: (branchId: string | number, shiftId: string | number, waiterBox: number) =>
    request<{ order: Order }>("POST", "/orders", { branchId: Number(branchId), shiftId: Number(shiftId), waiterBox }),
  createOrderWithItems: (args: {
    branchId: string | number;
    shiftId: string | number;
    waiterBox: number;
    customerName?: string;
    items: ({ itemCode: number; qty: number } | { mixOf: number[]; qty: number })[];
  }) =>
    request<{ order: Order }>("POST", "/orders/with-items", {
      branchId: Number(args.branchId),
      shiftId: Number(args.shiftId),
      waiterBox: args.waiterBox,
      customerName: args.customerName,
      items: args.items,
    }),

  todayStats: (shiftId: string | number) =>
    request<{
      shiftId: string;
      orderCount: number;
      salesTotal: string;
      discountsTotal: string;
      byMethod: { cash: string; card: string; wallet: string; credit: string; bank: string };
      lateCashReceived: string;
      lateDiscount: string;
    }>("GET", `/shifts/${shiftId}/today-stats`),

  // ─── Today's Sales — orders list + per-item summary for the active shift ──
  todayOrders: (shiftId: string | number, from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to)   qs.set("to", to);
    const q = qs.toString();
    return request<{ orders: TodayOrder[] }>("GET", `/shifts/${shiftId}/today-orders${q ? `?${q}` : ""}`);
  },
  itemSummary: (shiftId: string | number, from?: string, to?: string, type?: "CASH" | "CREDIT") => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to)   qs.set("to", to);
    if (type) qs.set("type", type);
    const q = qs.toString();
    return request<{
      items: {
        itemId: string; itemCode: number | null; name: string; size: string;
        qty: string; revenue: string; isMix: boolean;
      }[];
      totals: { qty: string; revenue: string };
    }>("GET", `/shifts/${shiftId}/item-summary${q ? `?${q}` : ""}`);
  },
  addItem: (orderId: string | number, itemCode: number, qty: number) =>
    request<{ order: Order }>("POST", `/orders/${orderId}/items`, { itemCode, qty }),
  removeItem: (orderId: string | number, lineId: string) =>
    request<{ order: Order }>("DELETE", `/orders/${orderId}/items/${lineId}`),
  applyDiscount: (orderId: string | number, discountType: "PERCENT" | "FLAT", value: number, reason?: string) =>
    request<{ order: Order }>("POST", `/orders/${orderId}/discount`, { discountType, value, reason }),
  pay: (orderId: string | number, method: "CASH" | "CARD" | "WALLET" | "CREDIT" | "BANK_TRANSFER", amount: number) =>
    request<{ order: Order; change: string }>("POST", `/orders/${orderId}/pay`, { method, amount }),
  voidOrder: (orderId: string | number, reason: string) =>
    request<{ order: Order }>("POST", `/orders/${orderId}/void`, { reason }),

  // ─── Ledger / Khatabook ────────────────────────────────────────────────

  ledgerAccounts: (branchId: string | number) =>
    request<{ accounts: LedgerAccount[] }>("GET", `/ledger/accounts?branchId=${branchId}`),

  renameAccount: (accountId: string | number, name: string) =>
    request<{ account: LedgerAccount }>("PATCH", `/ledger/accounts/${accountId}`, { name }),

  ledgerEntries: (ledgerAccountId: string | number, opts?: { from?: string; to?: string; limit?: number; sort?: "asc" | "desc" }) => {
    const qs = new URLSearchParams({ ledgerAccountId: String(ledgerAccountId) });
    if (opts?.from) qs.set("from", opts.from);
    if (opts?.to) qs.set("to", opts.to);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.sort) qs.set("sort", opts.sort);
    return request<{ entries: LedgerEntry[] }>("GET", `/ledger/entries?${qs}`);
  },

  createLedgerEntry: (body: {
    ledgerAccountId: string | number;
    entryDate: string;
    productName: string;
    quantity?: number | null;
    rate?: number | null;
    total: number;
    headName?: string | null;
    supplierName?: string | null;
    cashPaid: number;
    description?: string | null;
    attachmentUrl?: string | null;
  }) => request<{ entry: LedgerEntry }>("POST", "/ledger/entries", body),

  updateLedgerEntry: (entryId: string | number, body: Partial<{
    entryDate: string;
    productName: string;
    quantity: number | null;
    rate: number | null;
    total: number;
    headName: string | null;
    supplierName: string | null;
    cashPaid: number;
    description: string | null;
    attachmentUrl: string | null;
  }>) => request<{ entry: LedgerEntry }>("PATCH", `/ledger/entries/${entryId}`, body),

  deleteLedgerEntry: (entryId: string | number) =>
    request<void>("DELETE", `/ledger/entries/${entryId}`),

  ledgerUploadAttachment: async (file: File): Promise<{ url: string }> => {
    const form = new FormData();
    form.append("file", file);
    const token = getToken();
    const res = await fetch("/api/v1/ledger/entries/upload", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) throw new Error("Upload failed");
    return res.json();
  },

  ledgerSuggestions: (branchId: string | number, field: "productName" | "supplierName" | "headName", q: string, opts?: { from?: string; to?: string; accountId?: string | number }) => {
    const qs = new URLSearchParams({ branchId: String(branchId), field, q });
    if (opts?.from)      qs.set("from", opts.from);
    if (opts?.to)        qs.set("to", opts.to);
    if (opts?.accountId) qs.set("accountId", String(opts.accountId));
    return request<{ suggestions: string[] }>("GET", `/ledger/suggestions?${qs}`);
  },

  ledgerReport: (params: {
    branchId: string | number;
    from?: string;
    to?: string;
    accountIds?: string[];
    headName?: string;
    supplierName?: string;
    productName?: string;
  }) => {
    const qs = new URLSearchParams({ branchId: String(params.branchId) });
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.accountIds?.length) qs.set("accountIds", params.accountIds.join(","));
    if (params.headName) qs.set("headName", params.headName);
    if (params.supplierName) qs.set("supplierName", params.supplierName);
    if (params.productName) qs.set("productName", params.productName);
    return request<{
      groups: {
        account: { id: string; position: number; name: string };
        entries: LedgerEntry[];
        totalAmount: string;
        totalCashPaid: string;
      }[];
      grandTotalAmount: string;
      grandTotalCashPaid: string;
      rowCount: number;
    }>("GET", `/ledger/report?${qs}`);
  },

  ledgerCashToday: (branchId: string | number, date: string) =>
    request<{ date: string; totalExpenses: string }>("GET", `/ledger/cash-today?branchId=${branchId}&date=${date}`),
};

export type Item = {
  id: string;
  itemCode: number;
  name: string;
  size: "MEDIUM" | "JUMBO" | "NA";
  price: string;
  category: { id: string; name: string } | null;
  pair: { id: string; itemCode: number; name: string; size: string } | null;
};

export type OrderItem = {
  id: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  item: { itemCode: number; name: string; size: string };
};

export type Order = {
  id: string;
  orderNo: string;
  branchId: string;
  shiftId: string;
  waiterBox: number | null;
  orderType: string;
  status: "OPEN" | "PAID" | "CANCELLED" | "VOIDED";
  subtotal: string;
  discountAmount: string;
  total: string;
  items: OrderItem[];
  payments: { method: string; amount: string }[];
  openedAt: string;
};

export type LedgerAccount = {
  id: string;
  branchId: string;
  position: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type LedgerEntry = {
  id: string;
  branchId: string;
  ledgerAccountId: string;
  entryDate: string;
  productName: string;
  quantity: string | null;
  rate: string | null;
  total: string;
  headName: string | null;
  supplierName: string | null;
  cashPaid: string;
  description: string | null;
  attachmentUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Slim Order shape used in the "Today's Sales" panel — no full items array. */
export type TodayOrder = {
  id: string;
  orderNo: string;
  status: "OPEN" | "PAID" | "CANCELLED" | "VOIDED";
  waiterBox: number | null;
  openedAt: string;
  closedAt: string | null;
  subtotal: string;
  discountAmount: string;
  total: string;
  cashier: { id: string; fullName: string; username: string } | null;
  cancelReason: string | null;
  payments: { method: string; amount: string }[];
};
