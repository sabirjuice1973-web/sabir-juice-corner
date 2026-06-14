import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { prisma } from "@sjc/db";
import { requireAuth, requirePermission } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";

const ListQuery = z.object({
  q: z.string().trim().optional(),
  code: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.bigint().optional(),
  size: z.enum(["MEDIUM", "JUMBO", "NA"]).optional(),
  // Admin Products screen needs to see inactive items too; defaults to active-only otherwise.
  includeInactive: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.coerce.bigint().optional(),
});

const CreateItemBody = z.object({
  itemCode: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  size: z.enum(["MEDIUM", "JUMBO", "NA"]).default("NA"),
  categoryId: z.coerce.bigint().optional(),
  initialPrice: z.coerce.number().nonnegative(),
  isActive: z.boolean().default(true),
  isSeasonal: z.boolean().default(false),
  pairItemCode: z.number().int().positive().optional(),   // optional: code of the Medium/Jumbo sibling
});

const UpdateItemBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  size: z.enum(["MEDIUM", "JUMBO", "NA"]).optional(),
  categoryId: z.coerce.bigint().nullable().optional(),
  isActive: z.boolean().optional(),
  isSeasonal: z.boolean().optional(),
  pairItemCode: z.number().int().positive().nullable().optional(),
});

const SetPriceBody = z.object({
  price: z.coerce.number().nonnegative(),
  branchId: z.coerce.bigint().nullable().optional(),    // null/omitted = org-wide default price
  reason: z.string().max(200).optional(),
});

const BulkPriceBody = z.object({
  changes: z.array(z.object({
    itemId: z.coerce.bigint(),
    price: z.coerce.number().nonnegative(),
  })).min(1).max(500),
  branchId: z.coerce.bigint().nullable().optional(),    // applies to all changes
  reason: z.string().max(200).optional(),
});

