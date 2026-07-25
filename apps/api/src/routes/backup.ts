import type { FastifyInstance } from "fastify";
import { prisma } from "@sjc/db";
import { requireAuth } from "../lib/guards.js";
import { toJson } from "../lib/serialize.js";

const BACKUP_VERSION = "2";

function b(v: any): bigint | null {
  if (v === null || v === undefined) return null;
  return BigInt(v);
}
function bd(v: any): bigint { return BigInt(v); }
function d(v: any): Date | null {
  if (v === null || v === undefined) return null;
  return new Date(v);
}
function dd(v: any): Date { return new Date(v); }

export async function registerBackupRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ── Export ───────────────────────────────────────────────────────────────
  app.get("/export", async (req, reply) => {
    if (!req.auth?.roles.some((r: any) => r.code === "OWNER")) {
      return reply.code(403).send({ error: "Owner only" });
    }

    const [
      branches, categories, expenseCategories,
      items, itemPrices,
      users, userRoles,
      accounts, accountPayments, accountPaymentLinks,
      shifts, orders, orderItems, payments, discountApplied,
      ledgerAccounts, ledgerEntries, expenses,
    ] = await Promise.all([
      prisma.branch.findMany({ orderBy: { id: "asc" } }),
      prisma.category.findMany({ orderBy: { id: "asc" } }),
      prisma.expenseCategory.findMany({ orderBy: { id: "asc" } }),
      prisma.item.findMany({ orderBy: { id: "asc" } }),
      prisma.itemPrice.findMany({ orderBy: { id: "asc" } }),
      prisma.user.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true, organizationId: true, fullName: true, username: true,
          email: true, phone: true, passwordHash: true, status: true,
          lastLoginAt: true, createdAt: true, updatedAt: true, deletedAt: true,
        },
      }),
      prisma.userRole.findMany({ orderBy: { id: "asc" } }),
      prisma.account.findMany({ orderBy: { id: "asc" } }),
      prisma.accountPayment.findMany({ orderBy: { id: "asc" } }),
      prisma.accountPaymentOrderLink.findMany({ orderBy: { id: "asc" } }),
      prisma.shift.findMany({ orderBy: { id: "asc" } }),
      prisma.order.findMany({ orderBy: { id: "asc" } }),
      prisma.orderItem.findMany({ orderBy: { id: "asc" } }),
      prisma.payment.findMany({ orderBy: { id: "asc" } }),
      prisma.discountApplied.findMany({ orderBy: { id: "asc" } }),
      prisma.ledgerAccount.findMany({ orderBy: { id: "asc" } }),
      prisma.ledgerEntry.findMany({ orderBy: { id: "asc" } }),
      prisma.expense.findMany({ orderBy: { id: "asc" } }),
    ]);

    const exportedAt = new Date().toISOString();
    const payload = toJson({
      version: BACKUP_VERSION,
      exportedAt,
      business: "Sabir Juice Corner",
      tables: {
        branches, categories, expenseCategories,
        items, itemPrices,
        users, userRoles,
        accounts, accountPayments, accountPaymentLinks,
        shifts, orders, orderItems, payments, discountApplied,
        ledgerAccounts, ledgerEntries, expenses,
      },
    });

    reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="sjc-backup-${exportedAt.slice(0, 10)}.json"`);
    return payload;
  });

  // ── Restore ──────────────────────────────────────────────────────────────
  // Accept up to 100 MB — a large backup can be 20-50 MB of JSON.
  app.post("/restore", { bodyLimit: 100 * 1024 * 1024 }, async (req, reply) => {
    if (!req.auth?.roles.some((r: any) => r.code === "OWNER")) {
      return reply.code(403).send({ error: "Owner only" });
    }

    const body = req.body as any;
    if (!body?.version || !body?.tables) {
      return reply.code(400).send({ error: "Invalid backup — missing version or tables" });
    }

    const t = body.tables;

    try {
      await prisma.$transaction(async (tx) => {
        // Wipe all business data. CASCADE handles FK ordering automatically.
        // Leaves intact: Organization, Role, Permission, Unit, RawMaterial, ProcessedProduct, AlertRule
        await tx.$executeRawUnsafe(
          `TRUNCATE TABLE "Branch","User","Category","ExpenseCategory" RESTART IDENTITY CASCADE`
        );

        // ── 1. Branches ──────────────────────────────────────────────────
        for (const r of (t.branches ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Branch"(id,"organizationId",code,name,address,city,phone,
             "isCentralKitchen",status,"openedAt","currentBusinessDate","createdAt","updatedAt","deletedAt")
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::"BranchStatus",$10,$11,$12,$13,$14)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.organizationId), r.code, r.name,
            r.address ?? null, r.city ?? null, r.phone ?? null,
            r.isCentralKitchen ?? false, r.status ?? "ACTIVE",
            d(r.openedAt), dd(r.currentBusinessDate),
            dd(r.createdAt), dd(r.updatedAt), d(r.deletedAt)
          );
        }

        // ── 2. ExpenseCategory ───────────────────────────────────────────
        for (const r of (t.expenseCategories ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "ExpenseCategory"(id,name,"isActive") VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
            bd(r.id), r.name, r.isActive ?? true
          );
        }

        // ── 3. Category (two-pass: insert flat, then set parentId) ───────
        for (const r of (t.categories ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Category"(id,name,"parentId","sortOrder","isActive","createdAt","updatedAt")
             VALUES($1,$2,NULL,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            bd(r.id), r.name, r.sortOrder ?? 0, r.isActive ?? true,
            dd(r.createdAt), dd(r.updatedAt)
          );
        }
        for (const r of (t.categories ?? [])) {
          if (r.parentId) {
            await tx.$executeRawUnsafe(
              `UPDATE "Category" SET "parentId"=$1 WHERE id=$2`,
              bd(r.parentId), bd(r.id)
            );
          }
        }

        // ── 4. Items (two-pass: insert without pairId, then set pairId) ──
        for (const r of (t.items ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Item"(id,"itemCode",name,"categoryId",size,"pairId","isActive","isSeasonal",
             "excludeFromAutoReconciliation","sortOrder","imageUrl","createdAt","updatedAt","deletedAt")
             VALUES($1,$2,$3,$4,$5::"ItemSize",NULL,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT DO NOTHING`,
            bd(r.id), r.itemCode, r.name, b(r.categoryId), r.size ?? "NA",
            r.isActive ?? true, r.isSeasonal ?? false,
            r.excludeFromAutoReconciliation ?? false, r.sortOrder ?? 0,
            r.imageUrl ?? null, dd(r.createdAt), dd(r.updatedAt), d(r.deletedAt)
          );
        }
        for (const r of (t.items ?? [])) {
          if (r.pairId) {
            await tx.$executeRawUnsafe(
              `UPDATE "Item" SET "pairId"=$1 WHERE id=$2`,
              bd(r.pairId), bd(r.id)
            );
          }
        }

        // ── 5. ItemPrices ────────────────────────────────────────────────
        for (const r of (t.itemPrices ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "ItemPrice"(id,"itemId","branchId",price,"effectiveFrom","effectiveTo","createdAt")
             VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.itemId), b(r.branchId), r.price,
            dd(r.effectiveFrom), d(r.effectiveTo), dd(r.createdAt)
          );
        }

        // ── 6. Users ──────────────────────────────────────────────────────
        for (const r of (t.users ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "User"(id,"organizationId","fullName",username,email,phone,"passwordHash",
             status,"lastLoginAt","createdAt","updatedAt","deletedAt")
             VALUES($1,$2,$3,$4,$5,$6,$7,$8::"UserStatus",$9,$10,$11,$12)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.organizationId), r.fullName, r.username,
            r.email ?? null, r.phone ?? null, r.passwordHash,
            r.status ?? "ACTIVE", d(r.lastLoginAt),
            dd(r.createdAt), dd(r.updatedAt), d(r.deletedAt)
          );
        }

        // ── 7. UserRoles ──────────────────────────────────────────────────
        for (const r of (t.userRoles ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "UserRole"(id,"userId","roleId","branchId","createdAt")
             VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.userId), bd(r.roleId), b(r.branchId), dd(r.createdAt)
          );
        }

        // ── 8. Accounts ───────────────────────────────────────────────────
        for (const r of (t.accounts ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Account"(id,"branchId",name,type,"isActive",phone,notes,"createdAt","updatedAt","deletedAt")
             VALUES($1,$2,$3,$4::"AccountType",$5,$6,$7,$8,$9,$10)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.branchId), r.name, r.type, r.isActive ?? true,
            r.phone ?? null, r.notes ?? null,
            dd(r.createdAt), dd(r.updatedAt), d(r.deletedAt)
          );
        }

        // ── 9. Shifts ─────────────────────────────────────────────────────
        for (const r of (t.shifts ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Shift"(id,"branchId","openedById","openedAt","businessDate","openingCash",
             "closedById","closedAt","closingCash","expectedCash","varianceCash",status,notes)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::"ShiftStatus",$13)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.branchId), bd(r.openedById),
            dd(r.openedAt), dd(r.businessDate), r.openingCash,
            b(r.closedById), d(r.closedAt),
            r.closingCash ?? null, r.expectedCash ?? null, r.varianceCash ?? null,
            r.status ?? "OPEN", r.notes ?? null
          );
        }

        // ── 10. Orders ────────────────────────────────────────────────────
        for (const r of (t.orders ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Order"(id,"orderNo","branchId","shiftId","waiterBox","waiterId",
             "orderType",status,subtotal,"discountAmount","taxAmount",total,"cashierId",
             "customerName","accountId","openedAt","closedAt","businessDate",
             "cancelReason","cancelledById","cancelledAt","createdAt","updatedAt")
             VALUES($1,$2,$3,$4,$5,$6,$7::"OrderType",$8::"OrderStatus",
             $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
             ON CONFLICT DO NOTHING`,
            bd(r.id), r.orderNo, bd(r.branchId), bd(r.shiftId),
            r.waiterBox ?? null, b(r.waiterId),
            r.orderType ?? "DINE_IN", r.status ?? "PAID",
            r.subtotal, r.discountAmount, r.taxAmount, r.total,
            bd(r.cashierId), r.customerName ?? null, b(r.accountId),
            dd(r.openedAt), d(r.closedAt), dd(r.businessDate),
            r.cancelReason ?? null, b(r.cancelledById), d(r.cancelledAt),
            dd(r.createdAt), dd(r.updatedAt)
          );
        }

        // ── 11. OrderItems ────────────────────────────────────────────────
        for (const r of (t.orderItems ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "OrderItem"(id,"orderId","itemId",qty,"unitPrice","lineTotal",
             "isCustomMix","customMixComponents",notes,"createdAt")
             VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.orderId), bd(r.itemId),
            r.qty, r.unitPrice, r.lineTotal, r.isCustomMix ?? false,
            r.customMixComponents != null ? JSON.stringify(r.customMixComponents) : null,
            r.notes ?? null, dd(r.createdAt)
          );
        }

        // ── 12. Payments ──────────────────────────────────────────────────
        for (const r of (t.payments ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Payment"(id,"orderId",method,amount,reference,"paidAt")
             VALUES($1,$2,$3::"PaymentMethod",$4,$5,$6)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.orderId), r.method,
            r.amount, r.reference ?? null, dd(r.paidAt)
          );
        }

        // ── 13. DiscountApplied ───────────────────────────────────────────
        for (const r of (t.discountApplied ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "DiscountApplied"(id,"orderId","discountType",amount,reason,"approvedById","appliedAt")
             VALUES($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.orderId), r.discountType,
            r.amount, r.reason ?? null, b(r.approvedById), dd(r.appliedAt)
          );
        }

        // ── 14. AccountPayments ───────────────────────────────────────────
        for (const r of (t.accountPayments ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "AccountPayment"(id,"accountId",amount,discount,method,reference,
             "paidAt","businessDate",notes,"recordedById","createdAt")
             VALUES($1,$2,$3,$4,$5::"PaymentMethod",$6,$7,$8,$9,$10,$11)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.accountId), r.amount, r.discount ?? 0, r.method,
            r.reference ?? null, dd(r.paidAt), dd(r.businessDate),
            r.notes ?? null, b(r.recordedById), dd(r.createdAt)
          );
        }

        // ── 15. AccountPaymentOrderLinks ──────────────────────────────────
        for (const r of (t.accountPaymentLinks ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "AccountPaymentOrderLink"(id,"paymentId","orderId","appliedAmount")
             VALUES($1,$2,$3,$4)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.paymentId), bd(r.orderId), r.appliedAmount
          );
        }

        // ── 16. LedgerAccounts ────────────────────────────────────────────
        for (const r of (t.ledgerAccounts ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "LedgerAccount"(id,"branchId",position,name,"createdAt","updatedAt")
             VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.branchId), r.position, r.name,
            dd(r.createdAt), dd(r.updatedAt)
          );
        }

        // ── 17. LedgerEntries ─────────────────────────────────────────────
        for (const r of (t.ledgerEntries ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "LedgerEntry"(id,"branchId","ledgerAccountId","entryDate","productName",
             quantity,rate,total,"headName","supplierName","cashPaid",description,"attachmentUrl","createdAt","updatedAt")
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.branchId), bd(r.ledgerAccountId),
            dd(r.entryDate), r.productName,
            r.quantity ?? null, r.rate ?? null, r.total,
            r.headName ?? null, r.supplierName ?? null, r.cashPaid,
            r.description ?? null, r.attachmentUrl ?? null,
            dd(r.createdAt), dd(r.updatedAt)
          );
        }

        // ── 18. Expenses ──────────────────────────────────────────────────
        for (const r of (t.expenses ?? [])) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Expense"(id,"branchId","categoryId",amount,"paidAt","businessDate",
             "paidById",vendor,notes,"attachmentUrl","productName",quantity,rate,total,"createdAt")
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT DO NOTHING`,
            bd(r.id), bd(r.branchId), bd(r.categoryId), r.amount,
            dd(r.paidAt), dd(r.businessDate), b(r.paidById),
            r.vendor ?? null, r.notes ?? null, r.attachmentUrl ?? null,
            r.productName ?? null, r.quantity ?? null, r.rate ?? null,
            r.total ?? null, dd(r.createdAt)
          );
        }

        // ── Reset all sequences so new inserts get IDs above the restored max ─
        const sequenceTables = [
          "Branch", "Category", "ExpenseCategory", "Item", "ItemPrice",
          "User", "UserRole", "Account", "Shift", "Order", "OrderItem",
          "Payment", "DiscountApplied", "AccountPayment", "AccountPaymentOrderLink",
          "LedgerAccount", "LedgerEntry", "Expense",
        ];
        for (const tbl of sequenceTables) {
          await tx.$executeRawUnsafe(
            `SELECT setval(pg_get_serial_sequence('"${tbl}"','id'),COALESCE((SELECT MAX(id) FROM "${tbl}"),0)+1,false)`
          );
        }

      }, { timeout: 600_000 }); // 10-minute window for large restores

      return { ok: true, message: "Database restored successfully" };
    } catch (err: any) {
      app.log.error({ err }, "Backup restore failed");
      return reply.code(500).send({ error: `Restore failed: ${err.message}` });
    }
  });
}
