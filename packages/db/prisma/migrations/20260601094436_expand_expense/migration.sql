-- AlterTable
ALTER TABLE "Branch" ALTER COLUMN "currentBusinessDate" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "productName" TEXT,
ADD COLUMN     "quantity" DECIMAL(14,3),
ADD COLUMN     "rate" DECIMAL(12,2),
ADD COLUMN     "total" DECIMAL(12,2);
