# Canonical Data Model

Defined in `src/canonical/types.ts`. Every field exists because a current exception rule,
evidence collector, or root-cause analyzer uses it — this is not a copy of the WMS schema.
"Source mapping" below is for the current (only) adapter, `WmsDatabaseAdapter`; a future
adapter maps its own source's fields into the same canonical shape.

## CanonicalOrder

| Field | Type | Meaning | WMS source mapping | Required | Used by |
|---|---|---|---|---|---|
| `orderId` | `string` | Human-readable order code | `orders.order_id` | yes | entityId for `SLA_AT_RISK`/`PACKING_DELAY`/`DISPATCH_DELAY`; join key everywhere |
| `customerId` | `string` | Customer reference | `orders.customer_id` | yes | evidence context (`OrderContext`) |
| `priority` | `'LOW'\|'NORMAL'\|'HIGH'\|'URGENT'\|null` | Order priority | `orders.priority` | no | evidence context |
| `orderTime` | `Date` | When the order was placed | `orders.order_time` | yes | `HIGH_RETURN_RATE` demand window; evidence |
| `expectedDispatchTime` | `Date` | SLA deadline | `orders.expected_dispatch` | yes | `SLA_AT_RISK` detection |
| `status` | `CanonicalOrderStatus\|null` | Fulfillment stage | `orders.status` | no | `SLA_AT_RISK`/`PACKING_DELAY` filtering; evidence |
| `items` | `CanonicalOrderItem[]` | Line items | `order_items` rows for this order | yes (may be empty) | `HIGH_RETURN_RATE` demand; `PACKING_DELAY`/`SLA_AT_RISK` evidence |

## CanonicalOrderItem

| Field | Type | Meaning | WMS source mapping | Required | Used by |
|---|---|---|---|---|---|
| `sku` | `string` | Product SKU | `order_items.sku` | yes | demand aggregation, evidence |
| `orderedQuantity` | `number` | Quantity ordered | `order_items.quantity` | yes | `HIGH_RETURN_RATE` demand total; complexity scoring |
| `pickedQuantity` | `number\|null` | Quantity picked so far | `order_items.picked_quantity` | no | evidence progress display |
| `packedQuantity` | `number\|null` | Quantity packed so far | `order_items.packed_quantity` | no | evidence progress display |

## CanonicalProduct

| Field | Type | Meaning | WMS source mapping | Required | Used by |
|---|---|---|---|---|---|
| `sku` | `string` | Product SKU | `products.sku` | yes | join key |
| `name` | `string` | Display name | `products.product_name` | yes | evidence/description text |
| `category` | `string\|null` | Product category | `products.category` | no | evidence context |
| `reorderLevel` | `number\|null` | Shortage threshold | `products.reorder_level` | no (a `null` reorder level can never trigger a shortage) | `INVENTORY_SHORTAGE` detection |
| `active` | `boolean` | Whether the product is active | `products.active` (`1`/`0`) | yes | `INVENTORY_SHORTAGE` scoping (inactive products never flagged) |

## CanonicalInventory

One row = one SKU at one location.

| Field | Type | Meaning | WMS source mapping | Required | Used by |
|---|---|---|---|---|---|
| `sku` | `string` | Product SKU | `inventory.sku` | yes | grouping/join key |
| `locationId` | `string` | Warehouse location code | `inventory.location` | yes | evidence, `INVENTORY_DISCREPANCY` entityId |
| `quantity` | `number` | Physical quantity on hand | `inventory.quantity` | yes | shortage/discrepancy math |
| `reservedQuantity` | `number` | Quantity reserved | `inventory.reserved_quantity` | yes | shortage/discrepancy math |
| `damagedQuantity` | `number` | Quantity marked damaged | `inventory.damaged_quantity` | yes | discrepancy math, shortage root cause |
| `availableQuantity` | `number` | `quantity - reservedQuantity`, computed at mapping time | derived | yes | shortage detection/root cause |
| `lastUpdated` | `Date` | Last stock update | `inventory.last_updated` | yes | evidence |

## CanonicalPickingTask

