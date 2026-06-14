import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";
import { requireAuth } from "../lib/guards.js";
import { writeAudit } from "../lib/audit.js";
import { toJson } from "../lib/serialize.js";

/**
 * Inventory Reconciliation — configuration endpoints (Phase 1B).
 *
 * Two concepts are configured here:
 *   1. YieldConfig  — how many medium-glass equivalents one shoper of a given
 *      pulp produces. Versioned (effectiveFrom/effectiveTo) so seasonal edits
 *      don't rewrite history — old reports look up the row that was active on
 *      the date being reported.
 *   2. ItemParticipation — for each Item, the list of pulps it draws from and
 *      the percentage of the glass each pulp contributes. Auto-seeded for
 *      simple items; the owner reviews and fills in mocktails/specials here.
 *
 * Permission: OWNER + BRANCH_MANAGER + ACCOUNTANT can write. Anyone authenticated
 * can read (the reconciliation engine is a read-heavy system).
 */

const WRITE_ROLES = new Set(["OWNER", "BRANCH_MANAGER", "ACCOUNTANT"]);
function canWrite(roleCodes: string[]): boolean {
  return roleCodes.some((c) => WRITE_ROLES.has(c));
}

const SetYieldBody = z.object({
  processedProductId: z.coerce.bigint(),
  glassesPerShoper: z.coerce.number().positive().max(1000),
  notes: z.string().trim().max(300).optional(),
  // For Phase 1B only org-wide yields are supported; per-branch overrides can
  // ride on the same table later by setting branchId here.
  branchId: z.coerce.bigint().nullable().optional(),
});

const ParticipationRowSchema = z.object({
  processedProductId: z.coerce.bigint(),
  participationPct: z.coerce.number().nonnegative().max(100),
});
const ReplaceParticipationsBody = z.object({
  participations: z.array(ParticipationRowSchema).max(20),
  // Sum tolerance — accept 99.9 ≤ sum ≤ 100.1 to absorb 33.33×3 rounding.
});

const ParticipationsQuery = z.object({
  categoryId: z.coerce.bigint().optional(),
  needsSetup: z.coerce.boolean().optional(),
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  cursor: z.coerce.bigint().optional(),
});