export async function registerItemRoutes(app: FastifyInstance) {
  // ─── Read endpoints (no auth required — cashier needs them for POS lookups) ──

  /** GET /items/by-code/:code — exact item lookup (POS hot path) */
  app.get("/by-code/:code", async (req, reply) => {
    const code = Number((req.params as { code: string }).code);
    if (!Number.isInteger(code) || code <= 0) {
      return reply.code(400).send({ error: "Invalid item code" });
    }
    const item = await prisma.item.findUnique({
      where: { itemCode: code },
      include: {
        category: true,
        prices: {
          where: { branchId: null, effectiveTo: null },
          orderBy: { effectiveFrom: "desc" },
          take: 1,
        },
        pair: { select: { id: true, itemCode: true, name: true, size: true } },
      },
    });
    if (!item || item.deletedAt) return reply.code(404).send({ error: "Not found" });
    return serializeItem(item);
  });

  /** GET /items — search / list with optional includeInactive (for admin Products screen) */
  app.get("/", async (req) => {
    const q = ListQuery.parse(req.query);
    const items = await prisma.item.findMany({
      where: {
        deletedAt: null,
        ...(q.includeInactive ? {} : { isActive: true }),
        ...(q.code ? { itemCode: q.code } : {}),
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        ...(q.size ? { size: q.size } : {}),
        ...(q.q ? { OR: [{ name: { contains: q.q, mode: "insensitive" } }] } : {}),
        ...(q.cursor ? { id: { gt: q.cursor } } : {}),
      },
      orderBy: [{ itemCode: "asc" }],
      take: q.limit + 1,
      include: {
        category: true,
        prices: {
          where: { branchId: null, effectiveTo: null },
          orderBy: { effectiveFrom: "desc" },
          take: 1,
        },
        pair: { select: { id: true, itemCode: true, name: true, size: true } },
      },
    });
    const hasMore = items.length > q.limit;
    const rows = hasMore ? items.slice(0, q.limit) : items;
    return {
      items: rows.map(serializeItem),
      nextCursor: hasMore ? rows[rows.length - 1].id.toString() : null,
    };
  });

  // ─── Admin-only write endpoints ──────────────────────────────────────────
  // Note: `ADMIN_PRICE_EDIT` already exists in the seeded permissions — it
  // gates price changes AND the broader product mgmt UX. OWNER bypasses gates.

  /**
   * POST /items — create a new product with initial price.
   *
   * Initial price goes into ItemPrice with effectiveTo=null (current). The
   * price-versioning history starts here; future price changes close out this
   * row (effectiveTo=now) and insert a new one — historical orders keep their
   * original prices because OrderItem.unitPrice is captured at add-time.
   */
  app.post("/", { preHandler: [requireAuth, requirePermission("ADMIN_PRICE_EDIT")] }, async (req, reply) => {
    const parsed = CreateItemBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    // Uniqueness check before touching the DB so we get a clean error message
    const existing = await prisma.item.findUnique({ where: { itemCode: parsed.data.itemCode } });
    if (existing) return reply.code(409).send({ error: `Item code ${parsed.data.itemCode} is already in use` });

    let pairId: bigint | null = null;
    if (parsed.data.pairItemCode) {
      const pair = await prisma.item.findUnique({ where: { itemCode: parsed.data.pairItemCode } });
      if (!pair) return reply.code(400).send({ error: `Pair item code ${parsed.data.pairItemCode} not found` });
      pairId = pair.id;
    }

    const created = await prisma.$transaction(async (tx) => {
      const item = await tx.item.create({
        data: {
          itemCode: parsed.data.itemCode,
          name: parsed.data.name,
          size: parsed.data.size,
          categoryId: parsed.data.categoryId,
          isActive: parsed.data.isActive,
          isSeasonal: parsed.data.isSeasonal,
          pairId,
        },
      });
      await tx.itemPrice.create({
        data: {
          itemId: item.id,
          branchId: null,
          price: new Prisma.Decimal(parsed.data.initialPrice),
        },
      });
      // Mirror the pair link on the sibling so both items reference each other
      if (pairId) {
        await tx.item.update({ where: { id: pairId }, data: { pairId: item.id } });
      }
      return tx.item.findUniqueOrThrow({
        where: { id: item.id },
        include: {
          category: true,
          prices: { where: { branchId: null, effectiveTo: null }, orderBy: { effectiveFrom: "desc" }, take: 1 },
          pair: { select: { id: true, itemCode: true, name: true, size: true } },
        },
      });
    });

    await writeAudit({
      req,
      action: "item.create", entityType: "Item", entityId: created.id,
      after: { itemCode: created.itemCode, name: created.name, size: created.size, initialPrice: parsed.data.initialPrice },
    });
    return toJson(serializeItem(created));
  });

  /**
   * PATCH /items/:id — update metadata only (NOT price; use /price for that).
   *
   * Editable: name, size, category, isActive, isSeasonal, pair. The audit log
   * captures the full before/after so we can trace who renamed or disabled what.
   */
  app.patch("/:id", { preHandler: [requireAuth, requirePermission("ADMIN_PRICE_EDIT")] }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = UpdateItemBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const before = await prisma.item.findUnique({ where: { id }, include: { pair: { select: { itemCode: true } } } });
    if (!before) return reply.code(404).send({ error: "Item not found" });

    // Resolve pairItemCode → pairId. Setting pairItemCode to null removes the pairing.
    let pairUpdate: { pairId: bigint | null } | undefined = undefined;
    if (parsed.data.pairItemCode !== undefined) {
      if (parsed.data.pairItemCode === null) {
        pairUpdate = { pairId: null };
      } else {
        const pair = await prisma.item.findUnique({ where: { itemCode: parsed.data.pairItemCode } });
        if (!pair) return reply.code(400).send({ error: `Pair item code ${parsed.data.pairItemCode} not found` });
        if (pair.id === id) return reply.code(400).send({ error: "Cannot pair item with itself" });
        pairUpdate = { pairId: pair.id };
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const oldPairId = before.pairId;
      const u = await tx.item.update({
        where: { id },
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.size !== undefined ? { size: parsed.data.size } : {}),
          ...(parsed.data.categoryId !== undefined ? { categoryId: parsed.data.categoryId } : {}),
          ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
          ...(parsed.data.isSeasonal !== undefined ? { isSeasonal: parsed.data.isSeasonal } : {}),
          ...(pairUpdate ?? {}),
        },
        include: {
          category: true,
          prices: { where: { branchId: null, effectiveTo: null }, orderBy: { effectiveFrom: "desc" }, take: 1 },
          pair: { select: { id: true, itemCode: true, name: true, size: true } },
        },
      });
      // Keep pair symmetry in sync
      if (pairUpdate) {
        if (oldPairId && oldPairId !== pairUpdate.pairId) {
          await tx.item.update({ where: { id: oldPairId }, data: { pairId: null } });
        }
        if (pairUpdate.pairId) {
          await tx.item.update({ where: { id: pairUpdate.pairId }, data: { pairId: id } });
        }
      }
      return u;
    });

    await writeAudit({
      req,
      action: "item.update", entityType: "Item", entityId: id,
      before: { name: before.name, size: before.size, isActive: before.isActive, isSeasonal: before.isSeasonal, pairItemCode: before.pair?.itemCode ?? null },
      after: { name: updated.name, size: updated.size, isActive: updated.isActive, isSeasonal: updated.isSeasonal, pairItemCode: updated.pair?.itemCode ?? null },
    });
    return toJson(serializeItem(updated));
  });

  /**
   * POST /items/:id/price — record a new price.
   *
   * Versioning model: closes out the currently-effective ItemPrice for this
   * (item, branch) scope by setting effectiveTo=now, then inserts a new row
   * with effectiveFrom=now and effectiveTo=null.
   *
   * Why this matters: historical orders captured unitPrice at add-time, so a
   * price change here does NOT mutate any past sale. Future orders pick up the
   * new price automatically because OrderItem.add reads the row where
   * effectiveTo IS NULL.
   *
   * branchId=null → org-wide default. branchId=N → per-branch override.
   */
  app.post("/:id/price", { preHandler: [requireAuth, requirePermission("ADMIN_PRICE_EDIT")] }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const parsed = SetPriceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const item = await prisma.item.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: "Item not found" });

    const branchId = parsed.data.branchId ?? null;
    const newPrice = new Prisma.Decimal(parsed.data.price);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.itemPrice.findFirst({
        where: { itemId: id, branchId, effectiveTo: null },
        orderBy: { effectiveFrom: "desc" },
      });
      const oldPrice = current?.price ?? null;

      // If the new price is identical to the current one, do nothing — no point
      // making a zero-effect history row.
      if (oldPrice && oldPrice.equals(newPrice)) {
        return { changed: false, oldPrice: oldPrice.toString(), newPrice: newPrice.toString() };
      }

      if (current) {
        await tx.itemPrice.update({ where: { id: current.id }, data: { effectiveTo: new Date() } });
      }
      await tx.itemPrice.create({
        data: { itemId: id, branchId, price: newPrice },
      });
      return { changed: true, oldPrice: oldPrice?.toString() ?? null, newPrice: newPrice.toString() };
    });

    if (result.changed) {
      await writeAudit({
        req,
        action: "item.price.update", entityType: "Item", entityId: id,
        before: { price: result.oldPrice, branchId: branchId?.toString() ?? null },
        after: { price: result.newPrice, branchId: branchId?.toString() ?? null, reason: parsed.data.reason ?? null },
      });
    }
    return toJson({ ...result, itemCode: item.itemCode });
  });

  /**
   * POST /items/bulk-price — apply many price changes in one atomic transaction.
   *
   * Used by the admin Products screen's "Bulk edit prices" mode. The cashier (or
   * owner) types new prices into the table inline, then saves. We do the whole
   * batch in one DB transaction so partial application is impossible — if any
   * single row's update would fail, the whole batch rolls back.
   *
   * Per-change behaviour mirrors POST /:id/price:
   *   • Same-price → skipped (no zero-effect history row)
   *   • Different → close out current ItemPrice (effectiveTo=now), insert new
   *
   * Returns a per-item breakdown so the UI can render applied / skipped / errored
   * counts. One audit log row per actual change (skipped rows produce no log).
   */
  app.post("/bulk-price", { preHandler: [requireAuth, requirePermission("ADMIN_PRICE_EDIT")] }, async (req, reply) => {
    const parsed = BulkPriceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const branchId = parsed.data.branchId ?? null;
    const reason = parsed.data.reason ?? null;
    const itemIds = parsed.data.changes.map((c) => c.itemId);

    // Pre-fetch every targeted item + its current price in one go
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, name: true },
    });
    const itemMap = new Map(items.map((i) => [i.id.toString(), i]));

    const result = await prisma.$transaction(async (tx) => {
      const applied: { itemId: string; itemCode: number; name: string; oldPrice: string | null; newPrice: string }[] = [];
      const skipped: { itemId: string; itemCode: number; reason: string }[] = [];
      const errors:  { itemId: string; itemCode: number | null; error: string }[] = [];

      for (const change of parsed.data.changes) {
        const idKey = change.itemId.toString();
        const item = itemMap.get(idKey);
        if (!item) {
          errors.push({ itemId: idKey, itemCode: null, error: "Item not found" });
          continue;
        }
        try {
          const newPrice = new Prisma.Decimal(change.price);
          const current = await tx.itemPrice.findFirst({
            where: { itemId: change.itemId, branchId, effectiveTo: null },
            orderBy: { effectiveFrom: "desc" },
          });
          const oldPrice = current?.price ?? null;
          if (oldPrice && oldPrice.equals(newPrice)) {
            skipped.push({ itemId: idKey, itemCode: item.itemCode, reason: "same price" });
            continue;
          }
          if (current) {
            await tx.itemPrice.update({ where: { id: current.id }, data: { effectiveTo: new Date() } });
          }
          await tx.itemPrice.create({
            data: { itemId: change.itemId, branchId, price: newPrice },
          });
          applied.push({
            itemId: idKey,
            itemCode: item.itemCode,
            name: item.name,
            oldPrice: oldPrice?.toString() ?? null,
            newPrice: newPrice.toString(),
          });
        } catch (e: any) {
          errors.push({ itemId: idKey, itemCode: item.itemCode, error: e.message ?? "update failed" });
        }
      }

      // If anything errored, abort the whole batch (so a partial update can't sneak in).
      // Same-price skips are fine — they're not failures, just no-ops.
      if (errors.length > 0) {
        throw new Error(`bulk-price failed: ${errors.length} error(s). First: ${errors[0].error}`);
      }
      return { applied, skipped };
    }).catch((e: any) => ({ applied: [] as any, skipped: [] as any, errored: e.message ?? "transaction failed" } as any));

    // Audit log — one row per *applied* change so the trail is clean
    if (result.applied) {
      for (const a of result.applied) {
        await writeAudit({
          req,
          action: "item.price.update.bulk", entityType: "Item", entityId: BigInt(a.itemId),
          before: { price: a.oldPrice, branchId: branchId?.toString() ?? null },
          after: { price: a.newPrice, branchId: branchId?.toString() ?? null, reason },
        });
      }
    }

    return toJson(result);
  });

  /**
   * POST /items/import — bulk replace the entire menu from an uploaded XLSX file.
   *
   * Format expected: column A = item code (int), column B = name (string),
   * column C = price (number). First row may be a header — auto-detected and
   * skipped if its first cell isn't a number.
   *
   * Two modes via the `mode` form field:
   *   • "preview" — parse + validate + classify, return planned changes WITHOUT touching DB
   *   • "apply"   — preview, then execute the plan in one transaction
   *
   * "Replace mode" semantics:
   *   • Items in the file but NOT in DB           → INSERTED (new Item + initial ItemPrice)
   *   • Items in BOTH (matched by itemCode)       → UPDATED (name/size/category if changed, new ItemPrice if price differs)
   *   • Items in DB but NOT in the file           → SOFT-DELETED (deletedAt=now + isActive=false)
   *                                                 We never hard-delete because OrderItem rows reference itemId; soft-delete
   *                                                 keeps historical bills intact while removing the item from active menus.
   *
   * Size + category are INFERRED from the name (user provides only 3 columns):
   *   • Size: trailing word "Medium" / "Med" → MEDIUM; "Jumbo" / "Jum" → JUMBO; else NA.
   *     ("Large" stays in the name string but maps to NA — schema enum has no LARGE value.)
   *   • Category: keyword scan (shake, lassi, ice cream, tea/coffee, mocktail, water/cola/cold-drink, mix) — defaults to JUICE.
   *
   * Pair linking (Medium ↔ Jumbo): after upsert, items with the same base name
   * (name minus the trailing "Medium"/"Jumbo") get their `pairId` set on both sides.
   *
   * One audit log row per import (with summary counts). Individual row-level changes
   * are NOT audited per-item to keep the log clean — the upload file itself is the
   * authoritative record of what changed.
   */
  app.post("/import", { preHandler: [requireAuth, requirePermission("ADMIN_PRICE_EDIT")] }, async (req, reply) => {
    // Pull multipart parts. Fastify gives us an async iterator over form parts; we
    // want exactly one file ("file") and one optional field ("mode").
    const data: { fileBuf?: Buffer; mode: "preview" | "apply" } = { mode: "preview" };
    try {
      for await (const part of (req as any).parts()) {
        if (part.type === "file" && part.fieldname === "file") {
          data.fileBuf = await part.toBuffer();
        } else if (part.type === "field" && part.fieldname === "mode") {
          data.mode = part.value === "apply" ? "apply" : "preview";
        }
      }
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || "Failed to read upload" });
    }
    if (!data.fileBuf) return reply.code(400).send({ error: "No 'file' field in upload" });

    // Parse + classify. Failures here are the user's data problem, not a server error.
    let parsed: ParsedImport;
    try {
      parsed = parseMenuXlsx(data.fileBuf);
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message || "Could not parse the spreadsheet" });
    }
    if (parsed.rows.length === 0) {
      return reply.code(400).send({ error: "No valid rows found. Expected columns: code, name, price." });
    }

    // ─── Compute the diff against the current DB ────────────────────────────
    const existing = await prisma.item.findMany({
      where: { deletedAt: null },
      include: {
        prices: { where: { branchId: null, effectiveTo: null }, orderBy: { effectiveFrom: "desc" }, take: 1 },
      },
    });
    const existingByCode = new Map(existing.map((it) => [it.itemCode, it]));
    const incomingCodes = new Set(parsed.rows.map((r) => r.code));

    const toInsert: ParsedRow[] = [];
    const toUpdate: { row: ParsedRow; existing: typeof existing[number] }[] = [];
    const toSoftDelete: typeof existing = [] as any;

    for (const row of parsed.rows) {
      const ex = existingByCode.get(row.code);
      if (!ex) {
        toInsert.push(row);
      } else {
        toUpdate.push({ row, existing: ex });
      }
    }
    for (const ex of existing) {
      if (!incomingCodes.has(ex.itemCode)) (toSoftDelete as any).push(ex);
    }

    // Bucket the updates so the UI can highlight what actually changed
    const updatesWithDiff = toUpdate.map(({ row, existing: ex }) => {
      const currentPrice = ex.prices?.[0]?.price?.toString() ?? null;
      const newPriceStr = row.price.toFixed(2);
      const nameChanged = row.name !== ex.name;
      const sizeChanged = row.size !== ex.size;
      const priceChanged = currentPrice ? !new Prisma.Decimal(currentPrice).equals(new Prisma.Decimal(newPriceStr)) : true;
      return {
        code: row.code,
        existingName: ex.name,
        newName: row.name,
        existingSize: ex.size,
        newSize: row.size,
        existingPrice: currentPrice,
        newPrice: newPriceStr,
        category: row.category,
        nameChanged, sizeChanged, priceChanged,
        anyChange: nameChanged || sizeChanged || priceChanged,
      };
    });

    const summary = {
      mode: data.mode,
      parsedRows: parsed.rows.length,
      warnings: parsed.warnings,
      toInsert: toInsert.length,
      toUpdate: updatesWithDiff.filter((u) => u.anyChange).length,
      toUpdateUnchanged: updatesWithDiff.filter((u) => !u.anyChange).length,
      toSoftDelete: (toSoftDelete as any).length,
      sampleInserts: toInsert.slice(0, 10).map((r) => ({ code: r.code, name: r.name, size: r.size, price: r.price.toFixed(2), category: r.category })),
      sampleUpdates: updatesWithDiff.filter((u) => u.anyChange).slice(0, 10),
      sampleDeletes: (toSoftDelete as any).slice(0, 10).map((it: any) => ({ code: it.itemCode, name: it.name })),
    };

    // ─── Preview mode — return the plan without writing ─────────────────────
    if (data.mode === "preview") {
      return toJson(summary);
    }

    // ─── Apply mode — single transaction ────────────────────────────────────
    // Increased timeout because a 200-item replace touches a lot of rows.
    await prisma.$transaction(async (tx) => {
      // 0) Re-sync autoincrement sequences. The original seed used explicit ids on
      //    Category / Item, which leaves the SERIAL sequence at its default (1) while
      //    real rows already occupy that range. The very next plain INSERT then hits
      //    a unique-constraint violation on id. setval() to MAX(id)+1 fixes that without
      //    touching existing data.
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"Category"', 'id'), COALESCE((SELECT MAX(id) FROM "Category"), 0) + 1, false)`,
      );
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"Item"', 'id'), COALESCE((SELECT MAX(id) FROM "Item"), 0) + 1, false)`,
      );
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"ItemPrice"', 'id'), COALESCE((SELECT MAX(id) FROM "ItemPrice"), 0) + 1, false)`,
      );

      // 1) Ensure all referenced category names exist; fetch the resulting id map.
      // Category.name is NOT unique in the schema, so we findFirst-then-create rather
      // than upsert (upsert needs a unique field). Existing categories are reused.
      // Sequential (not Promise.all) — concurrent writes on the same tx are fragile.
      const categoryNames = [...new Set(parsed.rows.map((r) => r.category))];
      const categoryIdByName = new Map<string, bigint>();
      for (const name of categoryNames) {
        const found = await tx.category.findFirst({ where: { name } });
        const row = found ?? (await tx.category.create({ data: { name } }));
        categoryIdByName.set(name, row.id);
      }

      // 2) Inserts
      for (const row of toInsert) {
        const item = await tx.item.create({
          data: {
            itemCode: row.code,
            name: row.name,
            size: row.size,
            categoryId: categoryIdByName.get(row.category) ?? null,
            isActive: true,
            isSeasonal: false,
          },
        });
        await tx.itemPrice.create({
          data: { itemId: item.id, branchId: null, price: new Prisma.Decimal(row.price.toFixed(2)) },
        });
      }

      // 3) Updates (only when something actually changed)
      for (const u of updatesWithDiff) {
        if (!u.anyChange) continue;
        const existingRow = existingByCode.get(u.code)!;
        if (u.nameChanged || u.sizeChanged) {
          await tx.item.update({
            where: { id: existingRow.id },
            data: {
              ...(u.nameChanged ? { name: u.newName } : {}),
              ...(u.sizeChanged ? { size: u.newSize } : {}),
              categoryId: categoryIdByName.get(u.category) ?? existingRow.categoryId,
              isActive: true,
              deletedAt: null,
            },
          });
        } else {
          // Re-activate if it was previously soft-deleted/inactive (shouldn't happen
          // because we filter deletedAt:null above, but inactive is possible).
          await tx.item.update({
            where: { id: existingRow.id },
            data: { isActive: true, categoryId: categoryIdByName.get(u.category) ?? existingRow.categoryId },
          });
        }
        if (u.priceChanged) {
          const current = await tx.itemPrice.findFirst({
            where: { itemId: existingRow.id, branchId: null, effectiveTo: null },
            orderBy: { effectiveFrom: "desc" },
          });
          if (current) {
            await tx.itemPrice.update({ where: { id: current.id }, data: { effectiveTo: new Date() } });
          }
          await tx.itemPrice.create({
            data: { itemId: existingRow.id, branchId: null, price: new Prisma.Decimal(u.newPrice) },
          });
        }
      }

      // 4) Soft-delete items not present in the upload
      const deleteIds = (toSoftDelete as any).map((it: any) => it.id);
      if (deleteIds.length > 0) {
        await tx.item.updateMany({
          where: { id: { in: deleteIds } },
          data: { deletedAt: new Date(), isActive: false, pairId: null },
        });
      }

      // 5) Pair-link Medium↔Jumbo by base name (name minus the trailing size word)
      const allActive = await tx.item.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true, size: true, pairId: true },
      });
      const groups = new Map<string, { medium?: bigint; jumbo?: bigint }>();
      for (const it of allActive) {
        if (it.size !== "MEDIUM" && it.size !== "JUMBO") continue;
        const base = stripSizeSuffix(it.name);
        const slot = groups.get(base) ?? {};
        if (it.size === "MEDIUM") slot.medium = it.id;
        else slot.jumbo = it.id;
        groups.set(base, slot);
      }
      // Clear all existing pairings first, then re-link the groups we found.
      // Cheaper than computing a diff and avoids stale links pointing at deleted ids.
      await tx.item.updateMany({ where: { pairId: { not: null } }, data: { pairId: null } });
      for (const [, slot] of groups) {
        if (slot.medium && slot.jumbo) {
          await tx.item.update({ where: { id: slot.medium }, data: { pairId: slot.jumbo } });
          await tx.item.update({ where: { id: slot.jumbo },  data: { pairId: slot.medium } });
        }
      }
    }, { timeout: 60_000, maxWait: 10_000 });

    await writeAudit({
      req,
      action: "menu.import", entityType: "Item", entityId: null,
      after: {
        inserted: toInsert.length,
        updated: updatesWithDiff.filter((u) => u.anyChange).length,
        softDeleted: (toSoftDelete as any).length,
        totalRowsParsed: parsed.rows.length,
        warnings: parsed.warnings.length,
      },
    });

    return toJson({ ...summary, mode: "apply", applied: true });
  });

  /** GET /items/:id/price-history — chronological price changes (admin audit view) */
  app.get("/:id/price-history", { preHandler: [requireAuth, requirePermission("ADMIN_PRICE_EDIT", "ADMIN_AUDIT_VIEW")] }, async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const item = await prisma.item.findUnique({ where: { id }, select: { id: true, name: true, itemCode: true } });
    if (!item) return reply.code(404).send({ error: "Item not found" });

    const history = await prisma.itemPrice.findMany({
      where: { itemId: id },
      orderBy: [{ branchId: "asc" }, { effectiveFrom: "desc" }],
      include: { branch: { select: { code: true, name: true } } },
    });

    return toJson({
      item: { id: item.id, itemCode: item.itemCode, name: item.name },
      history: history.map((h) => ({
        id: h.id,
        scope: h.branch ? `Branch: ${h.branch.name}` : "Org-wide",
        price: h.price.toString(),
        effectiveFrom: h.effectiveFrom,
        effectiveTo: h.effectiveTo,
        isCurrent: h.effectiveTo === null,
      })),
    });
  });
}

