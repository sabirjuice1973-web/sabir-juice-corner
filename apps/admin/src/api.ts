const TOKEN_KEY = "sjc.admin.accessToken";
const REFRESH_KEY = "sjc.admin.refreshToken";
const USER_KEY  = "sjc.admin.user";

export type AuthUser = {
  id: string;
  username: string;
  fullName: string;
  roles: { code: string; branch: { id: string; code: string; name: string } | null }[];
};

export const tokenStore = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (t: string | null) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY),
  getRefresh: (): string | null => localStorage.getItem(REFRESH_KEY),
  setRefresh: (t: string | null) => t ? localStorage.setItem(REFRESH_KEY, t) : localStorage.removeItem(REFRESH_KEY),
  getUser: (): AuthUser | null => {
    const r = localStorage.getItem(USER_KEY);
    return r ? JSON.parse(r) : null;
  },
  setUser: (u: AuthUser | null) => u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY),
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

/**
 * Token refresh — silent.
 *
 * Access tokens live for ~1 hour (server setting). When one expires the
 * server returns 401, we exchange the refresh token for a new access token,
 * and replay the original request. Refresh tokens live 7 days; if even the
 * refresh fails we clear local storage and the next API call will surface
 * a 401 to the UI, which routes the user back to the login screen.
 *
 * Concurrent requests don't fire multiple refreshes — they all await the same
 * in-flight `refreshPromise`. Without this, a page with 5 widgets each making
 * an API call would issue 5 refreshes and invalidate each other's tokens.
 */
let refreshPromise: Promise<string | null> | null = null;

async function tryRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  const rt = tokenStore.getRefresh();
  if (!rt) return null;
  refreshPromise = (async () => {
    try {
      const res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) {
        // Refresh token itself is bad — wipe local auth so the user is sent to login.
        tokenStore.clear();
        return null;
      }
      const data = await res.json();
      tokenStore.set(data.accessToken);
      return data.accessToken as string;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const fire = async (token: string | null) => {
    // Only set Content-Type when we're actually sending a JSON body. Fastify's
    // default JSON parser rejects requests where Content-Type is application/json
    // but the body is empty (FST_ERR_CTP_EMPTY_JSON_BODY) — which broke DELETE
    // calls that have no body. Omitting the header on body-less requests keeps
    // GET / DELETE clean while still letting POST / PATCH / PUT send JSON.
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

  let res = await fire(tokenStore.get());

  // 401 — try a silent refresh once and replay. Skip on the auth endpoints
  // themselves so a failing login doesn't loop.
  if (res.status === 401 && tokenStore.getRefresh() && !path.startsWith("/auth/")) {
    const fresh = await tryRefresh();
    if (fresh) {
      res = await fire(fresh);
    }
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

/**
 * Upload a file via multipart/form-data with the same auth/refresh semantics as `api()`.
 * Used by the menu-import flow in the Products screen.
 *
 * `extraFields` lets the caller attach simple string form fields next to the file
 * (e.g. { mode: "preview" }) without needing FormData boilerplate at the call site.
 */
export async function apiUploadFile<T = any>(
  path: string,
  file: File,
  extraFields: Record<string, string> = {},
): Promise<T> {
  const fire = async (token: string | null) => {
    const form = new FormData();
    form.append("file", file, file.name);
    for (const [k, v] of Object.entries(extraFields)) form.append(k, v);
    // NB: do NOT set Content-Type here — the browser will set it to multipart/form-data
    // with the correct boundary automatically. Setting it manually breaks the upload.
    return fetch(`/api/v1${path}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
  };

  let res = await fire(tokenStore.get());
  if (res.status === 401 && tokenStore.getRefresh()) {
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
