-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" BIGSERIAL NOT NULL,
    "branchId" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" BIGSERIAL NOT NULL,
    "branchId" BIGINT NOT NULL,
    "ledgerAccountId" BIGINT NOT NULL,
    "entryDate" DATE NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" DECIMAL(14,3),
    "rate" DECIMAL(12,2),
    "total" DECIMAL(12,2) NOT NULL,
    "headName" TEXT,
    "supplierName" TEXT,
    "cashPaid" DECIMAL(12,2) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerAccount_branchId_idx" ON "LedgerAccount"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_branchId_position_key" ON "LedgerAccount"("branchId", "position");

-- CreateIndex
CREATE INDEX "LedgerEntry_branchId_entryDate_idx" ON "LedgerEntry"("branchId", "entryDate");

-- CreateIndex
CREATE INDEX "LedgerEntry_ledgerAccountId_entryDate_idx" ON "LedgerEntry"("ledgerAccountId", "entryDate");

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