function serializeItem(item: any) {
  return {
    id: item.id.toString(),
    itemCode: item.itemCode,
    name: item.name,
    size: item.size,
    categoryId: item.categoryId?.toString() ?? null,
    category: item.category ? { id: item.category.id.toString(), name: item.category.name } : null,
    pair: item.pair
      ? {
          id: item.pair.id.toString(),
          itemCode: item.pair.itemCode,
          name: item.pair.name,
          size: item.pair.size,
        }
      : null,
    price: item.prices?.[0]?.price?.toString() ?? null,
    isActive: item.isActive,
    isSeasonal: item.isSeasonal,
  };
}

// ─── Menu import helpers ────────────────────────────────────────────────────

type ParsedRow = {
  code: number;
  name: string;
  size: "MEDIUM" | "JUMBO" | "NA";
  price: number;
  category: string;
  row: number;            // 1-indexed source row (for error messages)
};

type ParsedImport = {
  rows: ParsedRow[];
  warnings: { row: number; raw: any[]; reason: string }[];
};

/**
 * Parse an .xlsx buffer into validated menu rows.
 *
 * Expected layout: column A = code (int), B = name (string), C = price (number).
 * The first row may be a header — if A1 is a non-numeric string, we skip row 1.
 *
 * Rows that fail validation become `warnings` instead of throwing — partial
 * uploads should surface a "here's what we couldn't read" list rather than
 * rejecting the whole file for a single bad line.
 */