export async function registerReconciliationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // ─── Pulps (read-only list, used by the participation picker) ─────────

  /** GET /reconciliation/pulps — flat list of active ProcessedProducts. */
  app.get("/pulps", async () => {
    const pulps = await prisma.processedProduct.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, storageUnit: true },
    });
    return toJson({ pulps });
  });

  // ─── Yield configuration ──────────────────────────────────────────────

  /**
   * GET /reconciliation/yields — one row per pulp with its currently-active yield.
   *
   * We resolve "active" as the row with the latest effectiveFrom that's ≤ today
   * AND whose effectiveTo is NULL or in the future. Branch override (branchId set)
   * wins over the org-wide row (branchId null). Today only org-wide is supported
   * in the UI, but the resolution rule handles both.
   *
   * Pulps with no YieldConfig at all surface with `current: null` so the admin
   * UI can flag them.
   */
  app.get("/yields", async (req) => {
    const q = z.object({ branchId: z.coerce.bigint().optional() }).safeParse(req.query);
    const branchId = q.success ? q.data.branchId : undefined;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const [pulps, configs] = await Promise.all([
      prisma.processedProduct.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, storageUnit: true },
      }),
      prisma.yieldConfig.findMany({
        where: {
          effectiveFrom: { lte: today },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: today } }],
          ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : { branchId: null }),
        },
        orderBy: [{ effectiveFrom: "desc" }],
        include: {
          createdBy: { select: { id: true, fullName: true, username: true } },
        },
      }),
    ]);

    // For each pulp pick the best row: branch-specific override beats org-wide,
    // newest effectiveFrom beats older.
    const byPulp = new Map<string, typeof configs[number]>();
    for (const c of configs) {
      const key = c.processedProductId.toString();
      const cur = byPulp.get(key);
      if (!cur) { byPulp.set(key, c); continue; }
      // Prefer per-branch row over org-wide
      if (c.branchId && !cur.branchId) { byPulp.set(key, c); continue; }
      if (!c.branchId && cur.branchId) continue;
      // Same scope → newer effectiveFrom wins (already ordered by it)
    }

    return toJson({
      yields: pulps.map((p) => {
        const c = byPulp.get(p.id.toString());
        return {
          pulp: { id: p.id.toString(), name: p.name, storageUnit: p.storageUnit },
          current: c
            ? {
                id: c.id.toString(),
                glassesPerShoper: c.glassesPerShoper.toString(),
                effectiveFrom: c.effectiveFrom.toISOString().slice(0, 10),
                branchScope: c.branchId ? c.branchId.toString() : null,   // null = org-wide
                notes: c.notes,
                changedBy: c.createdBy ? { id: c.createdBy.id.toString(), fullName: c.createdBy.fullName, username: c.createdBy.username } : null,
              }
            : null,
        };
      }),
    });
  });

  /**
   * POST /reconciliation/yields — set a new yield for a pulp.
   *
   * Versioning: closes any currently-active row for the same (processedProductId,
   * branchId) scope by setting effectiveTo = today, then inserts a new row with
   * effectiveFrom = today. Old reports keep working because they read by date.
   */
  app.post("/yields", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can change yields" });
    }
    const parsed = SetYieldBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const pulp = await prisma.processedProduct.findUnique({ where: { id: parsed.data.processedProductId }, select: { id: true, name: true } });
    if (!pulp) return reply.code(404).send({ error: "Pulp not found" });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const scopeBranchId = parsed.data.branchId ?? null;
    const newValue = new Prisma.Decimal(parsed.data.glassesPerShoper);

    // Find current active row for this scope
    const current = await prisma.yieldConfig.findFirst({
      where: {
        processedProductId: parsed.data.processedProductId,
        branchId: scopeBranchId,
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: today } }],
      },
      orderBy: { effectiveFrom: "desc" },
    });
    if (current && current.glassesPerShoper.equals(newValue)) {
      // No-op — don't write a zero-effect history row.
      return toJson({ changed: false, current });
    }

    const result = await prisma.$transaction(async (tx) => {
      if (current) {
        await tx.yieldConfig.update({ where: { id: current.id }, data: { effectiveTo: today } });
      }
      const created = await tx.yieldConfig.create({
        data: {
          processedProductId: parsed.data.processedProductId,
          branchId: scopeBranchId,
          glassesPerShoper: newValue,
          effectiveFrom: today,
          notes: parsed.data.notes ?? null,
          createdById: BigInt(req.auth!.sub),
        },
      });
      return { created, previous: current };
    });

    await writeAudit({
      req,
      action: "reconciliation.yield.update", entityType: "YieldConfig", entityId: result.created.id,
      before: result.previous ? { glassesPerShoper: result.previous.glassesPerShoper.toString(), effectiveFrom: result.previous.effectiveFrom.toISOString().slice(0, 10) } : null,
      after: { processedProductId: parsed.data.processedProductId.toString(), pulpName: pulp.name, glassesPerShoper: newValue.toString(), branchId: scopeBranchId?.toString() ?? null },
    });

    return toJson({ changed: true, yieldConfig: { id: result.created.id.toString(), glassesPerShoper: result.created.glassesPerShoper.toString(), effectiveFrom: result.created.effectiveFrom.toISOString().slice(0, 10) } });
  });

  /** GET /reconciliation/yields/:pulpId/history — chronological audit view */
  app.get("/yields/:pulpId/history", async (req, reply) => {
    const id = BigInt((req.params as { pulpId: string }).pulpId);
    const pulp = await prisma.processedProduct.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!pulp) return reply.code(404).send({ error: "Pulp not found" });

    const rows = await prisma.yieldConfig.findMany({
      where: { processedProductId: id },
      orderBy: [{ branchId: "asc" }, { effectiveFrom: "desc" }],
      include: {
        branch: { select: { id: true, code: true, name: true } },
        createdBy: { select: { id: true, fullName: true, username: true } },
      },
    });
    return toJson({
      pulp: { id: pulp.id.toString(), name: pulp.name },
      history: rows.map((r) => ({
        id: r.id.toString(),
        scope: r.branch ? `Branch: ${r.branch.name}` : "Org-wide",
        glassesPerShoper: r.glassesPerShoper.toString(),
        effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
        effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
        isCurrent: r.effectiveTo === null,
        notes: r.notes,
        changedBy: r.createdBy ? { fullName: r.createdBy.fullName, username: r.createdBy.username } : null,
      })),
    });
  });

  // ─── Participations ───────────────────────────────────────────────────

  /**
   * GET /reconciliation/participations — list items in the participating
   * categories along with their fruit pulps and percentages.
   *
   * Filters:
   *   categoryId  — single category
   *   needsSetup  — true → return only items with NO participation rows AND
   *                 not flagged excludeFromAutoReconciliation
   *   search      — case-insensitive contains-match on item name or code
   *
   * Items are returned newest-itemCode-first by default. The list includes
   * the participation sum so the UI can flag rows that don't total ~100%.
   */
  app.get("/participations", async (req, reply) => {
    const q = ParticipationsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query", details: q.error.flatten() });

    // Only items in participating categories (JUICE / SHAKE / MIX / SEASONAL).
    // Lookup by category names matching the live DB (Fresh Juices / Shakes / Mixes / Seasonal).
    const participatingCategoryNames = ["Fresh Juices", "Shakes", "Mixes", "Seasonal"];

    const whereBase: Prisma.ItemWhereInput = {
      isActive: true,
      deletedAt: null,
      excludeFromAutoReconciliation: false,
      ...(q.data.categoryId ? { categoryId: q.data.categoryId } : { category: { name: { in: participatingCategoryNames } } }),
      ...(q.data.search ? {
        OR: [
          { name: { contains: q.data.search, mode: "insensitive" } },
          ...(Number.isInteger(+q.data.search) ? [{ itemCode: +q.data.search }] : []),
        ],
      } : {}),
      ...(q.data.cursor ? { id: { gt: q.data.cursor } } : {}),
    };

    const items = await prisma.item.findMany({
      where: q.data.needsSetup ? { ...whereBase, participations: { none: {} } } : whereBase,
      orderBy: [{ itemCode: "asc" }],
      take: q.data.limit + 1,
      include: {
        category: { select: { id: true, name: true } },
        participations: {
          include: { processedProduct: { select: { id: true, name: true } } },
        },
      },
    });
    const hasMore = items.length > q.data.limit;
    const page = hasMore ? items.slice(0, q.data.limit) : items;

    return toJson({
      items: page.map((it) => {
        const sum = it.participations.reduce((s, p) => s + Number(p.participationPct), 0);
        return {
          id: it.id.toString(),
          itemCode: it.itemCode,
          name: it.name,
          size: it.size,
          category: it.category ? { id: it.category.id.toString(), name: it.category.name } : null,
          participations: it.participations.map((p) => ({
            id: p.id.toString(),
            pulp: { id: p.processedProduct.id.toString(), name: p.processedProduct.name },
            pct: p.participationPct.toString(),
            isAutoSeeded: p.isAutoSeeded,
          })),
          sumPct: +sum.toFixed(2),
        };
      }),
      nextCursor: hasMore ? page[page.length - 1].id.toString() : null,
    });
  });

  /**
   * PUT /reconciliation/participations/:itemId — replace all participations for one item.
   *
   * Body is a list of {processedProductId, participationPct}. Sum must be in
   * [99.9, 100.1] (tolerance for 33.33×3 rounding). On success: deletes all
   * existing rows for this item, inserts the new ones, audit-logs the change.
   *
   * Pass an empty array to clear all participations (e.g. for items that
   * shouldn't participate after all).
   */
  app.put("/participations/:itemId", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can change participations" });
    }
    const itemId = BigInt((req.params as { itemId: string }).itemId);
    const parsed = ReplaceParticipationsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { id: true, name: true, itemCode: true } });
    if (!item) return reply.code(404).send({ error: "Item not found" });

    // Sum check — accept 0 rows (clearing) OR a sum in the tolerance band.
    const sum = parsed.data.participations.reduce((s, p) => s + p.participationPct, 0);
    if (parsed.data.participations.length > 0 && (sum < 99.9 || sum > 100.1)) {
      return reply.code(400).send({ error: `Participation percentages must sum to ~100 (got ${sum.toFixed(2)})` });
    }

    // Dedup check — can't have two rows for the same pulp.
    const pulpIds = parsed.data.participations.map((p) => p.processedProductId.toString());
    if (new Set(pulpIds).size !== pulpIds.length) {
      return reply.code(400).send({ error: "Duplicate pulp in participation list" });
    }

    // Validate that all referenced pulps exist.
    const pulps = parsed.data.participations.length === 0 ? [] : await prisma.processedProduct.findMany({
      where: { id: { in: parsed.data.participations.map((p) => p.processedProductId) } },
      select: { id: true },
    });
    if (pulps.length !== parsed.data.participations.length) {
      return reply.code(400).send({ error: "One or more pulps not found" });
    }

    const before = await prisma.itemParticipation.findMany({
      where: { itemId },
      include: { processedProduct: { select: { name: true } } },
    });

    await prisma.$transaction(async (tx) => {
      await tx.itemParticipation.deleteMany({ where: { itemId } });
      if (parsed.data.participations.length > 0) {
        await tx.itemParticipation.createMany({
          data: parsed.data.participations.map((p) => ({
            itemId,
            processedProductId: p.processedProductId,
            participationPct: new Prisma.Decimal(p.participationPct),
            isAutoSeeded: false,   // owner explicitly set this
          })),
        });
      }
    });

    await writeAudit({
      req,
      action: "reconciliation.participation.replace", entityType: "Item", entityId: itemId,
      before: { participations: before.map((p) => ({ pulp: p.processedProduct.name, pct: p.participationPct.toString() })) },
      after:  { itemCode: item.itemCode, itemName: item.name, participations: parsed.data.participations.map((p) => ({ processedProductId: p.processedProductId.toString(), pct: p.participationPct })) },
    });

    return toJson({ ok: true, count: parsed.data.participations.length, sum: +sum.toFixed(2) });
  });

  // ─── Daily reconciliation (operational) ───────────────────────────────

  /**
   * GET /reconciliation/preview?branchId=X&businessDate=Y
   *
   * The math engine: aggregates fruit consumption from PAID orders on this
   * branch + business day and returns one row per pulp with:
   *   - expectedConsumptionMGE   = sum of (qty × sizeFactor × participation_pct)
   *   - expectedConsumptionShopers = MGE / glasses_per_shoper(yield@today)
   *   - openingFromPrev          = previous business day's closingQty (or null)
   *   - transfersInQty           = sum of TRANSFER_IN movements at this branch
   *                                 on this business day (where StockMovement
   *                                 createdAt falls within the same calendar day)
   *
   * Excluded from the sums:
   *   - Items with excludeFromAutoReconciliation = true (Mix Fruit Juice + Shake)
   *   - Items with no participation rows defined (mocktails the owner hasn't tagged)
   *
   * This endpoint is read-only — it doesn't create or modify a reconciliation row.
   */
  app.get("/preview", async (req, reply) => {
    const q = z.object({
      branchId: z.coerce.bigint(),
      businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query", details: q.error.flatten() });

    const businessDate = new Date(`${q.data.businessDate.slice(0, 10)}T00:00:00Z`);
    const preview = await buildReconciliationPreview(q.data.branchId, businessDate);
    return toJson(preview);
  });

  /**
   * POST /reconciliation/open — morning manager confirms opening stock.
   *
   * Body: { branchId, businessDate, lines: [{ processedProductId, openingQty, overrideNote? }] }
   *
   * If there's no existing reconciliation for this (branch, businessDate), creates
   * one in DRAFT status with the supplied opening quantities.
   *
   * If one exists in DRAFT, refuses (use a PATCH endpoint later if we need to
   * support reopening — for now opening is a one-shot action).
   *
   * Each line's openingFromPrevClose is filled from the previous business day's
   * closing for that pulp at this branch, so the UI can detect overrides.
   */
  app.post("/open", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can open a reconciliation" });
    }
    const Body = z.object({
      branchId: z.coerce.bigint(),
      businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
      lines: z.array(z.object({
        processedProductId: z.coerce.bigint(),
        openingQty: z.coerce.number().nonnegative().max(1_000_000),
        overrideNote: z.string().max(500).optional(),
      })).max(200),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const businessDate = new Date(`${parsed.data.businessDate.slice(0, 10)}T00:00:00Z`);

    const existing = await prisma.stockReconciliation.findUnique({
      where: { branchId_businessDate: { branchId: parsed.data.branchId, businessDate } },
    });
    if (existing) {
      return reply.code(409).send({
        error: `Reconciliation already exists for branch ${parsed.data.branchId} on ${parsed.data.businessDate.slice(0, 10)} (status: ${existing.status})`,
        id: existing.id.toString(),
      });
    }

    // Find each pulp's previous closing (most recent CLOSED reconciliation before this date)
    const prevByPulp = new Map<string, Prisma.Decimal>();
    const prevRecon = await prisma.stockReconciliation.findFirst({
      where: { branchId: parsed.data.branchId, businessDate: { lt: businessDate }, status: "CLOSED" },
      orderBy: { businessDate: "desc" },
      include: { lines: true },
    });
    if (prevRecon) {
      for (const ln of prevRecon.lines) {
        if (ln.closingQty != null) prevByPulp.set(ln.processedProductId.toString(), ln.closingQty);
      }
    }

    // Pull yields so we can snapshot glasses-per-shoper on each line
    const yieldByPulp = await activeYieldByPulp(parsed.data.branchId, businessDate);

    const created = await prisma.$transaction(async (tx) => {
      const header = await tx.stockReconciliation.create({
        data: {
          branchId: parsed.data.branchId,
          businessDate,
          status: "DRAFT",
          openingConfirmedById: BigInt(req.auth!.sub),
          openingConfirmedAt: new Date(),
        },
      });
      for (const ln of parsed.data.lines) {
        const fromPrev = prevByPulp.get(ln.processedProductId.toString()) ?? null;
        const yieldRow = yieldByPulp.get(ln.processedProductId.toString());
        await tx.stockReconciliationLine.create({
          data: {
            reconciliationId: header.id,
            processedProductId: ln.processedProductId,
            openingQty: new Prisma.Decimal(ln.openingQty),
            openingFromPrevClose: fromPrev,
            glassesPerShoperUsed: yieldRow ?? new Prisma.Decimal(0),
          },
        });
        // If the manager's opening differs meaningfully from the previous closing,
        // capture the override note on the header so the owner can see it.
        if (fromPrev != null && Math.abs(Number(fromPrev) - ln.openingQty) > 0.001 && ln.overrideNote) {
          await tx.stockReconciliation.update({
            where: { id: header.id },
            data: { openingOverrideNote: ln.overrideNote },
          });
        }
      }
      return header;
    });

    await writeAudit({
      req, branchId: parsed.data.branchId,
      action: "reconciliation.open", entityType: "StockReconciliation", entityId: created.id,
      after: { businessDate: parsed.data.businessDate.slice(0, 10), lineCount: parsed.data.lines.length },
    });

    return toJson({ id: created.id.toString(), status: created.status });
  });

  /**
   * POST /reconciliation/:id/close
   *
   * Body: { lines: [{ id, closingQty, reasonCode?, reasonNotes? }], notes? }
   *
   * For each line: compute expected consumption from sales + transfers, expected
   * close, variance, and variance pct. Reasons are REQUIRED on any line where
   * |variancePct| > 5%. Sets status:
   *   - all good       -> CLOSED
   *   - missing reasons -> PENDING_REASONS (cashier can complete later)
   */
  app.post("/:id/close", async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: "Unauthenticated" });
    if (!canWrite(req.auth.roles.map((r) => r.code))) {
      return reply.code(403).send({ error: "Only OWNER / BRANCH_MANAGER / ACCOUNTANT can close a reconciliation" });
    }
    const id = BigInt((req.params as { id: string }).id);
    const Body = z.object({
      lines: z.array(z.object({
        id: z.coerce.bigint(),
        closingQty: z.coerce.number().nonnegative().max(1_000_000),
        reasonCode: z.string().max(40).optional(),
        reasonNotes: z.string().max(500).optional(),
      })).max(200),
      notes: z.string().max(500).optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });

    const header = await prisma.stockReconciliation.findUnique({
      where: { id },
      include: { lines: { include: { processedProduct: true } } },
    });
    if (!header) return reply.code(404).send({ error: "Reconciliation not found" });
    if (header.status === "CLOSED") {
      return reply.code(409).send({ error: "Reconciliation is already CLOSED" });
    }

    // Compute the math engine's per-pulp consumption for this business day
    const preview = await buildReconciliationPreview(header.branchId, header.businessDate);
    const consumptionByPulp = new Map(preview.lines.map((l) => [l.processedProductId, l]));

    const incomingByLineId = new Map(parsed.data.lines.map((l) => [l.id.toString(), l]));
    let missingReasonCount = 0;

    await prisma.$transaction(async (tx) => {
      for (const line of header.lines) {
        const incoming = incomingByLineId.get(line.id.toString());
        if (!incoming) continue;   // skip lines the UI didn't return (shouldn't happen)
        const closing = new Prisma.Decimal(incoming.closingQty);
        const cm = consumptionByPulp.get(line.processedProductId.toString());
        const expectedMGE = cm ? new Prisma.Decimal(cm.expectedConsumptionMGE) : new Prisma.Decimal(0);
        const yieldPerShoper = line.glassesPerShoperUsed.greaterThan(0) ? line.glassesPerShoperUsed : new Prisma.Decimal(1);
        const expectedShopers = expectedMGE.dividedBy(yieldPerShoper);
        const expectedClose = line.openingQty.plus(line.transfersInQty).minus(expectedShopers);
        const variance = closing.minus(expectedClose);
        const variancePct = expectedClose.greaterThan(0)
          ? variance.dividedBy(expectedClose).times(100)
          : new Prisma.Decimal(0);

        // Reason required when |variancePct| > 5
        const significant = variancePct.abs().greaterThan(5);
        if (significant && !incoming.reasonCode) {
          missingReasonCount++;
        }

        await tx.stockReconciliationLine.update({
          where: { id: line.id },
          data: {
            closingQty: closing,
            expectedConsumptionMGE: expectedMGE,
            expectedConsumptionShopers: expectedShopers,
            expectedCloseQty: expectedClose,
            varianceQty: variance,
            variancePct,
            reasonCode: incoming.reasonCode ?? null,
            reasonNotes: incoming.reasonNotes ?? null,
            reasonRecordedById: incoming.reasonCode ? BigInt(req.auth!.sub) : null,
            reasonRecordedAt: incoming.reasonCode ? new Date() : null,
          },
        });
      }
      await tx.stockReconciliation.update({
        where: { id },
        data: {
          status: missingReasonCount > 0 ? "PENDING_REASONS" : "CLOSED",
          closedById: missingReasonCount > 0 ? null : BigInt(req.auth!.sub),
          closedAt: missingReasonCount > 0 ? null : new Date(),
          notes: parsed.data.notes ?? null,
        },
      });
    });

    await writeAudit({
      req, branchId: header.branchId,
      action: "reconciliation.close", entityType: "StockReconciliation", entityId: id,
      after: { status: missingReasonCount > 0 ? "PENDING_REASONS" : "CLOSED", missingReasonCount },
    });

    return toJson({ id: id.toString(), status: missingReasonCount > 0 ? "PENDING_REASONS" : "CLOSED", missingReasonCount });
  });

  /** GET /reconciliation/list — recent reconciliations for a branch. */
  app.get("/list", async (req, reply) => {
    const q = z.object({
      branchId: z.coerce.bigint(),
      limit: z.coerce.number().int().min(1).max(60).default(30),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query" });

    const rows = await prisma.stockReconciliation.findMany({
      where: { branchId: q.data.branchId },
      orderBy: { businessDate: "desc" },
      take: q.data.limit,
      include: {
        _count: { select: { lines: true } },
        closedBy: { select: { fullName: true } },
      },
    });
    return toJson({
      reconciliations: rows.map((r) => ({
        id: r.id.toString(),
        businessDate: r.businessDate.toISOString().slice(0, 10),
        status: r.status,
        lineCount: r._count.lines,
        closedBy: r.closedBy?.fullName ?? null,
        closedAt: r.closedAt,
      })),
    });
  });

  /** GET /reconciliation/:id — single reconciliation with all lines. */
  app.get("/:id", async (req, reply) => {
    const id = BigInt((req.params as { id: string }).id);
    const row = await prisma.stockReconciliation.findUnique({
      where: { id },
      include: {
        lines: { include: { processedProduct: { select: { id: true, name: true, storageUnit: true } } }, orderBy: { processedProduct: { name: "asc" } } },
        closedBy: { select: { fullName: true } },
        openingConfirmedBy: { select: { fullName: true } },
        branch: { select: { id: true, code: true, name: true } },
      },
    });
    if (!row) return reply.code(404).send({ error: "Reconciliation not found" });
    return toJson({
      id: row.id.toString(),
      businessDate: row.businessDate.toISOString().slice(0, 10),
      status: row.status,
      branch: { id: row.branch.id.toString(), code: row.branch.code, name: row.branch.name },
      openingConfirmedBy: row.openingConfirmedBy?.fullName ?? null,
      openingConfirmedAt: row.openingConfirmedAt,
      openingOverrideNote: row.openingOverrideNote,
      closedBy: row.closedBy?.fullName ?? null,
      closedAt: row.closedAt,
      notes: row.notes,
      lines: row.lines.map((ln) => ({
        id: ln.id.toString(),
        pulp: { id: ln.processedProduct.id.toString(), name: ln.processedProduct.name, storageUnit: ln.processedProduct.storageUnit },
        openingQty: ln.openingQty.toString(),
        openingFromPrevClose: ln.openingFromPrevClose?.toString() ?? null,
        transfersInQty: ln.transfersInQty.toString(),
        glassesPerShoperUsed: ln.glassesPerShoperUsed.toString(),
        expectedConsumptionMGE: ln.expectedConsumptionMGE?.toString() ?? null,
        expectedConsumptionShopers: ln.expectedConsumptionShopers?.toString() ?? null,
        expectedCloseQty: ln.expectedCloseQty?.toString() ?? null,
        closingQty: ln.closingQty?.toString() ?? null,
        varianceQty: ln.varianceQty?.toString() ?? null,
        variancePct: ln.variancePct?.toString() ?? null,
        reasonCode: ln.reasonCode,
        reasonNotes: ln.reasonNotes,
      })),
    });
  });
}

// ─── Math engine helpers ──────────────────────────────────────────────

/**
 * Build the per-pulp consumption preview for a (branch, businessDate).
 *
 * For every PAID OrderItem on this branch + businessDate:
 *   if item.excludeFromAutoReconciliation -> skip
 *   for each (pulp, pct) in item.participations:
 *     contribute (qty × sizeFactor × pct/100) to that pulp's MGE total
 * Then divide each pulp's MGE by its active glasses-per-shoper to get the
 * expected consumption in shopers.
 */
async function buildReconciliationPreview(branchId: bigint, businessDate: Date) {
  // Pull every PAID OrderItem on this business day, with size + participations + exclusion flag.
  // Mix lines also carry isCustomMix + customMixComponents so we can split MGE across all N
  // pulps instead of attributing 100% to the anchor (alphabetically-first) item.
  const orderItems = await prisma.orderItem.findMany({
    where: { order: { branchId, businessDate, status: "PAID" } },
    select: {
      qty: true,
      isCustomMix: true,
      customMixComponents: true,
      item: {
        select: {
          id: true, itemCode: true, name: true, size: true, excludeFromAutoReconciliation: true,
          participations: { select: { processedProductId: true, participationPct: true } },
        },
      },
    },
  });

  // For custom mixes we need participations for the OTHER N-1 components too — pre-fetch them
  // once for all distinct component codes referenced by any mix line on this day.
  const mixComponentCodes = new Set<number>();
  for (const oi of orderItems) {
    if (!oi.isCustomMix || !Array.isArray(oi.customMixComponents)) continue;
    for (const c of oi.customMixComponents as Array<{ itemCode?: number }>) {
      if (typeof c.itemCode === "number") mixComponentCodes.add(c.itemCode);
    }
  }
  const componentItems = mixComponentCodes.size === 0 ? [] : await prisma.item.findMany({
    where: { itemCode: { in: [...mixComponentCodes] } },
    select: {
      itemCode: true,
      excludeFromAutoReconciliation: true,
      participations: { select: { processedProductId: true, participationPct: true } },
    },
  });
  const componentByCode = new Map(componentItems.map((it) => [it.itemCode, it]));

  // Sum MGE per pulp.
  const mgeByPulp = new Map<string, Prisma.Decimal>();
  const addContribution = (
    mgeBase: Prisma.Decimal,
    participations: { processedProductId: bigint; participationPct: Prisma.Decimal }[],
  ) => {
    for (const p of participations) {
      const pulpKey = p.processedProductId.toString();
      const contribution = mgeBase.times(p.participationPct).dividedBy(100);
      mgeByPulp.set(pulpKey, (mgeByPulp.get(pulpKey) ?? new Prisma.Decimal(0)).plus(contribution));
    }
  };
  for (const oi of orderItems) {
    const sizeFactor = oi.item.size === "JUMBO" ? new Prisma.Decimal("1.5") : new Prisma.Decimal(1);
    const mgeBase = oi.qty.times(sizeFactor);

    if (oi.isCustomMix && Array.isArray(oi.customMixComponents) && oi.customMixComponents.length >= 2) {
      // Split MGE evenly across all N components — each contributes (mgeBase / N) weighted
      // by that component's own per-pulp participation percentages.
      const codes = (oi.customMixComponents as Array<{ itemCode?: number }>)
        .map((c) => c.itemCode)
        .filter((n): n is number => typeof n === "number");
      if (codes.length === 0) continue;
      const perComponent = mgeBase.dividedBy(codes.length);
      for (const code of codes) {
        const comp = componentByCode.get(code);
        if (!comp || comp.excludeFromAutoReconciliation) continue;
        addContribution(perComponent, comp.participations);
      }
    } else {
      if (oi.item.excludeFromAutoReconciliation) continue;
      if (oi.item.participations.length === 0) continue;
      addContribution(mgeBase, oi.item.participations);
    }
  }

  // Pull all pulps so the preview returns a complete pulp list (zero-MGE rows too).
  const pulps = await prisma.processedProduct.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, storageUnit: true },
  });
  const yieldByPulp = await activeYieldByPulp(branchId, businessDate);

  return {
    branchId: branchId.toString(),
    businessDate: businessDate.toISOString().slice(0, 10),
    lines: pulps.map((p) => {
      const mge = mgeByPulp.get(p.id.toString()) ?? new Prisma.Decimal(0);
      const yieldRow = yieldByPulp.get(p.id.toString()) ?? new Prisma.Decimal(0);
      const shopers = yieldRow.greaterThan(0) ? mge.dividedBy(yieldRow) : new Prisma.Decimal(0);
      return {
        processedProductId: p.id.toString(),
        pulp: { id: p.id.toString(), name: p.name, storageUnit: p.storageUnit },
        expectedConsumptionMGE: mge.toFixed(3),
        glassesPerShoper: yieldRow.toFixed(2),
        expectedConsumptionShopers: shopers.toFixed(3),
      };
    }),
  };
}

/**
 * Lookup the active glasses-per-shoper for each pulp at this branch on this date.
 * Per-branch overrides beat org-wide; newer effectiveFrom beats older.
 */
async function activeYieldByPulp(branchId: bigint, businessDate: Date): Promise<Map<string, Prisma.Decimal>> {
  const configs = await prisma.yieldConfig.findMany({
    where: {
      effectiveFrom: { lte: businessDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: businessDate } }],
      AND: [{ OR: [{ branchId }, { branchId: null }] }],
    },
    orderBy: [{ branchId: { sort: "desc", nulls: "last" } }, { effectiveFrom: "desc" }],
  });
  const out = new Map<string, Prisma.Decimal>();
  for (const c of configs) {
    const k = c.processedProductId.toString();
    if (!out.has(k)) out.set(k, c.glassesPerShoper);
  }
  return out;
}
