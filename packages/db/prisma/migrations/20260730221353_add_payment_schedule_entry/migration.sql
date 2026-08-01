-- CreateTable
CREATE TABLE "PaymentScheduleEntry" (
    "id" BIGSERIAL NOT NULL,
    "branchId" BIGINT NOT NULL,
    "entryDate" DATE NOT NULL,
    "details" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "recurrence" TEXT,
    "createdById" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentScheduleEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentScheduleEntry_branchId_entryDate_idx" ON "PaymentScheduleEntry"("branchId", "entryDate");

-- AddForeignKey
ALTER TABLE "PaymentScheduleEntry" ADD CONSTRAINT "PaymentScheduleEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentScheduleEntry" ADD CONSTRAINT "PaymentScheduleEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