function parseMenuXlsx(buf: Buffer): ParsedImport {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("Spreadsheet has no sheets");
  const sheet = wb.Sheets[sheetName];
  const raw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });

  if (raw.length === 0) throw new Error("Spreadsheet is empty");

  // Header detection — first cell is a non-numeric string → skip the row
  let startIdx = 0;
  const firstCell = raw[0]?.[0];
  if (typeof firstCell === "string" && firstCell.trim() !== "" && !/^\d+$/.test(firstCell.trim())) {
    startIdx = 1;
  }

  const rows: ParsedRow[] = [];
  const warnings: ParsedImport["warnings"] = [];
  const seenCodes = new Set<number>();

  for (let i = startIdx; i < raw.length; i++) {
    const r = raw[i];
    const sourceRow = i + 1; // 1-indexed for human-readable error refs

    // Skip fully-empty rows quietly
    if (!r || r.every((c) => c === "" || c === null || c === undefined)) continue;

    const codeCell = r[0];
    const nameCell = r[1];
    const priceCell = r[2];

    const code = typeof codeCell === "number" ? codeCell : Number(String(codeCell ?? "").trim());
    const name = String(nameCell ?? "").trim();
    const price = typeof priceCell === "number" ? priceCell : Number(String(priceCell ?? "").trim());

    if (!Number.isInteger(code) || code <= 0) {
      warnings.push({ row: sourceRow, raw: r, reason: `Invalid code: "${codeCell}"` });
      continue;
    }
    if (!name) {
      warnings.push({ row: sourceRow, raw: r, reason: "Missing name" });
      continue;
    }
    if (!Number.isFinite(price) || price < 0) {
      warnings.push({ row: sourceRow, raw: r, reason: `Invalid price: "${priceCell}"` });
      continue;
    }
    if (seenCodes.has(code)) {
      warnings.push({ row: sourceRow, raw: r, reason: `Duplicate code ${code} (kept first occurrence)` });
      continue;
    }
    seenCodes.add(code);

    // Strip the trailing "Medium"/"Jumbo" word from the name — the size enum already
    // carries that info. Without this, receipts show "Mango Medium (M)" (word twice)
    // and mixes construct "Banana Shake Medium+Mango Medium Medium" (size duped on
    // both components AND appended once more). "Large" is preserved because the
    // schema has no LARGE enum value — keep it visible in the name instead.
    const sizeInferred = inferSize(name);
    const displayName = sizeInferred === "NA" ? name : nameWithoutSize(name);

    rows.push({
      code,
      name: displayName,
      size: sizeInferred,
      price,
      category: inferCategory(name),
      row: sourceRow,
    });
  }

  return { rows, warnings };
}

