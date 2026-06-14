// Phase 3 smoke test: variance report, P&L, item profitability, anomaly engine.
// Builds on Phase 2's setup (procurement → production → transfer → sale).

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
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
let n = 0;
const step = (label, status, summary) => {
  n++;
  const ok = status >= 200 && status < 300;
  console.log(`${ok ? "✓" : "✗"} [${String(status).padStart(3)}] step ${String(n).padStart(2)} — ${label}${summary ? "  " + summary : ""}`);
};
const expect = (cond, msg) => { if (!cond) { console.error("   ASSERT FAILED:", msg); process.exitCode = 1; } };

const today = new Date().toISOString().slice(0, 10);
const last7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

(async () => {
  // ─── Login & assume Phase 2 data is already there ─────────────────────
  const login = await req("POST", "/auth/login", { username: "admin", password: "ChangeMe!2026" }, { noAuth: true });
  step("login", login.status);
  TOKEN = login.body.accessToken;

  // ─── 1. Variance report for B1 (branchId=2) covering the window ──────
  const variance = await req("GET", `/reports/variance?branchId=2&from=${last7}&to=${today}`);
  step("variance report for Branch 1", variance.status, `${variance.body?.rows?.length ?? 0} row(s)`);
  if (variance.body?.rows?.length) {
    const peachPulp = variance.body.rows.find((r) => r.name === "Peach Pulp");
    if (peachPulp) {
      console.log(`     • ${peachPulp.name}: in=${peachPulp.totalIn}, sales=${peachPulp.salesOut}, current=${peachPulp.currentLevel}, variance=${peachPulp.variance} (${peachPulp.variancePct}%)`);
      console.log(`       expected ${peachPulp.expectedGlasses} glasses, sold ${peachPulp.glassesSold}, glass-variance ${peachPulp.glassesVariance}`);
      // After phase 2: in=4, sales=0.996, current=3.004, so variance = (4 - 0.996 - 0) - 3.004 = 0
      expect(Number(peachPulp.variance) >= -0.01 && Number(peachPulp.variance) <= 0.01, `expected ~0 variance, got ${peachPulp.variance}`);
    }
  }

  // ─── 2. Branch P&L for B1 ──────────────────────────────────────────
  const pnl = await req("GET", `/reports/pnl?branchId=2&from=${last7}&to=${today}`);
  step("branch P&L for Branch 1", pnl.status,
       `orders=${pnl.body?.orderCount}, sales=${pnl.body?.sales}, cogs=${pnl.body?.cogs}, net=${pnl.body?.net} (${pnl.body?.netMarginPct}%)`);
  expect(Number(pnl.body?.sales) > 0, `expected sales > 0, got ${pnl.body?.sales}`);
  expect(Number(pnl.body?.cogs) > 0, `expected cogs > 0 (Peach Medium has a recipe with cost), got ${pnl.body?.cogs}`);

  // ─── 3. Item profitability (across all branches) ─────────────────────
  const prof = await req("GET", `/reports/item-profitability?from=${last7}&to=${today}`);
  step("item profitability", prof.status, `${prof.body?.rows?.length ?? 0} item(s)`);
  if (prof.body?.rows?.length) {
    const peach = prof.body.rows.find((r) => r.name?.includes("Peach"));
    if (peach) {
      console.log(`     • ${peach.name}: sold ${peach.qtySold}, revenue ${peach.revenue}, cogs ${peach.cogsTotal}, profit ${peach.profit} (${peach.marginPct}%)`);
      expect(Number(peach.profit) > 0, "Peach Medium should be profitable");
    }
  }

  // ─── 4. Run anomaly engine ───────────────────────────────────────────
  const scan = await req("POST", "/reports/anomalies/scan", { windowDays: 7 });
  step("run anomaly scan", scan.status, `created=${scan.body?.created}, totalSignals=${scan.body?.total}`);

  // ─── 5. List open alerts ─────────────────────────────────────────────
  const alerts = await req("GET", "/alerts");
  step("list open alerts", alerts.status, `count=${alerts.body?.alerts?.length}`);
  for (const a of alerts.body?.alerts ?? []) {
    console.log(`     • [${a.severity}] ${a.rule.code}: ${a.message}`);
  }

  // ─── 6. Alert summary ────────────────────────────────────────────────
  const sum = await req("GET", "/alerts/summary?days=7");
  step("alert summary", sum.status, `open=${JSON.stringify(sum.body?.open)}`);

  // ─── 7. Re-run scan should be idempotent (no duplicates) ────────────
  const scan2 = await req("POST", "/reports/anomalies/scan", { windowDays: 7 });
  step("re-run scan (idempotent)", scan2.status, `created=${scan2.body?.created} (should be 0)`);
  expect(scan2.body?.created === 0, `expected 0 duplicate creations, got ${scan2.body?.created}`);

  // ─── 8. Acknowledge the first open alert if any ──────────────────────
  if (alerts.body?.alerts?.length) {
    const id = alerts.body.alerts[0].id;
    const ack = await req("POST", `/alerts/${id}/acknowledge`);
    step("acknowledge an alert", ack.status, `id=${id}`);
    const ack2 = await req("POST", `/alerts/${id}/acknowledge`);
    step("re-acknowledge should 409", ack2.status);
    expect(ack2.status === 409, `expected 409, got ${ack2.status}`);
  }

  console.log(process.exitCode ? "\nSOME ASSERTIONS FAILED" : "\nAll Phase 3 assertions passed ✓");
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
