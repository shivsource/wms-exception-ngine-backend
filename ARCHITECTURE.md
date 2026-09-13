# Architecture

## 1. Current architecture (before this phase)

The engine is organized in clear layers — detection rules, evidence collectors, root-cause
analyzers, recommenders, services, controllers — but the bottom two layers (rules and
evidence collectors) queried the WMS MySQL database directly through `src/repositories/*`,
and several of those repository methods baked business thresholds straight into SQL
(`HAVING totalAvailable < reorderLevel`, `TIMESTAMPDIFF(...) > ?`, etc.). Five of the ten
root-cause analyzers also queried WMS repositories directly for correlation lookups. This
meant "can we run this intelligence against a different data source" required rewriting
the rules and analyzers themselves, not just swapping a data layer.

`recommendation/*` and `explanations/*` were already decoupled — they operate purely on
persisted exceptions, structured evidence, and root-cause results, never on WMS tables.

## 2. New architecture

```
                CURRENT WMS DATABASE
                         │
                         ▼
                WMS DATABASE ADAPTER          (src/adapters/wms-database)
                         │
                         ▼
                 NORMALIZATION                (src/adapters/wms-database/mappers.ts)
                         │
                         ▼
                CANONICAL MODEL                (src/canonical/types.ts)
                         │
                         ▼
              LOGISTICS DATA SOURCE            (src/canonical/logistics-data-source.ts)
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     DETECTION       ROOT CAUSE    RECOMMENDATION
     (src/rules)   (src/root-cause) (src/recommendation)
          │              │              │
          └──────────────┼──────────────┘
                         ▼
                   INTELLIGENCE
```

