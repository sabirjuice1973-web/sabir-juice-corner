# Sabir Juice Corner — ERP/POS

Multi-branch ERP/POS for **Sabir Juice Corner** (Multan, founded 1973). Built for a juice business where the operational loop is **raw fruit → central processing → pulp/shopers → branch consumption → flexible recipes**. Not a generic restaurant POS.

> **Status:** Phase 0 scaffold. Database, seed data, and a minimal API are live. POS and Admin UIs are next.

## Repository layout

```
.
├── apps/
│   ├── api/                NestJS-style Fastify API   (port 4000)
│   ├── pos/                Cashier POS PWA           (port 3000)  ← next
│   └── admin/              Owner + Manager web        (port 3100)  ← next
├── packages/
│   └── db/                 Prisma schema, client, seeds
├── docker-compose.yml      Postgres (+ optional pgAdmin)
├── .env.example            Copy to .env and edit
└── README.md
```

## Prerequisites

- **Node.js** 20+ ✓
- **pnpm** 9+ — install with: `npm install -g pnpm`
- **Docker Desktop** — required, must be **running** before `pnpm db:up`
- **Git** ✓

### If Docker Desktop won't start (Windows)

If `docker info` shows "Docker Desktop is unable to start":

1. Open Docker Desktop from the Start menu and wait for the whale icon to be steady (not animating)
2. If still failing: open PowerShell **as Administrator** and run:
   ```powershell
   wsl --update
   wsl --shutdown
   ```
   then restart Docker Desktop
3. If WSL2 isn't installed, follow https://learn.microsoft.com/en-us/windows/wsl/install
4. As a last resort, install PostgreSQL 16 natively from https://www.postgresql.org/download/windows/ and update `DATABASE_URL` in `.env` to point at it (port 5432, db `sjc_erp`)

## First-time setup (5 minutes)

```powershell
# 1. Copy the env file and edit secrets later
copy .env.example .env

# 2. Install dependencies
pnpm install

# 3. Start Postgres
pnpm db:up

# 4. Apply schema + generate Prisma client
pnpm db:generate
pnpm db:migrate

# 5. Seed reference data + menu items
pnpm db:seed

# 6. Run the API
pnpm --filter @sjc/api dev
```

Then in a browser:

- `http://localhost:4000/api/v1/health`     → `{ "status": "ok" }`
- `http://localhost:4000/api/v1/health/db`  → counts of orgs / items / branches
- `http://localhost:4000/api/v1/items/by-code/1` → Apple Medium 320 PKR

Login (dev only): `admin` / `ChangeMe!2026`. **Change this immediately** before any non-dev use.

## Useful scripts

| Command | What it does |
|---|---|
| `pnpm db:up` / `db:down` | Start / stop Postgres in Docker |
| `pnpm db:logs` | Tail the Postgres logs |
| `pnpm db:migrate` | Create + apply a new migration (interactive name prompt) |
| `pnpm db:reset` | **Destructive** — drop everything and re-seed |
| `pnpm db:studio` | Open Prisma Studio at `:5555` to browse data |
| `docker compose --profile tools up -d pgadmin` | Browse DB visually at `:5050` |

## What is built now (Phases 0 + 1)

### Phase 0 — Foundation
- **Database schema** covering all MVP modules (catalog, units, raw materials, processed products, batches, stock locations & movements, transfers, suppliers, purchases, GRN, payments, shifts, orders & payments, expenses, salaries, alerts, AI conversations, audit log).
- **Seed data**: org, roles + permissions, units, categories, ~165 menu items from your image (flagged for verification), central kitchen + 3 placeholder branches, admin user.

### Phase 1A — Backend billing core (API)
- Real **bcrypt** password hashing with transparent upgrade from any legacy hashes.
- **JWT** access + refresh tokens. Sessions stored in DB so logout actually revokes.
- **Auth guards**: `requireAuth`, `requirePermission(...)`, `requireBranchAccess(...)`.
- **Audit log** writer used by every sensitive action (void, discount, shift close, login).
- **Shifts**: open, close (with auto-computed expected cash + variance), current, list.
- **Orders**: create, add line items (price captured at add-time), remove line, apply discount (10% threshold gated by `POS_DISCOUNT_LARGE` permission), multi-payment, void, list filtered by branch / shift / box / status.
- **Daily numbering**: `B{branchId}-YYYYMMDD-NNNN` per branch per day.

