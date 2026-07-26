-- CreateTable
CREATE TABLE "LedgerNameSuggestion" (
    "id" BIGSERIAL NOT NULL,
    "branchId" BIGINT NOT NULL,
    "ledgerAccountId" BIGINT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerNameSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerNameSuggestion_ledgerAccountId_field_idx" ON "LedgerNameSuggestion"("ledgerAccountId", "field");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerNameSuggestion_ledgerAccountId_field_value_key" ON "LedgerNameSuggestion"("ledgerAccountId", "field", "value");

-- AddForeignKey
ALTER TABLE "LedgerNameSuggestion" ADD CONSTRAINT "LedgerNameSuggestion_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerNameSuggestion" ADD CONSTRAINT "LedgerNameSuggestion_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