| Field | Type | Meaning | WMS source mapping | Required | Used by |
|---|---|---|---|---|---|
| `taskId` | `string` | Human-readable task code | `picking_tasks.task_id` | yes | entityId, join key, evidence lookup |
| `orderId` | `string` | Canonical order code this task belongs to | resolved via `picking_tasks.order_id` → `orders.order_id` | yes | `PACKING_DELAY` grouping; cross-exception correlation |
| `pickerId` | `string` | Picker identifier | `picking_tasks.picker_id` | yes | `PICKER_OVERLOAD`/`PICKER_PERFORMANCE` root cause |
| `locationId` | `string\|null` | Primary pick location (first item's location) | derived from `picking_task_items` | no | evidence |
| `startTime` | `Date\|null` | When picking started | `picking_tasks.start_time` | no | `PICKING_DELAY`/`EXCESSIVE_PICKING_TIME` detection |
| `endTime` | `Date\|null` | When picking finished | `picking_tasks.end_time` | no | `EXCESSIVE_PICKING_TIME`/`PACKING_DELAY` detection |
| `errors` | `number` | Recorded error count | `picking_tasks.errors` | yes (defaults 0) | (informational; per-item errors drive `PICKING_ERROR`) |
| `distanceWalked` | `number\|null` | Distance walked for this task | `picking_tasks.distance_walked` | no | `EXCESSIVE_PICKER_DISTANCE` detection |
| `status` | `CanonicalPickingTaskStatus\|null` | Task status | `picking_tasks.status` | no | detection filtering across every picking-task rule |
| `items` | `CanonicalPickingTaskItem[]` | Line items for this task | `picking_task_items` rows | yes (may be empty) | `PICKING_ERROR` detection; evidence; complexity root cause |

## CanonicalPickingTaskItem

| Field | Type | Meaning | WMS source mapping | Required | Used by |
|---|---|---|---|---|---|
| `sku` | `string` | Product SKU | `picking_task_items.sku` | yes | evidence, discrepancy correlation |
| `locationId` | `string` | Pick location | `picking_task_items.location` | yes | evidence, discrepancy correlation (`sku:location` key) |
| `requestedQuantity` | `number` | Quantity requested | `picking_task_items.requested_quantity` | yes | evidence |
| `pickedQuantity` | `number\|null` | Quantity actually picked | `picking_task_items.picked_quantity` | no | pending-quantity evidence |
| `errorReason` | `string\|null` | Recorded error reason, if any | `picking_task_items.error_reason` | no | `PICKING_ERROR` detection |

## CanonicalPacking

| Field | Type | Meaning | WMS source mapping | Required | Used by |
|---|---|---|---|---|---|
| `orderId` | `string` | Canonical order code | resolved via `packing.order_id` → `orders.order_id` | yes | `PACKING_DELAY`/`DISPATCH_DELAY` grouping |
| `packingTime` | `Date` | When packing was recorded | `packing.packing_time` | yes | `DISPATCH_DELAY` detection |
| `packageSize` | `string\|null` | Package size code | `packing.package_size` | no | evidence |
| `weight` | `number\|null` | Package weight | `packing.weight` | no | evidence |
| `damaged` | `boolean` | Whether packing was recorded damaged | `packing.damaged` (`1`/`0`) | yes | evidence |
| `packedBy` | `string` | Who packed it | `packing.packed_by` | yes | evidence |

## CanonicalDispatch

| Field | Type | Meaning | WMS source mapping | Required | Used by |
|---|---|---|---|---|---|
| `orderId` | `string` | Canonical order code | resolved via `dispatch.order_id` → `orders.order_id` | yes | `DISPATCH_DELAY` grouping/root cause |
| `truckId` | `string\|null` | Truck identifier | `dispatch.truck` | no | evidence |
| `carrier` | `string\|null` | Carrier name | `dispatch.carrier` | no | evidence |
| `dock` | `string\|null` | Dock identifier | `dispatch.dock` | no | `DOCK_CONGESTION` root cause |
| `loadingTime` | `Date\|null` | When loading started | `dispatch.loading_time` | no | `LOADING_DELAY` root cause |
| `departureTime` | `Date\|null` | When the truck departed | `dispatch.departure_time` | no | `DISPATCH_DELAY` detection ("not yet departed") |

## CanonicalReturn

| Field | Type | Meaning | WMS source mapping | Required | Used by |
|---|---|---|---|---|---|
| `returnId` | `string` | Return record id | `returns.return_id` | yes | evidence |
| `orderId` | `string\|null` | Canonical order code, if known | resolved via `returns.order_id` → `orders.order_id` | no | (informational) |
| `sku` | `string` | Product SKU | `returns.sku` | yes | `HIGH_RETURN_RATE` grouping |
| `reason` | `string` | Return reason code | `returns.reason` | yes | `HIGH_RETURN_RATE` root cause (per-reason scoring) |
| `condition` | `CanonicalReturnCondition\|null` | Returned-item condition | `returns.return_condition` | no | evidence |
| `returnedAt` | `Date\|null` | When the return was recorded | `returns.returned_at` | no | `HIGH_RETURN_RATE` window scoping |

## Fields deliberately excluded

Present in the WMS schema but not in the canonical model because no current intelligence
rule uses them: `products.unit_weight/length/width/height`, `products.created_at`,
`orders.created_at`/`updated_at`, `returns.photos`, every table's internal numeric `id`
(replaced everywhere by a human-readable business code — see "Known limitations" in
`ARCHITECTURE.md` for why that matters). If a future rule needs one of these, add it to
the relevant `Canonical*` type and its mapper — don't add fields speculatively.
