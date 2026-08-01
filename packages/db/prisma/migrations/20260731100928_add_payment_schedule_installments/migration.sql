-- CreateTable
CREATE TABLE "PaymentScheduleInstallment" (
    "id" BIGSERIAL NOT NULL,
    "scheduleEntryId" BIGINT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentScheduleInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentScheduleInstallment_scheduleEntryId_idx" ON "PaymentScheduleInstallment"("scheduleEntryId");

-- AddForeignKey
ALTER TABLE "PaymentScheduleInstallment" ADD CONSTRAINT "PaymentScheduleInstallment_scheduleEntryId_fkey" FOREIGN KEY ("scheduleEntryId") REFERENCES "PaymentScheduleEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
