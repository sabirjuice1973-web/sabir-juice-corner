-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "addOnLabel" TEXT,
ADD COLUMN     "isAddOn" BOOLEAN NOT NULL DEFAULT false;
