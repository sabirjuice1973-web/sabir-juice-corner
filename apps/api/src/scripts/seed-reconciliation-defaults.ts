/**
 * One-shot data-prep script for the inventory-reconciliation system.
 *
 * What it does (idempotent — safe to re-run):
 *   1. Flags Items 39, 40, 151, 152 with excludeFromAutoReconciliation = true.
 *      (Mix Fruit Juice + Mix Fruit Shake — owner tracks them separately.)
 *
 *   2. Discovers every distinct FRUIT NAME used across active Items in the
 *      reconciliation-participating categories (Fresh Juices, Milk Shakes,
 *      MIX, SEASONAL). For each new fruit, upserts a ProcessedProduct row
 *      with name "<Fruit> Pulp" so we have a stockable target.
 *
 *   3. Auto-creates ItemParticipation rows for every active Item in those
 *      categories using the simple name-parsing rule:
 *        - Single name        -> 100% of the matching fruit pulp
 *        - "A + B"            -> 50% each
 *        - "A + B + C"        -> 33.33% A, 33.33% B, 33.34% C  (last absorbs rounding)
 *        - "A + B + C + D"    -> 25% each
 *      Components that don't match any known fruit are skipped silently — owner
 *      reviews/overrides on the participation admin screen.
 *
 *   4. Seeds a default YieldConfig of 10 glasses per shoper (org-wide, effective
 *      from today) for every ProcessedProduct that has no active YieldConfig.
 *      Owner edits these on the yield admin screen.
 *
 * Categories that participate (per owner spec):
 *   JUICE (Fresh Juices), SHAKE (Milk Shakes), MIX (Peach+Plum etc.), SEASONAL
 *
 * Excluded categories:
 *   ICE_CREAM, TEA_COFFEE, LASSI, MOCKTAIL, WATER_SOFT, MISC
 *
 * Usage:
 *   pnpm --filter @sjc/api exec tsx src/scripts/seed-reconciliation-defaults.ts
 *       -> DRY RUN
 *   pnpm --filter @sjc/api exec tsx src/scripts/seed-reconciliation-defaults.ts --apply
 *       -> APPLY
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@sjc/db";

const APPLY = process.argv.includes("--apply");
// When --create-pulps is passed, the script will materialize ProcessedProduct
// rows for every distinct fruit token discovered from item names AND auto-seed
// ItemParticipation rows. Without the flag, those steps are PURELY ADVISORY —
// the script prints the discovered tokens grouped by "likely real fruit" vs
// "likely specialty/mocktail/dry-additive" so the owner can curate which ones
// are real shoper-tracked pulps before any DB writes happen.
const CREATE_PULPS = process.argv.includes("--create-pulps");

const PARTICIPATING_CATEGORIES = ["JUICE", "SHAKE", "MIX", "SEASONAL"];
const EXCLUDED_ITEM_CODES = [39, 40, 151, 152];

// Tokens we'll never materialize as a "pulp" even if --create-pulps is passed.
// These are mocktail names, branded "royal drink" specials, ice-cream/dessert
// additives, and dry ingredients — all of which have a different stock model
// from shoper pulp.
const NOT_A_PULP = new Set([
  // mocktails / branded "royal drink" specials (owner confirmed)
  "pink lady", "hawaian dream", "singapore supreme", "planter punch",
  "sabir special", "clipping queen", "fruit punch", "fruite punch",
  "mint margarita", "pinacolada",
  "dawn strawberry", "pineapple fizz",          // royal drinks
  "peach mariner",                              // royal drink, NOT regular peach
  "jamakal jaman", "jamakel jaman",             // royal drinks, NOT regular jaman
  "power", "energy",
  // discontinued / disabled in catalogue (owner manually disabled)
  "thailand mix fruit",
  // dessert / dry additives
  "oreo", "chocolate", "ice cream", "khoya dates", "meetha",
  // nuts and dry ingredients tracked elsewhere
  "almond", "cashew", "pista", "walnuts", "dates", "enjeer",
  // brand-name soft drinks
  "limka",
  // not a juice ingredient
  "lime",
  // catalogue noise
  "lat no 221 245 asif",
  // mixfruite typo/duplicate of the excluded special item (handled by exclusion flag)
  "mixfruite", "mix fruite",
]);

// Tokens we know ARE real shoper-tracked fruits (owner confirmed).
// Pomegranate Red, White, and B-Dana are THREE separate pulps with their own
// shopers — kept as distinct tokens.
const KNOWN_FRUIT = new Set([
  "peach", "plum", "cherry", "mango", "apple", "banana", "strawberry",
  "pineapple", "lychee", "falsa", "guava", "orange",
  "grapes", "jaman", "persimmon", "carrot", "papaya",
  "musammi", "chico", "pomelo", "singhara",
  "pomegranate white", "pomegranate red", "pomegranate b dana",
]);

// Token aliases — a discovered token doesn't map to a single fruit, but expands
// to one or more existing pulps with weights. Lets us cope with word-order
// variants ("red pomegranate" vs "pomegranate red"), compound items that draw
// from the full amount of a pulp ("coconut pineapple" = full pineapple), and
// blends that mix two known pulps in fixed ratios ("mix pomegranate" = 50/50).
// Weights must sum to 1.0 per alias.
type AliasExpansion = { canon: string; weight: number };
const TOKEN_ALIASES = new Map<string, AliasExpansion[]>([
  // "Coconut Pineapple" is sold as essentially Pineapple with coconut garnish —
  // pulp consumption is 100% pineapple (owner confirmed).
  ["coconut pineapple", [{ canon: "pineapple", weight: 1.0 }]],
  // Word-order variants of the three Pomegranate pulps. Owner said the catalogue
  // has both orders; we normalize to the existing pulp names here.
  ["red pomegranate", [{ canon: "pomegranate red", weight: 1.0 }]],
  ["white pomegranate", [{ canon: "pomegranate white", weight: 1.0 }]],
  // "Mix Pomegranate" is a blend item: 50% white + 50% red (owner confirmed).
  ["mix pomegranate", [
    { canon: "pomegranate white", weight: 0.5 },
    { canon: "pomegranate red", weight: 0.5 },
  ]],
]);

// "Stop words" that are descriptive modifiers, not fruit names. Stripped when
// matching component names against the fruit pulp catalogue.
const STOP_WORDS = new Set([
  "juice", "shake", "drink", "fresh", "cold", "hot", "iced",
  "medium", "jumbo", "large", "small",
  "with", "and",
]);

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip size suffix + stop-word descriptors so we get the canonical fruit token.
 *   "Peach Juice Medium" -> "peach"
 *   "Cherry Juice"       -> "cherry"
 *   "Banana Shake"       -> "banana"
 *   "Cold Drink"         -> ""        (all stop-words; skipped)
 */