/**
 * Infer size from a trailing word in the item name.
 *
 * "Apple Medium"     → MEDIUM
 * "Mango Juice Med"  → MEDIUM
 * "Apple Jumbo"      → JUMBO
 * "Pomegranate Lrg"  → NA   (schema has no LARGE — keep "Lrg" in name, store as NA)
 * "Marinda"          → NA
 */
function inferSize(name: string): "MEDIUM" | "JUMBO" | "NA" {
  const last = name.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  if (last === "medium" || last === "med") return "MEDIUM";
  if (last === "jumbo" || last === "jum") return "JUMBO";
  return "NA";
}

/**
 * Strip the trailing size word so paired items can be matched by base name.
 * "Apple Medium" → "apple", "Apple Juice Jumbo" → "apple juice".
 * Lower-cased for case-insensitive matching across rows.
 */
function stripSizeSuffix(name: string): string {
  return nameWithoutSize(name).toLowerCase();
}

/**
 * Same as stripSizeSuffix but preserves the original casing — used for the
 * display name during import so receipts and mix lines don't duplicate the size word.
 */
function nameWithoutSize(name: string): string {
  return name.replace(/\s+(medium|med|jumbo|jum)$/i, "").trim();
}

/**
 * Best-effort category from name keywords. Defaults to "Fresh Juices" because
 * the bulk of the menu is fruit juices — owner can re-categorize individual
 * items in the admin Products screen afterwards.
 */
function inferCategory(name: string): string {
  const n = name.toLowerCase();
  if (/\b(shake|smoothie)\b/.test(n)) return "Shakes";
  if (/\blassi\b/.test(n)) return "Lassi";
  if (/\bice\s*cream\b/.test(n) || /\bsundae\b/.test(n) || /\bkulfi\b/.test(n)) return "Ice Cream";
  if (/\b(tea|coffee|chai|espresso|latte|cappuccino)\b/.test(n)) return "Tea & Coffee";
  if (/\bmocktail\b/.test(n)) return "Mocktails";
  if (/\b(water|cola|7up|sprite|pepsi|fanta|mirinda|marinda|cold\s*drink|soft\s*drink|soda)\b/.test(n)) return "Water & Soft Drinks";
  if (/\bmix\b/.test(n) || /\+/.test(name)) return "Mixes";
  if (/^cash$/i.test(name.trim())) return "Miscellaneous";
  return "Fresh Juices";
}
