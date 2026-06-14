// End-to-end smoke test for Phase 2.
// Exercises the full procurement → production → transfer → sale → stock-deduction loop.
//
// Pre-req: fresh DB (pnpm db:reset --force && pnpm db:seed) and API running on :4000.

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

let stepCount = 0;
function step(label, status, summary) {
  stepCount++;
  const ok = status >= 200 && status < 300;
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} [${String(status).padStart(3)}] step ${String(stepCount).padStart(2)} — ${label}${summary ? "  " + summary : ""}`);
  return ok;
}
const expect = (cond, msg) => {
  if (!cond) { console.error("   ASSERT FAILED:", msg); process.exitCode = 1; }
};

const CK_BRANCH = 1;     // Central Kitchen, seeded
const CK_STORE_LOC = 1;  // central store, seeded
const CK_FREEZER_LOC = 2; // central freezer, seeded
const POS_BRANCH = 2;    // Branch 1 (B1)

(async () => {
  // ─── Login ────────────────────────────────────────────────────────────
  const login = await req("POST", "/auth/login", { username: "admin", password: "ChangeMe!2026" }, { noAuth: true });
  step("login", login.status, `user=${login.body?.user?.username}`);
  TOKEN = login.body.accessToken;

  // ─── 1. Set up the catalog: raw material + processed product ─────────
  const peach = await req("POST", "/raw-materials", { name: "Peach", category: "FRUIT", defaultUnitCode: "kg", reorderLevel: 20 });
  step("create raw material 'Peach'", peach.status, `id=${peach.body?.rawMaterial?.id}`);
  const peachId = peach.body?.rawMaterial?.id;

  const sugar = await req("POST", "/raw-materials", { name: "Sugar", category: "SUGAR", defaultUnitCode: "kg" });
  step("create raw material 'Sugar'", sugar.status);
  const sugarId = sugar.body?.rawMaterial?.id;

  const peachPulp = await req("POST", "/catalog/processed", { name: "Peach Pulp", storageUnit: "shoper", defaultGlassesPerUnit: 12 });
  step("create processed product 'Peach Pulp'", peachPulp.status, `id=${peachPulp.body?.processedProduct?.id}`);
  const peachPulpId = peachPulp.body?.processedProduct?.id;

  // ─── 2. Set up a stock location at the sales branch ──────────────────
  // Branch 1 (B1) was seeded with no locations. Create a counter.
  const counterLoc = await req("POST", "/stock/locations", { branchId: POS_BRANCH, name: "B1 Counter", type: "COUNTER" });
  step("create branch counter location", counterLoc.status, `id=${counterLoc.body?.location?.id}`);
  const counterLocId = counterLoc.body?.location?.id;

  // ─── 3. Add a supplier and a purchase order ──────────────────────────
  const sup = await req("POST", "/suppliers", { name: "Multan Fruit Mandi", phone: "0300-1234567", paymentTermsDays: 15 });
  step("create supplier", sup.status, `id=${sup.body?.supplier?.id}`);
  const supId = sup.body?.supplier?.id;

  const po = await req("POST", "/purchases/orders", {
    supplierId: Number(supId),
    branchId: CK_BRANCH,
    items: [
      { rawMaterialId: Number(peachId), qty: 100, unitCode: "kg", rate: 350 },   // 35,000
      { rawMaterialId: Number(sugarId), qty: 10,  unitCode: "kg", rate: 280 },   //  2,800
    ],
  });
  step("create PO (100 kg peach + 10 kg sugar)", po.status, `poNo=${po.body?.order?.poNo}, total=${po.body?.order?.total}`);
  expect(po.body?.order?.total === "37800", `expected 37800, got ${po.body?.order?.total}`);
  const poId = po.body?.order?.id;

  // ─── 4. Receive partial (60 kg peach, 10 kg sugar) → PARTIALLY_RECEIVED ─
  const grn1 = await req("POST", "/purchases/grn", {
    poId: Number(poId),
    branchId: CK_BRANCH,
    locationId: CK_STORE_LOC,
    items: [
      { rawMaterialId: Number(peachId), qtyReceived: 60, unitCode: "kg", rate: 350 },
      { rawMaterialId: Number(sugarId), qtyReceived: 10, unitCode: "kg", rate: 280 },
    ],
  });
  step("receive partial GRN", grn1.status, `grnNo=${grn1.body?.grnNo}`);

  // Verify the PO is now PARTIALLY_RECEIVED
  const poAfter = await req("GET", `/purchases/orders/${poId}`);
  step("PO status after partial receipt", poAfter.status, `status=${poAfter.body?.order?.status}`);
  expect(poAfter.body?.order?.status === "PARTIALLY_RECEIVED", `expected PARTIALLY_RECEIVED, got ${poAfter.body?.order?.status}`);

  // ─── 5. Receive the remaining 40 kg peach → RECEIVED ─────────────────
  const grn2 = await req("POST", "/purchases/grn", {
    poId: Number(poId),
    branchId: CK_BRANCH,
    locationId: CK_STORE_LOC,
    items: [{ rawMaterialId: Number(peachId), qtyReceived: 40, unitCode: "kg", rate: 350 }],
  });
  step("receive final GRN (40 kg peach)", grn2.status);

  const poFinal = await req("GET", `/purchases/orders/${poId}`);
  expect(poFinal.body?.order?.status === "RECEIVED", `expected RECEIVED, got ${poFinal.body?.order?.status}`);

  // ─── 6. Inspect central store stock — should be 100 kg peach + 10 kg sugar ──
  const levelsCK = await req("GET", `/stock/levels?locationId=${CK_STORE_LOC}`);
  const peachLevel = levelsCK.body?.levels?.find((l) => l.name === "Peach");
  step("central store has 100 kg peach", levelsCK.status, `qty=${peachLevel?.quantity} ${peachLevel?.unit}`);
  expect(peachLevel?.quantity === "100", `expected 100 kg peach, got ${peachLevel?.quantity}`);

  // ─── 7. Pay the supplier 20,000 (partial) ────────────────────────────
  const pay = await req("POST", `/suppliers/${supId}/pay`, { amount: 20000, method: "CASH" });
  step("pay supplier PKR 20,000", pay.status);

  const ledger = await req("GET", `/suppliers/${supId}/ledger`);
  step("ledger reflects payment", ledger.status, `balance=${ledger.body?.balance}`);
  expect(ledger.body?.balance === "17800", `expected balance 17800 (37800 - 20000), got ${ledger.body?.balance}`);

  // ─── 8. Production batch: 50 kg peach + 2 kg sugar → 6 shopers of pulp ──
  const batch = await req("POST", "/production/batches", {
    branchId: CK_BRANCH,
    sourceLocationId: CK_STORE_LOC,
    destinationLocationId: CK_FREEZER_LOC,
    inputs: [
      { rawMaterialId: Number(peachId), quantity: 50, unitCode: "kg", costAtIntake: 350 },
      { rawMaterialId: Number(sugarId), quantity: 2,  unitCode: "kg", costAtIntake: 280 },
    ],
    outputs: [
      { processedProductId: Number(peachPulpId), outputQty: 6, outputUnitCode: "shoper" },
    ],
    wastages: [{ quantity: 5, unitCode: "kg", reason: "Peel and pit" }],
    notes: "Daily peach pulp run",
  });
  step("complete production batch", batch.status, `batchNo=${batch.body?.batch?.batchNo}`);
  expect(batch.body?.batch?.outputs?.length === 1);

  // ─── 9. Verify stock effects ─────────────────────────────────────────
  const levelsAfter = await req("GET", `/stock/levels?branchId=${CK_BRANCH}`);
  const peachLevelAfter = levelsAfter.body?.levels?.find((l) => l.name === "Peach");
  const pulpLevel = levelsAfter.body?.levels?.find((l) => l.name === "Peach Pulp");
  step("peach reduced by batch consume",  200, `peach=${peachLevelAfter?.quantity}, pulp=${pulpLevel?.quantity} (${pulpLevel?.expectedGlasses} expected glasses)`);
  expect(peachLevelAfter?.quantity === "50", `expected 50 kg peach after consume, got ${peachLevelAfter?.quantity}`);
  expect(pulpLevel?.quantity === "6", `expected 6 shopers pulp, got ${pulpLevel?.quantity}`);

  // ─── 10. Transfer 4 shopers of pulp from CK freezer → B1 counter ─────
  const transfer = await req("POST", "/transfers/dispatch", {
    fromBranchId: CK_BRANCH,
    toBranchId: POS_BRANCH,
    fromLocationId: CK_FREEZER_LOC,
    toLocationId: Number(counterLocId),
    items: [
      { stockableType: "PROCESSED_PRODUCT", stockableId: Number(peachPulpId), qty: 4, unitCode: "shoper" },
    ],
    notes: "Daily dispatch to B1",
  });
  step("dispatch transfer 4 shopers", transfer.status, `transferNo=${transfer.body?.transfer?.transferNo}, status=${transfer.body?.transfer?.status}`);
  const transferId = transfer.body?.transfer?.id;
  const transferItemId = transfer.body?.transfer?.items?.[0]?.id;

  // ─── 11. Branch confirms 4/4 received → RECEIVED ─────────────────────
  const recv = await req("POST", `/transfers/${transferId}/receive`, {
    items: [{ transferItemId: Number(transferItemId), qtyReceived: 4 }],
  });
  step("receive transfer", recv.status, `status=${recv.body?.transfer?.status}`);
  expect(recv.body?.transfer?.status === "RECEIVED");

  // Confirm B1 counter has 4 shopers
  const levelsB1 = await req("GET", `/stock/levels?branchId=${POS_BRANCH}`);
  const pulpAtB1 = levelsB1.body?.levels?.find((l) => l.name === "Peach Pulp");
  step("B1 counter has 4 shopers pulp", 200, `qty=${pulpAtB1?.quantity}`);
  expect(pulpAtB1?.quantity === "4", `expected 4 shopers at B1, got ${pulpAtB1?.quantity}`);

  // ─── 12. Create a recipe: Peach Medium (item code 7) uses 0.083 shoper pulp (1/12) ──
  // First look up item id for code 7
  const peachItem = await req("GET", "/items/by-code/7");
  step("look up item code 7 (Peach Medium)", peachItem.status, `id=${peachItem.body?.id}, name=${peachItem.body?.name}`);
  const peachItemId = peachItem.body?.id;

  const recipe = await req("POST", "/catalog/recipes", {
    itemId: Number(peachItemId),
    yieldQty: 1,
    ingredients: [
      { ingredientType: "PROCESSED_PRODUCT", processedProductId: Number(peachPulpId), quantity: 0.083, unitCode: "shoper" },
    ],
  });
  step("create recipe for Peach Medium", recipe.status, `version=${recipe.body?.recipe?.version}`);

  // ─── 13. Open shift at B1, create order, sell 12× Peach Medium, pay ──
  const shift = await req("POST", "/shifts/open", { branchId: POS_BRANCH, openingCash: 1000 });
  step("open B1 shift", shift.status);
  const shiftId = shift.body?.shift?.id;

  const order = await req("POST", "/orders", { branchId: POS_BRANCH, shiftId: Number(shiftId), waiterBox: 1 });
  step("create order at B1", order.status);
  const orderId = order.body?.order?.id;

  // 12 medium peach juices = 12 × 0.083 ≈ 0.996 shopers consumed
  const addItem = await req("POST", `/orders/${orderId}/items`, { itemCode: 7, qty: 12 });
  step("add 12× Peach Medium", addItem.status, `total=${addItem.body?.order?.total}`);

  const payOrder = await req("POST", `/orders/${orderId}/pay`, { method: "CASH", amount: 4000 });
  step("pay order", payOrder.status, `status=${payOrder.body?.order?.status}, deductions=${payOrder.body?.deductions?.length}`);
  expect(payOrder.body?.order?.status === "PAID");
  expect(payOrder.body?.deductions?.length === 1, `expected 1 deduction event, got ${payOrder.body?.deductions?.length}`);
  console.log(`     deducted: ${payOrder.body?.deductions?.[0]?.deducted} ${payOrder.body?.deductions?.[0]?.unit} of ${payOrder.body?.deductions?.[0]?.ingredient}`);

  // ─── 14. Verify B1 counter pulp dropped by ~1 shoper ─────────────────
  const levelsB1After = await req("GET", `/stock/levels?branchId=${POS_BRANCH}`);
  const pulpAfterSale = levelsB1After.body?.levels?.find((l) => l.name === "Peach Pulp");
  step("B1 counter pulp after sale", 200, `qty=${pulpAfterSale?.quantity}`);
  // 4 − (12 × 0.083) = 4 − 0.996 = 3.004
  const remaining = Number(pulpAfterSale?.quantity);
  expect(remaining > 3.0 && remaining < 3.01, `expected ~3.004 shopers, got ${pulpAfterSale?.quantity}`);

  console.log(process.exitCode ? "\nSOME ASSERTIONS FAILED" : "\nAll Phase 2 assertions passed ✓");
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