function canonicalize(componentName: string): string {
  const tokens = normalizeName(componentName).split(" ").filter((t) => t && !STOP_WORDS.has(t));
  return tokens.join(" ").trim();
}

/**
 * Split an Item name into components.
 *   "Peach"           -> ["Peach"]
 *   "Peach+Plum"      -> ["Peach", "Plum"]
 *   "Peach + Plum"    -> ["Peach", "Plum"]
 *   "Peach+Plum+Falsa Jumbo" -> ["Peach", "Plum", "Falsa Jumbo"]  (size cleaned later)
 */
function splitComponents(itemName: string): string[] {
  return itemName.split("+").map((s) => s.trim()).filter(Boolean);
}

/**
 * For 3-way split, return [33.33, 33.33, 33.34] so the last absorbs rounding
 * and the row sums to exactly 100. For any N: each = 100/N rounded down to
 * 2 decimals, last = 100 - sum(others).
 */
function evenSplit(n: number): number[] {
  if (n <= 0) return [];
  const per = Math.floor((100 / n) * 100) / 100; // floor to 2dp
  const rows = new Array(n - 1).fill(per);
  const last = +(100 - per * (n - 1)).toFixed(2);
  rows.push(last);
  return rows;
}

async function main() {
  console.log(`\n=== Reconciliation seed ${APPLY ? "[APPLY]" : "[DRY RUN]"} ===\n`);

  // ── Step 1: flag Mix Fruit Juice + Mix Fruit Shake as excluded ────────
  const excludedItems = await prisma.item.findMany({
    where: { itemCode: { in: EXCLUDED_ITEM_CODES } },
    select: { id: true, itemCode: true, name: true, excludeFromAutoReconciliation: true },
  });
  let excludeFlipped = 0;
  for (const it of excludedItems) {
    if (!it.excludeFromAutoReconciliation) {
      console.log(`  Flag #${it.itemCode} ${it.name} -> excludeFromAutoReconciliation = true`);
      if (APPLY) {
        await prisma.item.update({ where: { id: it.id }, data: { excludeFromAutoReconciliation: true } });
      }
      excludeFlipped++;
    }
  }
  const missingCodes = EXCLUDED_ITEM_CODES.filter((c) => !excludedItems.find((e) => e.itemCode === c));
  if (missingCodes.length > 0) {
    console.log(`  NOTE: codes ${missingCodes.join(", ")} not in catalogue (Mix Fruit not seeded yet?)`);
  }
  console.log(`Step 1: ${excludeFlipped} items flagged excluded (${excludedItems.length - excludeFlipped} already were)\n`);

  // ── Step 2: pull all active Items in participating categories ─────────
  const items = await prisma.item.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      excludeFromAutoReconciliation: false,
      category: { name: { in: PARTICIPATING_CATEGORIES.map(catCodeToName) } },
    },
    include: { category: true, participations: true },
  });
  console.log(`Loaded ${items.length} active items in participating categories`);

  // ── Step 3: discover fruit-token candidates from item names ───────────
  const tokens = new Map<string, Set<string>>();
  for (const it of items) {
    for (const c of splitComponents(it.name)) {
      const canon = canonicalize(c);
      if (!canon) continue;
      if (!tokens.has(canon)) tokens.set(canon, new Set());
      tokens.get(canon)!.add(c);
    }
  }

  // Classify each discovered token:
  //   KNOWN     = on the KNOWN_FRUIT whitelist -> safe to materialize as a pulp
  //   NOT_PULP  = on the NOT_A_PULP blacklist  -> never create
  //   UNCLEAR   = neither list -> owner must confirm before we materialize
  const known: string[] = [];
  const notPulp: string[] = [];
  const unclear: string[] = [];
  for (const canon of tokens.keys()) {
    if (KNOWN_FRUIT.has(canon))      known.push(canon);
    else if (NOT_A_PULP.has(canon))  notPulp.push(canon);
    else                              unclear.push(canon);
  }
  known.sort(); notPulp.sort(); unclear.sort();
  console.log(`Discovered ${tokens.size} distinct tokens across ${items.length} items:`);
  console.log(`  KNOWN fruit (${known.length}):    ${known.join(", ") || "(none)"}`);
  console.log(`  NOT a pulp (${notPulp.length}):   ${notPulp.join(", ") || "(none)"}`);
  console.log(`  UNCLEAR (${unclear.length}):       ${unclear.join(", ") || "(none)"}`);
  console.log();

  // Only materialize pulps when --create-pulps is passed AND the token is on
  // the KNOWN_FRUIT whitelist. UNCLEAR tokens are advisory-only here.
  const existingPulps = await prisma.processedProduct.findMany();
  const existingByCanon = new Map(existingPulps.map((p) => [canonicalize(p.name.replace(/\bpulp\b/i, "")), p]));

  const pulpByCanon = new Map<string, { id: bigint; name: string }>();
  for (const [canon, pp] of existingByCanon) {
    pulpByCanon.set(canon, { id: pp.id, name: pp.name });
  }

  let pulpsCreated = 0;
  if (CREATE_PULPS) {
    for (const canon of known) {
      if (pulpByCanon.has(canon)) continue;
      const titleCase = canon.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
      const pulpName = `${titleCase} Pulp`;
      console.log(`  + ProcessedProduct: ${pulpName}`);
      if (APPLY) {
        const created = await prisma.processedProduct.create({
          data: {
            name: pulpName,
            storageUnit: "shoper",
            defaultGlassesPerUnit: new Prisma.Decimal(10),
            shelfLifeDays: 5,
            isActive: true,
          },
        });
        pulpByCanon.set(canon, { id: created.id, name: created.name });
      } else {
        pulpByCanon.set(canon, { id: -1n, name: pulpName });
      }
      pulpsCreated++;
    }
  }
  console.log(`Step 3: ${pulpsCreated} pulps would be created. ${CREATE_PULPS ? "" : "(re-run with --create-pulps to materialize KNOWN_FRUIT tokens)"}\n`);

  // ── Step 4: auto-create ItemParticipation rows ────────────────────────
  // For each item we compute the expected per-pulp percentage map by parsing
  // the item name. A component can:
  //   • Match a KNOWN fruit pulp directly        -> full slice goes to that pulp
  //   • Match a TOKEN_ALIAS expansion             -> slice is split across the
  //                                                  alias's listed pulps by weight
  //   • Not match either                          -> skipped, owner backfills via admin
  // Multiple components on the same item that resolve to the SAME pulp are
  // aggregated (rare but possible — e.g. "Red Pomegranate + Pomegranate Red").
  //
  // Idempotency: the script creates only (item, pulp) rows that don't yet
  // exist. Existing rows are NEVER overwritten — owner may have hand-tuned them.
  let partsCreated = 0;
  let partsSkippedExisting = 0;
  let partsSkippedNoMatch = 0;
  if (CREATE_PULPS) {
    for (const it of items) {
      const existingPulpIds = new Set(it.participations.map((p) => p.processedProductId.toString()));
      const comps = splitComponents(it.name);
      const N = comps.length;
      const slice = evenSplit(N);   // per-component slice of 100% for this item

      // Build pulpId -> aggregated percentage for this item.
      const itemMap = new Map<string, { pulpId: bigint; pct: number }>();
      let resolvedAny = false;
      for (let i = 0; i < N; i++) {
        const canon = canonicalize(comps[i]);
        if (!canon) continue;
        // Resolve to one-or-more pulps + weights via direct match or alias.
        const targets: AliasExpansion[] = pulpByCanon.has(canon)
          ? [{ canon, weight: 1.0 }]
          : (TOKEN_ALIASES.get(canon) ?? []);
        if (targets.length === 0) {
          partsSkippedNoMatch++;
          continue;
        }
        for (const t of targets) {
          const pulp = pulpByCanon.get(t.canon);
          if (!pulp || pulp.id <= 0n) continue;   // alias resolves to an unmaterialized pulp; skip
          const pct = slice[i] * t.weight;        // slice for this component × alias weight
          const key = pulp.id.toString();
          if (itemMap.has(key)) itemMap.get(key)!.pct += pct;
          else itemMap.set(key, { pulpId: pulp.id, pct });
          resolvedAny = true;
        }
      }
      if (!resolvedAny) continue;

      // Round each accumulated pct to 4 decimals, then absorb any tiny drift
      // into the largest row so the total sums to the expected slice total.
      const rows = [...itemMap.values()].map((r) => ({ ...r, pct: +r.pct.toFixed(4) }));
      const sumExpected = +slice.reduce((s, x) => s + x, 0).toFixed(4);
      const sumActual = +rows.reduce((s, r) => s + r.pct, 0).toFixed(4);
      const drift = +(sumExpected - sumActual).toFixed(4);
      if (Math.abs(drift) >= 0.0001 && rows.length > 0) {
        const biggest = rows.reduce((a, b) => (a.pct >= b.pct ? a : b));
        biggest.pct = +(biggest.pct + drift).toFixed(4);
      }

      // Create rows we don't already have for this item.
      for (const r of rows) {
        if (existingPulpIds.has(r.pulpId.toString())) {
          partsSkippedExisting++;
          continue;
        }
        if (APPLY) {
          await prisma.itemParticipation.create({
            data: {
              itemId: it.id,
              processedProductId: r.pulpId,
              participationPct: new Prisma.Decimal(r.pct),
              isAutoSeeded: true,
            },
          });
        }
        partsCreated++;
      }
    }
    console.log(`Step 4: ${partsCreated} ItemParticipation rows to create`);
    console.log(`        ${partsSkippedExisting} existing rows left untouched`);
    console.log(`        ${partsSkippedNoMatch} components had no matching pulp (owner backfills)\n`);
  } else {
    console.log(`Step 4: skipped (gated on --create-pulps)\n`);
  }

  // ── Step 5: seed default YieldConfig at 10 glasses/shoper ─────────────
  const allPulps = APPLY
    ? await prisma.processedProduct.findMany({ include: { yieldConfigs: { where: { effectiveTo: null } } } })
    : existingPulps.map((p) => ({ ...p, yieldConfigs: [] as any[] }));
  let yieldsSeeded = 0;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (const p of allPulps) {
    if ((p as any).yieldConfigs.length > 0) continue;
    console.log(`  + YieldConfig for ${p.name}: 10 glasses/shoper effective from ${today.toISOString().slice(0, 10)}`);
    if (APPLY) {
      await prisma.yieldConfig.create({
        data: {
          processedProductId: p.id,
          branchId: null,
          glassesPerShoper: new Prisma.Decimal(10),
          effectiveFrom: today,
          notes: "Default seeded value. Edit on the Yield Config admin screen.",
        },
      });
    }
    yieldsSeeded++;
  }
  console.log(`Step 5: ${yieldsSeeded} default YieldConfigs to create\n`);

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`=== Summary ===`);
  console.log(`  Items flagged excluded:           ${excludeFlipped}`);
  console.log(`  ProcessedProducts (pulps) created: ${pulpsCreated}`);
  console.log(`  ItemParticipation rows created:   ${partsCreated}`);
  console.log(`  Default yields created:           ${yieldsSeeded}`);
  console.log(`  Components without a matching pulp: ${partsSkippedNoMatch}`);
  if (!APPLY) {
    console.log(`\n(no writes — re-run with --apply to commit)`);
  } else {
    console.log(`\nDone. Owner should now visit:`);
    console.log(`  1. Yield Config admin screen -> verify each pulp's glasses-per-shoper.`);
    console.log(`  2. Item Participation admin screen -> spot-check the auto-seeded rows.`);
  }
}

/**
 * Map our internal category code to the actual display name used in the
 * Category table at the live database. Names come from the imported menu,
 * NOT from menu.json seed (the user re-imported via the XLSX importer).
 * Verified live: 'Fresh Juices' / 'Shakes' / 'Mixes' / 'Lassi' / 'Mocktails' etc.
 */
function catCodeToName(code: string): string {
  switch (code) {
    case "JUICE":      return "Fresh Juices";
    case "SHAKE":      return "Shakes";
    case "MIX":        return "Mixes";        // was "Mix Drinks" — wrong
    case "SEASONAL":   return "Seasonal";     // no such category in live DB yet, harmless
    default:           return code;
  }
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
