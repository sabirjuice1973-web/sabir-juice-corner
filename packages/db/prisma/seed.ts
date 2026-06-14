/**
 * Seed script — primes the DB with reference data the app cannot run without:
 *   • Organization (Sabir Juice Corner)
 *   • Roles & permissions
 *   • Units & unit conversions
 *   • Categories
 *   • Menu items (from data/menu.json — owner-supplied draft)
 *   • Default branches (central kitchen + 3 outlets) — adjust names as you confirm
 *   • One admin user so you can log in
 *
 * Re-runnable: uses upserts on natural keys. Safe to run after schema changes.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcrypt";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

// ─── Helpers ────────────────────────────────────────────────────────────────

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

// ─── Roles & Permissions ────────────────────────────────────────────────────

const ROLES = [
  { code: "OWNER",          name: "Owner / Admin",   description: "Full access to everything" },
  { code: "BRANCH_MANAGER", name: "Branch Manager",  description: "Runs a single branch" },
  { code: "CASHIER",        name: "Cashier",         description: "Punches orders, takes payment" },
  { code: "STORE_MGR",      name: "Store Manager",   description: "Central kitchen, raw inventory, transfers" },
  { code: "PRODUCTION",     name: "Production Staff",description: "Records batches, yields, wastage" },
  { code: "ACCOUNTANT",     name: "Accountant",      description: "Finance, supplier payments, salaries" },
  { code: "WAITER",         name: "Waiter",          description: "Serves orders, optional clock-in" },
];

const PERMISSIONS = [
  // POS
  { code: "POS_BILL",            category: "POS",       description: "Create and pay orders" },
  { code: "POS_VOID",            category: "POS",       description: "Void / cancel an order" },
  { code: "POS_DISCOUNT_SMALL",  category: "POS",       description: "Apply discount up to 10%" },
  { code: "POS_DISCOUNT_LARGE",  category: "POS",       description: "Apply discount above 10%" },
  { code: "POS_REOPEN_SHIFT",    category: "POS",       description: "Reopen a closed shift" },
  // Inventory
  { code: "INV_ADJUST",          category: "INVENTORY", description: "Manual stock adjustment with reason" },
  { code: "INV_TRANSFER_DISPATCH", category: "INVENTORY", description: "Dispatch a stock transfer" },
  { code: "INV_TRANSFER_RECEIVE",  category: "INVENTORY", description: "Receive / confirm a transfer" },
  { code: "INV_PRODUCTION_RECORD", category: "INVENTORY", description: "Record production batches" },
  // Finance
  { code: "FIN_EXPENSE_ADD",     category: "FINANCE",   description: "Record an expense" },
  { code: "FIN_SUPPLIER_PAY",    category: "FINANCE",   description: "Make a supplier payment" },
  { code: "FIN_VIEW_PROFIT",     category: "FINANCE",   description: "View P&L reports" },
  // Admin
  { code: "ADMIN_USER_MGMT",     category: "ADMIN",     description: "Create / edit users & roles" },
  { code: "ADMIN_PRICE_EDIT",    category: "ADMIN",     description: "Change item prices" },
  { code: "ADMIN_AUDIT_VIEW",    category: "ADMIN",     description: "View audit logs" },
];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: PERMISSIONS.map((p) => p.code),
  BRANCH_MANAGER: [
    "POS_BILL", "POS_VOID", "POS_DISCOUNT_SMALL", "POS_DISCOUNT_LARGE", "POS_REOPEN_SHIFT",
    "INV_TRANSFER_RECEIVE", "INV_ADJUST",
    "FIN_EXPENSE_ADD",
  ],
  CASHIER: ["POS_BILL", "POS_DISCOUNT_SMALL"],
  STORE_MGR: ["INV_ADJUST", "INV_TRANSFER_DISPATCH", "INV_PRODUCTION_RECORD"],
  PRODUCTION: ["INV_PRODUCTION_RECORD"],
  ACCOUNTANT: ["FIN_EXPENSE_ADD", "FIN_SUPPLIER_PAY", "FIN_VIEW_PROFIT"],
  WAITER: [],
};

// ─── Units ──────────────────────────────────────────────────────────────────

const UNITS = [
  { code: "kg",     name: "Kilogram",     type: "WEIGHT" as const },
  { code: "g",      name: "Gram",         type: "WEIGHT" as const },
  { code: "l",      name: "Liter",        type: "VOLUME" as const },
  { code: "ml",     name: "Milliliter",   type: "VOLUME" as const },
  { code: "pc",     name: "Piece",        type: "COUNT"  as const },
  { code: "crate",  name: "Crate",        type: "COUNT"  as const },
  { code: "box",    name: "Box",          type: "COUNT"  as const },
  { code: "shoper", name: "Shoper (bag)", type: "CUSTOM" as const },
  { code: "glass",  name: "Glass",        type: "CUSTOM" as const },
];

// ─── Main seed ──────────────────────────────────────────────────────────────

async function main() {
  console.log("→ Seeding organization…");
  const org = await prisma.organization.upsert({
    where: { id: 1n },
    update: { name: "Sabir Juice Corner" },
    create: {
      id: 1n,
      name: "Sabir Juice Corner",
      country: "PK",
      currency: "PKR",
      timezone: "Asia/Karachi",
    },
  });

  console.log("→ Seeding roles & permissions…");
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { description: p.description, category: p.category },
      create: p,
    });
  }
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description, isSystem: true },
      create: { ...r, isSystem: true },
    });
  }
  for (const [roleCode, permCodes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
    for (const permCode of permCodes) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { code: permCode } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
  }

  console.log("→ Seeding units…");
  for (const u of UNITS) {
    await prisma.unit.upsert({
      where: { code: u.code },
      update: { name: u.name, type: u.type },
      create: u,
    });
  }

  console.log("→ Seeding categories & menu items from data/menu.json…");
  const menuPath = join(__dirname, "data", "menu.json");
  const menu = JSON.parse(readFileSync(menuPath, "utf-8")) as {
    categories: { code: string; name: string }[];
    items: {
      code: number;
      name: string;
      size: "MEDIUM" | "JUMBO" | "NA";
      price: number;
      category: string;
      needs_verify?: boolean;
      comment?: string;
    }[];
  };

  const categoryByCode: Record<string, bigint> = {};
  for (let i = 0; i < menu.categories.length; i++) {
    const c = menu.categories[i];
    const cat = await prisma.category.upsert({
      where: { id: BigInt(i + 1) },
      update: { name: c.name, sortOrder: i },
      create: { id: BigInt(i + 1), name: c.name, sortOrder: i },
    });
    categoryByCode[c.code] = cat.id;
  }

  // Pass 1: create/update items
  for (const it of menu.items) {
    await prisma.item.upsert({
      where: { itemCode: it.code },
      update: {
        name: it.name,
        size: it.size,
        categoryId: categoryByCode[it.category],
      },
      create: {
        itemCode: it.code,
        name: it.name,
        size: it.size,
        categoryId: categoryByCode[it.category],
      },
    });
    // Default org-wide price
    const item = await prisma.item.findUniqueOrThrow({ where: { itemCode: it.code } });
    const existingPrice = await prisma.itemPrice.findFirst({
      where: { itemId: item.id, branchId: null, effectiveTo: null },
    });
    if (!existingPrice || !existingPrice.price.equals(new Prisma.Decimal(it.price))) {
      // Close out any open price
      if (existingPrice) {
        await prisma.itemPrice.update({
          where: { id: existingPrice.id },
          data: { effectiveTo: new Date() },
        });
      }
      await prisma.itemPrice.create({
        data: {
          itemId: item.id,
          branchId: null,
          price: new Prisma.Decimal(it.price),
        },
      });
    }
  }

  // Pass 2: link Medium ↔ Jumbo pairs *where both exist with the same canonical name*
  const itemsByName = await prisma.item.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, size: true, pairId: true },
  });
  const byName = new Map<string, typeof itemsByName>();
  for (const it of itemsByName) {
    const arr = byName.get(it.name) ?? [];
    arr.push(it);
    byName.set(it.name, arr);
  }
  for (const [, group] of byName) {
    const medium = group.find((g) => g.size === "MEDIUM");
    const jumbo = group.find((g) => g.size === "JUMBO");
    if (medium && jumbo) {
      if (medium.pairId !== jumbo.id) {
        await prisma.item.update({ where: { id: medium.id }, data: { pairId: jumbo.id } });
      }
      if (jumbo.pairId !== medium.id) {
        await prisma.item.update({ where: { id: jumbo.id }, data: { pairId: medium.id } });
      }
    }
  }

  console.log("→ Seeding branches (central kitchen + 3 outlets) — rename as needed…");
  const centralKitchen = await prisma.branch.upsert({
    where: { code: "CK" },
    update: {},
    create: {
      organizationId: org.id,
      code: "CK",
      name: "Central Kitchen",
      isCentralKitchen: true,
      city: "Multan",
    },
  });
  const branchCodes = [
    { code: "B1", name: "Branch 1" },
    { code: "B2", name: "Cantt Branch" },
    { code: "B3", name: "Branch 3" },
  ];
  for (const b of branchCodes) {
    await prisma.branch.upsert({
      where: { code: b.code },
      update: { name: b.name },
      create: { organizationId: org.id, code: b.code, name: b.name, city: "Multan" },
    });
  }

  console.log("→ Seeding default stock locations…");
  // Do NOT use explicit IDs — that breaks the Postgres sequence and causes
  // unique-violation crashes when API code later inserts without an id.
  const existingStore = await prisma.stockLocation.findFirst({
    where: { branchId: centralKitchen.id, name: "Central Store" },
  });
  if (!existingStore) {
    await prisma.stockLocation.create({
      data: { branchId: centralKitchen.id, name: "Central Store", type: "CENTRAL_STORE" },
    });
  }
  const existingFreezer = await prisma.stockLocation.findFirst({
    where: { branchId: centralKitchen.id, name: "Central Freezer" },
  });
  if (!existingFreezer) {
    await prisma.stockLocation.create({
      data: { branchId: centralKitchen.id, name: "Central Freezer", type: "FREEZER" },
    });
  }

  console.log("→ Seeding admin user (username: admin / password: ChangeMe!2026)…");
  const adminPasswordHash = await hashPassword("ChangeMe!2026");
  const adminUser = await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      organizationId: org.id,
      fullName: "Owner",
      username: "admin",
      passwordHash: adminPasswordHash,
    },
  });
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: "OWNER" } });
  const existingRole = await prisma.userRole.findFirst({
    where: { userId: adminUser.id, roleId: ownerRole.id, branchId: null },
  });
  if (!existingRole) {
    await prisma.userRole.create({
      data: { userId: adminUser.id, roleId: ownerRole.id, branchId: null },
    });
  }

  console.log("\n✓ Seed complete.\n");
  console.log("  Login: admin / ChangeMe!2026  (change immediately in production)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