### Phase 1B — POS PWA (cashier UI)
- **Vite + React + Tailwind** at [http://localhost:3000](http://localhost:3000).
- Login → branch + shift gate → billing screen.
- **Item-code-first** entry, large numeric input optimised for keyboard counter-use.
- **7 waiter boxes** with live totals; switch boxes without losing in-progress orders.
- Name search popover with ×N quantity shortcuts.
- Pay dialog: Cash / Card / Wallet, with **live change calculation** and quick-tender presets.
- Receipt modal with print button (browser print → ESC/POS upgrade comes later).
- Day-close dialog with cash count → variance recorded automatically.

### One-command sanity check
```powershell
node scripts/smoke-test.mjs
```
Runs the full happy path (login → shift → order → discount → pay → close) plus negative-cases. Expect all assertions to pass.

### Phase 2 — The closed loop (procurement → production → transfer → sale → leakage detection)
- **StockService** — single chokepoint for all stock changes, always atomic with `StockMovement` audit row
- **Raw materials** CRUD + reorder thresholds
- **Suppliers** CRUD + ledger + payments
- **Purchase orders + GRN** with partial-receipt flow (PO auto-transitions OPEN → PARTIALLY_RECEIVED → RECEIVED)
- **Production batches** — raw fruit → pulp/shopers with yield % and wastage; auto stock-out raw, auto stock-in processed
- **Recipes** with versioning; new version deactivates old (past sales keep using their original version)
- **Stock transfers** — DISPATCHED → RECEIVED/VARIANCE flow with branch confirmation
- **Sale → stock deduction**: when an order is PAID, recipes are walked and ingredients are deducted from the branch's default sale location. Negative stock is allowed (and surfaces as the leakage signal in reports)
- **Stock query endpoints** — per-location, per-branch, low-stock filter

### Phase 2C — Admin app (`apps/admin`, port 3100)
- Sidebar nav: Dashboard, Stock levels, Raw materials, Production, Transfers, Suppliers, Purchase orders, Recipes
- All CRUD flows working in browser
- Stock levels view flags **NEGATIVE** (leakage signal) and **LOW** (below reorder threshold)

### Smoke tests
```powershell
node scripts/smoke-test.mjs      # Phase 1A: 11 assertions
node scripts/smoke-phase2.mjs    # Phase 2: 25 assertions covering the full loop
```
Total: **36 assertions passing**.

### Phase 3 — Reports & alerts (the actionable layer)
- **Variance / leakage report:** for each processed product at a branch in a date range, computes `received − sold − wasted − current_stock`. Positive number = stock disappeared. Also shows expected vs actual glasses sold via recipe lookup.
- **Branch P&L:** sales − discounts − COGS (computed from latest GRN rates × recipe ingredient quantities) − expenses → net + margin %.
- **Item profitability:** per-item qty sold, revenue, COGS per unit, profit, margin. Items without recipes show full revenue as profit (signal to add a recipe).
- **Anomaly engine** with 6 rules:
  - Excessive voids by a cashier (≥5 in a day)
  - Persistent cash-drawer variance (3+ shifts > ₨500 in 7 days)
  - Discount abuse (cashier discounts on > 30% of orders)
  - Supplier rate jump > 15% vs 30-day average on a new GRN
  - Batch wastage spike > 15% of inputs
  - Negative on-hand stock (the leakage signal)
- **Alerts admin:** list (filterable to open / all), acknowledge, severity-grouped summary. Dashboard surfaces open-alert badge.
- **Idempotent scan:** re-running the anomaly scan won't create duplicate alerts for the same day.

### Phase 4 — Owner AI assistant
- **OpenAI GPT-4o-mini** (configurable via `OPENAI_MODEL`) with manual function-calling loop. 10 read-only tools wrap the existing services: `list_branches`, `list_suppliers`, `get_variance_report`, `get_branch_pnl`, `get_item_profitability`, `get_stock_levels`, `get_recent_orders`, `get_supplier_ledger`, `get_alert_summary`, `get_open_alerts`.
- **Automatic prompt caching** — OpenAI matches the longest identical prefix on prompts ≥1024 tokens and bills cached input tokens at ~50% off. We keep the system prompt and tool defs stable across requests to maximise hits.
- **Conversation persistence** — every user message, assistant turn, and tool call is stored in `AiConversation`/`AiMessage`. Resuming a conversation rebuilds the wire history faithfully.
- **Graceful offline mode** — if `OPENAI_API_KEY` isn't set, the admin Assistant screen renders an offline card with setup steps and the rest of the system runs normally.
- Admin chat UI at `/assistant`: sample-question starters, conversation sidebar, cache-hit token telemetry in the header.

### Smoke tests (51 assertions when AI key is set, 48 without)
```powershell
node scripts/smoke-test.mjs       # Phase 1A: 11
node scripts/smoke-phase2.mjs     # Phase 2: 25
node scripts/smoke-phase3.mjs     # Phase 3: 8
node scripts/smoke-phase4.mjs     # Phase 4: 4 offline (+3 live with OPENAI_API_KEY)
```

### Phase 5 — Brand identity + Offline-first POS

**Sabir Juice Corner branding (yellow + red, est. 1973):**
- Tailwind palettes redefined: `sjc-*` for the warm brand yellow, `accent-*` for the bold CTA red, `leaf-*` for the green sprig accent.
- Inline brand SVG component renders a recognisable juice-glass logo as a fallback.
- **Drop your real logo files into `apps/pos/public/` and `apps/admin/public/`** (see those folders' `README-logos.md`). The apps pick them up automatically — no rebuild needed.
- POS + admin login screens, headers, and the admin sidebar all use the brand identity.

**PWA + offline POS:**
- Installable as an Android home-screen / desktop app via `manifest.webmanifest` (brand colors, brand icons when you drop them in).
- Service worker (workbox via vite-plugin-pwa) caches the app shell so the counter loads with no internet.
- Menu items cached `NetworkFirst` for 24 h so item codes still resolve when offline.
- **IndexedDB order queue:** if `Pay` fails because the network is down, the full order (items + payment) is queued locally with a `LOCAL-…` id. The cashier sees a "queued" receipt and can move to the next customer.
- **Auto-sync on reconnect:** the moment `window` fires the `online` event, the drain worker replays each queued order in capture order, promoting them to real server orders. Conflicts (shift closed, item removed) get parked in a "needs attention" bucket.
- **Status badge** in the POS header: green "Online", amber "X pending", red "Offline".

**Known limitation (Phase 5.5 follow-up):** starting a brand-new order while completely offline still requires the server to assign an order ID. The cashier sees an error if they try to begin a fresh order during an outage. Mid-order outages (where the order was created online but Pay fails offline) are fully handled.

## Menu verification (action needed from owner)

`packages/db/prisma/data/menu.json` is the source of truth for items. It was transcribed from the image you shared on **2026-05-26**. The following entries are flagged `"needs_verify": true` and need your confirmation:

- **#93 "Ice Cream"** — I assumed a price of 160. Confirm.
- **#110 / #111 "Jamakal Jaman"** — Name spelling, please confirm.
- **#118 "Clipping Queen"** — Single-size at 220, no Jumbo? Confirm.
- **#141 "Singhara Shake JUMBO"** — Spelling "Large" vs "Jumbo"?
- **#146 "LIMKA"** — Price 100, single size?
- **#147 "Dawn Strawberry"** — Confirm if this is still on the menu.
- **#148 "Lot-No-221/245-Asif"** — Looks like an internal note, not a sellable item. Should it be removed?
- **#315 "Strawberry + Coconut JUMBO"** — Price seems low vs Medium.
- **#1112 "Hot Coffee"** vs **#129 "HOT COFFEE"** — Likely duplicates with different prices.

Edit the JSON, then `pnpm db:seed` re-runs idempotently to apply changes.

## Tech stack

| Layer | Choice |
|---|---|
| Database | PostgreSQL 16 |
| ORM | Prisma 5 |
| API | Fastify + Zod (lightweight, fast; can move to NestJS later if team grows) |
| Frontend | Next.js (admin) + Vite + PWA (POS) — *coming next* |
| Auth | JWT (access + refresh) + bcrypt — *Phase 1* |
| Cache / Queue | Redis + BullMQ — *Phase 3 when reports and AI come online* |
| AI assistant | Anthropic Claude API with tool use — *Post-MVP* |
| Infra | Docker for local; AWS Mumbai or DO Singapore for prod |

## Memory & onboarding

Detailed business context, user profile, and design decisions are stored in `.claude/projects/.../memory/`. Future Claude Code sessions will load these automatically.

## License

Proprietary — Sabir Juice Corner.