`src/queries/*` sits alongside the intelligence layer, not the adapter: it holds the pure,
source-agnostic aggregation/classification functions (e.g. "which SKUs are below their
reorder level", "which orders are stuck awaiting packing") that used to live in SQL. Rules
and root-cause analyzers call these functions over canonical arrays returned by
`LogisticsDataSource`.

## 3. Why a canonical model exists

The intelligence layer (rules, evidence collectors, root-cause analyzers) should be able
to run against *any* logistics data source — this WMS, another WMS, a TMS, an ERP, a
webhook feed — without being rewritten. That's only possible if it depends on one stable
set of shapes (`CanonicalOrder`, `CanonicalInventory`, `CanonicalPickingTask`, ...) instead
of a specific database's tables. The canonical model is deliberately minimal: it only
contains fields the current 10 exception types, their evidence, and their root-cause
analysis actually use (see `CANONICAL_MODEL.md`) — it is not a copy of the WMS schema.

## 4. Adapter responsibilities

An adapter (currently only `WmsDatabaseAdapter`) is the **only** code in the repository
that is allowed to know a source system's schema. Its job is narrowly scoped to:

- Fetching rows (via the existing `src/repositories/*`, unchanged in spirit — they now
  also expose generic bulk finders like `findAll()` alongside their existing lookups).
- Mapping rows into canonical entities (`src/adapters/wms-database/mappers.ts`).
- Validating each row and skipping (with a logged warning) any row that fails mapping,
  so one malformed record never corrupts or aborts a bulk fetch.

An adapter must **never** contain business classification logic — no "if quantity <
reserved then shortage", no severity thresholds, no time-window "is this at risk" checks.
Those are business rules, and they belong in the intelligence layer so they run
identically no matter which source produced the data.

## 5. Intelligence layer responsibilities

Rules, evidence collectors, and root-cause analyzers depend only on:

1. `src/canonical/types.ts` — the canonical entity/filter shapes.
2. `src/canonical/logistics-data-source.ts` — the `LogisticsDataSource` interface.
3. `src/queries/*` — pure aggregation/classification helpers over canonical arrays.

They call `logisticsDataSource.getX(...)` (a singleton exported from `src/adapters`,
selected by `DATA_SOURCE`) exactly the way they used to call `xRepository.findY(...)` —
the call-site shape barely changed, but the dependency now points at an interface, not a
database.

Root-cause analyzers additionally use `exceptionRepository` — this is **not** a WMS
dependency. It's the engine's own persisted-exceptions store, used to correlate sibling
exceptions (e.g. "is there also an `INVENTORY_SHORTAGE` for this SKU"), and every source
adapter shares that same store.

## 6. Data flow: WMS source record → canonical record → exception detection

Example — `INVENTORY_SHORTAGE`:

```
inventory row {sku, location, quantity, reserved_quantity, damaged_quantity, last_updated}
products row  {sku, product_name, reorder_level, active}
        │  WmsDatabaseAdapter.getInventory() / getProducts()
        ▼  (mappers.ts: mapInventory / mapProduct)
CanonicalInventory {sku, locationId, quantity, reservedQuantity, damagedQuantity,
                    availableQuantity, lastUpdated}
CanonicalProduct   {sku, name, category, reorderLevel, active}
        │  InventoryShortageRule.evaluate()
        ▼  (queries/inventory.queries.ts: findInventoryShortages — groups by sku,
        │   sums quantity/reserved across locations, compares to reorderLevel)
DetectedException {type: INVENTORY_SHORTAGE, severity, entityId: sku, evidence: {...}}
```

The same shape of flow applies to every rule — see `src/rules/*.rule.ts` alongside its
matching helper(s) in `src/queries/*`.

## 7. How to add another adapter (e.g. a second WMS, a TMS, an API feed)

1. Create `src/adapters/<name>/` implementing `LogisticsDataSource`.
2. Write a `mappers.ts` translating that source's records into the canonical types —
   throw a descriptive error for a malformed/unmappable record (see `MappingError` in
   `src/adapters/wms-database/mappers.ts`) rather than producing corrupt canonical data.
3. Add one case to `LogisticsDataSourceFactory.create()` in `src/adapters/index.ts` and
   one value to the `DATA_SOURCE` env enum in `src/config/env.ts`.
4. Nothing in `src/rules`, `src/evidence`, `src/root-cause`, or `src/recommendation`
   changes. If your source can't populate a field (e.g. no distinct pick locations), map
   it to `null` — every canonical field an adapter can't supply should be optional/null
   already, since the current model only includes fields real intelligence rules use.

## 8. How to run tests

```
npm test            # vitest run — full suite, offline (no DB required)
npm run test:watch  # vitest --watch
```

Key suites for this phase:

- `src/adapters/wms-database/mappers.test.ts` — WMS row → canonical mapping, including
  malformed-record handling (TEST 1–3).
- `src/adapters/factory.test.ts` — source selection via `DATA_SOURCE`.
- `src/canonical/mock-pipeline.test.ts` — **the most important test**: every exception
  type detected, and three representative full detection → evidence → root-cause →
  recommendation chains, run entirely against `MockLogisticsDataSource`, which has never
  heard of MySQL or the WMS schema. If this suite passes, the intelligence layer is
  proven decoupled from the WMS database.
- Every pre-existing `src/root-cause/*.test.ts` and `src/recommendation/*.test.ts` file
  still passes unchanged in outcome (some were updated to mock `logisticsDataSource`
  instead of a WMS repository — the assertions on scores/causes/severities were not
  touched), demonstrating the refactor didn't change root-cause or recommendation logic.

## 9. Known limitations / trade-offs from this phase

- **In-memory aggregation, not SQL.** `src/queries/*` reimplements what used to be
  `GROUP BY`/`HAVING` SQL in TypeScript over arrays returned by the adapter. This is the
  right call for phase 1 (see "Database decision" below) but means a very large WMS would
  need pagination/streaming before this becomes a second production concern — out of
  scope here.
- **Canonical IDs are business codes, not source row ids.** `CanonicalOrder.orderId`,
  `CanonicalPickingTask.taskId`, etc. are human-readable codes (`"ORD-100160"`,
  `"TASK-100"`), never a source's internal autoincrement id — a source with no such id
  (an API, a CSV feed) still maps cleanly. One consequence: a handful of already-open
  exceptions detected *before* this change (`PICKING_DELAY`, `PICKING_ERROR`,
  `EXCESSIVE_PICKING_TIME`, `EXCESSIVE_PICKER_DISTANCE`) have raw evidence recorded with
  the *old* numeric WMS row id as their `orderId` join key. Task-level evidence lookups
  still work for those (they were always keyed by the human-readable `taskCode`, which
  didn't change), but the order-level correlation used by `DISPATCH_DELAY`,
  `PACKING_DELAY`, and `SLA_AT_RISK` root-cause analysis won't match those specific old
  rows — it degrades to "no match found," not an error, and self-heals the next time
  those exceptions resolve and re-detect. If you want a clean before/after comparison,
  clear the `exceptions` table (and its `root_cause_analyses`/`exception_recommendations`
  children) before re-running the engine.
- **No persistence for the canonical layer itself** — see below.

## 10. Database decision: no canonical database

Considered: (A) in-memory/domain objects only, (B) a normalized canonical SQL store
duplicating WMS data, (C) an event-based canonical store.

**Chosen: (A).** The canonical entities are plain TypeScript objects, produced on demand
by the adapter for each rule/analyzer call, never persisted. Reasons:

- The intelligence layer already re-reads current WMS state on every engine run (via the
  scheduler) — there was never a requirement for canonical data to outlive one request.
- Duplicating ~1,000 orders and all related WMS data into a second store adds an
  ongoing sync problem (staleness, migration, drift) with no corresponding intelligence
  benefit at this phase.
- The only thing that genuinely needs persistence is the engine's own output — detected
  exceptions, root-cause analyses, recommendations — and that already has a store
  (`exceptions`, `root_cause_analyses`, `exception_recommendations`), untouched by this
  phase.

If a future phase needs canonical data to survive across sources or be queried
independently of any single adapter's live fetch, (B) or (C) can be introduced without
touching the `LogisticsDataSource` interface — only a new adapter implementation
backed by that store.

## 11. Logging / observability

Every adapter fetch logs two structured events per entity: a `"Source fetch"` line
(`source`, `entity`, `recordsFetched`) and a `"Normalization completed"` line (adds
`recordsNormalized`, `recordsSkipped`). No customer/order content is logged — only
counts, identifiers already public to the API (SKUs, order/task codes), and, on a mapping
failure, the field name that was missing/invalid.

## 12. Error handling

- **Malformed source record** (missing required field, invalid timestamp, dangling FK
  like a picking task referencing a nonexistent order): `mappers.ts` throws a
  `MappingError`; the adapter catches it per-record, logs a warning, and excludes just
  that record from the batch — one bad row never corrupts or aborts an otherwise-good
  fetch.
- **Unsupported enum value** (an order status the canonical model doesn't recognize):
  degrades to `null` rather than throwing — see `toEnum()` in `mappers.ts`.
- **Source unavailable**: unchanged from before this phase — the existing MySQL pool /
  `pingDatabase()` / Express error-handling middleware behavior is untouched.
