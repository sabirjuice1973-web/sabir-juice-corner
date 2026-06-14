-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('DRAFT', 'PENDING_CLOSE', 'PENDING_REASONS', 'CLOSED');

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "excludeFromAutoReconciliation" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "YieldConfig" (
    "id" BIGSERIAL NOT NULL,
    "processedProductId" BIGINT NOT NULL,
    "branchId" BIGINT,
    "glassesPerShoper" DECIMAL(10,2) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "notes" TEXT,
    "createdById" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YieldConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemParticipation" (
    "id" BIGSERIAL NOT NULL,
    "itemId" BIGINT NOT NULL,
    "processedProductId" BIGINT NOT NULL,
    "participationPct" DECIMAL(8,4) NOT NULL,
    "isAutoSeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemParticipation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReconciliation" (
    "id" BIGSERIAL NOT NULL,
    "branchId" BIGINT NOT NULL,
    "businessDate" DATE NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'DRAFT',
    "openingConfirmedById" BIGINT,
    "openingConfirmedAt" TIMESTAMP(3),
    "openingOverrideNote" TEXT,
    "closedById" BIGINT,
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReconciliationLine" (
    "id" BIGSERIAL NOT NULL,
    "reconciliationId" BIGINT NOT NULL,
    "processedProductId" BIGINT NOT NULL,
    "openingQty" DECIMAL(14,3) NOT NULL,
    "openingFromPrevClose" DECIMAL(14,3),
    "transfersInQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "glassesPerShoperUsed" DECIMAL(10,2) NOT NULL,
    "expectedConsumptionMGE" DECIMAL(14,3),
    "expectedConsumptionShopers" DECIMAL(14,3),
    "expectedCloseQty" DECIMAL(14,3),
    "closingQty" DECIMAL(14,3),
    "varianceQty" DECIMAL(14,3),
    "variancePct" DECIMAL(8,2),
    "reasonCode" TEXT,
    "reasonNotes" TEXT,
    "reasonRecordedById" BIGINT,
    "reasonRecordedAt" TIMESTAMP(3),

    CONSTRAINT "StockReconciliationLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "YieldConfig_processedProductId_branchId_effectiveFrom_idx" ON "YieldConfig"("processedProductId", "branchId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ItemParticipation_processedProductId_idx" ON "ItemParticipation"("processedProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemParticipation_itemId_processedProductId_key" ON "ItemParticipation"("itemId", "processedProductId");

-- CreateIndex
CREATE INDEX "StockReconciliation_branchId_status_idx" ON "StockReconciliation"("branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockReconciliation_branchId_businessDate_key" ON "StockReconciliation"("branchId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "StockReconciliationLine_reconciliationId_processedProductId_key" ON "StockReconciliationLine"("reconciliationId", "processedProductId");

-- AddForeignKey
ALTER TABLE "YieldConfig" ADD CONSTRAINT "YieldConfig_processedProductId_fkey" FOREIGN KEY ("processedProductId") REFERENCES "ProcessedProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YieldConfig" ADD CONSTRAINT "YieldConfig_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YieldConfig" ADD CONSTRAINT "YieldConfig_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemParticipation" ADD CONSTRAINT "ItemParticipation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemParticipation" ADD CONSTRAINT "ItemParticipation_processedProductId_fkey" FOREIGN KEY ("processedProductId") REFERENCES "ProcessedProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReconciliation" ADD CONSTRAINT "StockReconciliation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReconciliation" ADD CONSTRAINT "StockReconciliation_openingConfirmedById_fkey" FOREIGN KEY ("openingConfirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReconciliation" ADD CONSTRAINT "StockReconciliation_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReconciliationLine" ADD CONSTRAINT "StockReconciliationLine_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "StockReconciliation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReconciliationLine" ADD CONSTRAINT "StockReconciliationLine_processedProductId_fkey" FOREIGN KEY ("processedProductId") REFERENCES "ProcessedProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReconciliationLine" ADD CONSTRAINT "StockReconciliationLine_reasonRecordedById_fkey" FOREIGN KEY ("reasonRecordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
