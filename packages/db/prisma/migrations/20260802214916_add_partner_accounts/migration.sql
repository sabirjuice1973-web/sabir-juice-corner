-- CreateEnum
CREATE TYPE "PartnerEntryType" AS ENUM ('GAVE_TO_SHOP', 'TOOK_FROM_SHOP', 'RECEIVED_ONLINE');

-- CreateTable
CREATE TABLE "PartnerAccount" (
    "id" BIGSERIAL NOT NULL,
    "branchId" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerAccountEntry" (
    "id" BIGSERIAL NOT NULL,
    "branchId" BIGINT NOT NULL,
    "partnerAccountId" BIGINT NOT NULL,
    "entryDate" DATE NOT NULL,
    "type" "PartnerEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdById" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerAccountEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartnerAccount_branchId_idx" ON "PartnerAccount"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAccount_branchId_position_key" ON "PartnerAccount"("branchId", "position");

-- CreateIndex
CREATE INDEX "PartnerAccountEntry_branchId_entryDate_idx" ON "PartnerAccountEntry"("branchId", "entryDate");

-- CreateIndex
CREATE INDEX "PartnerAccountEntry_partnerAccountId_entryDate_idx" ON "PartnerAccountEntry"("partnerAccountId", "entryDate");

-- AddForeignKey
ALTER TABLE "PartnerAccount" ADD CONSTRAINT "PartnerAccount_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerAccountEntry" ADD CONSTRAINT "PartnerAccountEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerAccountEntry" ADD CONSTRAINT "PartnerAccountEntry_partnerAccountId_fkey" FOREIGN KEY ("partnerAccountId") REFERENCES "PartnerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerAccountEntry" ADD CONSTRAINT "PartnerAccountEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
