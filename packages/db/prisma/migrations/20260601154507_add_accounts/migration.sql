-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('FOODPANDA', 'MARKET', 'CUSTOMER');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "accountId" BIGINT;

-- CreateTable
CREATE TABLE "Account" (
    "id" BIGSERIAL NOT NULL,
    "branchId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountPayment" (
    "id" BIGSERIAL NOT NULL,
    "accountId" BIGINT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "businessDate" DATE NOT NULL,
    "notes" TEXT,
    "recordedById" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountPaymentOrderLink" (
    "id" BIGSERIAL NOT NULL,
    "paymentId" BIGINT NOT NULL,
    "orderId" BIGINT NOT NULL,
    "appliedAmount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "AccountPaymentOrderLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Account_branchId_type_isActive_idx" ON "Account"("branchId", "type", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Account_branchId_name_type_key" ON "Account"("branchId", "name", "type");

-- CreateIndex
CREATE INDEX "AccountPayment_accountId_paidAt_idx" ON "AccountPayment"("accountId", "paidAt");

-- CreateIndex
CREATE INDEX "AccountPaymentOrderLink_orderId_idx" ON "AccountPaymentOrderLink"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountPaymentOrderLink_paymentId_orderId_key" ON "AccountPaymentOrderLink"("paymentId", "orderId");

-- CreateIndex
CREATE INDEX "Order_accountId_idx" ON "Order"("accountId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPayment" ADD CONSTRAINT "AccountPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPayment" ADD CONSTRAINT "AccountPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPaymentOrderLink" ADD CONSTRAINT "AccountPaymentOrderLink_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "AccountPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPaymentOrderLink" ADD CONSTRAINT "AccountPaymentOrderLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
