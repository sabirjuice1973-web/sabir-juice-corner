// End-to-end smoke test for Phase 1A.
// Run after `pnpm db:seed` and `pnpm --filter @sjc/api dev`.

const BASE = "http://localhost:4000/api/v1";
let TOKEN = "";

async function req(method, path, body, opts = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN && !opts.noAuth ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

function step(label, status, summary) {
  const ok = status >= 200 && status < 300;
  console.log(`${ok ? "✓" : "✗"} [${status}] ${label} — ${summary}`);
  return ok;
}

const expect = (cond, msg) => {
  if (!cond) { console.error("  ASSERT FAILED:", msg); process.exitCode = 1; }
};

(async () => {
  // 1 — login
  const login = await req("POST", "/auth/login", { username: "admin", password: "ChangeMe!2026" }, { noAuth: true });
  step("login as admin", login.status, `user=${login.body?.user?.username}, roles=${login.body?.user?.roles?.map(r=>r.code).join(",")}, token=${login.body?.accessToken?.slice(0,24)}…`);
  expect(login.status === 200 && login.body?.accessToken, "no access token returned");
  TOKEN = login.body.accessToken;

  // 2 — me
  const me = await req("GET", "/auth/me");
  step("GET /auth/me", me.status, `username=${me.body?.user?.username}`);

  // 3 — open shift
  const open = await req("POST", "/shifts/open", { branchId: 1, openingCash: 2000 });
  step("open shift at branch 1", open.status, `shiftId=${open.body?.shift?.id}, opening=${open.body?.shift?.openingCash}`);
  expect(open.status === 200, "shift open failed");
  const shiftId = open.body?.shift?.id;

  // 4 — create order
  const create = await req("POST", "/orders", { branchId: 1, shiftId: Number(shiftId), waiterBox: 3 });
  step("create order on box 3", create.status, `orderNo=${create.body?.order?.orderNo}`);
  const orderId = create.body?.order?.id;

  // 5 — add items
  const add1 = await req("POST", `/orders/${orderId}/items`, { itemCode: 1, qty: 2 });
  step("add Apple Medium ×2", add1.status, `subtotal=${add1.body?.order?.subtotal}`);

  const add2 = await req("POST", `/orders/${orderId}/items`, { itemCode: 46, qty: 1 });
  step("add Mango Shake Jumbo ×1", add2.status, `subtotal=${add2.body?.order?.subtotal}, total=${add2.body?.order?.total}`);
  expect(add2.body?.order?.total === "1020", `expected total 1020, got ${add2.body?.order?.total}`);
  for (const li of add2.body?.order?.items ?? []) {
    console.log(`    · ${li.item.name} ${li.item.size} × ${li.qty} @ ${li.unitPrice} = ${li.lineTotal}`);
  }

  // 6 — 5% discount, should succeed
  const disc = await req("POST", `/orders/${orderId}/discount`, { discountType: "PERCENT", value: 5, reason: "loyal customer" });
  step("apply 5% discount", disc.status, `discount=${disc.body?.order?.discountAmount}, new total=${disc.body?.order?.total}`);
  expect(disc.body?.order?.total === "969", `expected 969 after 5% off 1020, got ${disc.body?.order?.total}`);

  // 7 — pay cash overpay (change due)
  const pay = await req("POST", `/orders/${orderId}/pay`, { method: "CASH", amount: 1500 });
  step("pay cash 1500", pay.status, `status=${pay.body?.order?.status}, change=${pay.body?.change}`);
  expect(pay.body?.order?.status === "PAID", "order should be PAID");
  expect(pay.body?.change === "531", `expected change 531, got ${pay.body?.change}`);

  // 8 — duplicate shift open should 409
  const dup = await req("POST", "/shifts/open", { branchId: 1, openingCash: 1000 });
  step("duplicate shift open should fail", dup.status, `error=${dup.body?.error}`);
  expect(dup.status === 409, `expected 409, got ${dup.status}`);

  // 9 — close shift
  const close = await req("POST", `/shifts/${shiftId}/close`, { closingCash: 2969 }); // 2000 opening + 969 cash sales
  step("close shift", close.status, `expected=${close.body?.summary?.expected}, counted=${close.body?.summary?.counted}, variance=${close.body?.summary?.variance}`);
  expect(close.body?.summary?.variance === "0", `expected zero variance, got ${close.body?.summary?.variance}`);

  // 10 — bad creds
  const badLogin = await req("POST", "/auth/login", { username: "admin", password: "wrong" }, { noAuth: true });
  step("bad creds should 401", badLogin.status, `error=${badLogin.body?.error}`);
  expect(badLogin.status === 401, `expected 401, got ${badLogin.status}`);

  // 11 — protected route without token
  TOKEN = "";
  const noAuth = await req("GET", "/auth/me");
  step("no token should 401", noAuth.status, `error=${noAuth.body?.error}`);
  expect(noAuth.status === 401, "expected 401");

  console.log(process.exitCode ? "\nSOME ASSERTIONS FAILED" : "\nAll assertions passed ✓");
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
