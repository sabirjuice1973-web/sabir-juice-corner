-- CreateTable
CREATE TABLE "PartnerAccountDayNote" (
    "id" BIGSERIAL NOT NULL,
    "partnerAccountId" BIGINT NOT NULL,
    "noteDate" DATE NOT NULL,
    "note" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerAccountDayNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAccountDayNote_partnerAccountId_noteDate_key" ON "PartnerAccountDayNote"("partnerAccountId", "noteDate");

-- AddForeignKey
ALTER TABLE "PartnerAccountDayNote" ADD CONSTRAINT "PartnerAccountDayNote_partnerAccountId_fkey" FOREIGN KEY ("partnerAccountId") REFERENCES "PartnerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
