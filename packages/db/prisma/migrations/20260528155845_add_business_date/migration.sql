-- Adds the "business date" mechanism: a manually-set business date per branch,
-- stamped on every Order/Shift/Expense/Transfer at creation time. Existing
-- rows are backfilled from their own timestamp column (date part only) so we
-- can apply the NOT NULL constraint without losing data.

-- 1) Branch.currentBusinessDate — non-null, default = today. Safe for existing rows.
ALTER TABLE "Branch" ADD COLUMN "currentBusinessDate" DATE NOT NULL DEFAULT CURRENT_DATE;

-- 2) Add businessDate columns as NULLABLE first, backfill, then enforce NOT NULL.

-- Order.businessDate ← date(openedAt)
ALTER TABLE "Order"    ADD COLUMN "businessDate" DATE;
UPDATE "Order"   SET "businessDate" = "openedAt"::date  WHERE "businessDate" IS NULL;
ALTER TABLE "Order"    ALTER COLUMN "businessDate" SET NOT NULL;

-- Shift.businessDate ← date(openedAt)
ALTER TABLE "Shift"    ADD COLUMN "businessDate" DATE;
UPDATE "Shift"   SET "businessDate" = "openedAt"::date  WHERE "businessDate" IS NULL;
ALTER TABLE "Shift"    ALTER COLUMN "businessDate" SET NOT NULL;

-- Expense.businessDate ← date(paidAt)
ALTER TABLE "Expense"  ADD COLUMN "businessDate" DATE;
UPDATE "Expense" SET "businessDate" = "paidAt"::date    WHERE "businessDate" IS NULL;
ALTER TABLE "Expense"  ALTER COLUMN "businessDate" SET NOT NULL;

-- Transfer.businessDate ← date(createdAt)  (transfers don't have a single canonical "event" column)
ALTER TABLE "Transfer" ADD COLUMN "businessDate" DATE;
UPDATE "Transfer" SET "businessDate" = "createdAt"::date WHERE "businessDate" IS NULL;
ALTER TABLE "Transfer" ALTER COLUMN "businessDate" SET NOT NULL;

-- 3) Indexes for report queries that filter by (branchId, businessDate).
CREATE INDEX "Expense_branchId_businessDate_idx" ON "Expense"("branchId", "businessDate");
CREATE INDEX "Order_branchId_businessDate_idx"   ON "Order"("branchId", "businessDate");
