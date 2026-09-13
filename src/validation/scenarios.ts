import { EntityType, ExceptionSeverity, ExceptionType, PredictionType } from '../types/enums';
import { PredictionValidationScenario } from './types';

/**
 * 16 controlled, deterministic scenarios (Section 3). Every timestamp is an offset in
 * minutes from a fixed literal anchor (`T0`) — never `new Date()` — so the whole suite
 * produces byte-identical results on every run (Section 21). Every seed value uses only
 * canonical fields that already exist (see CANONICAL_MODEL.md); nothing here invents a
 * truck-delay/carrier-delay/dock-ETA field or any other data the schema doesn't have
 * (Section 8's explicit warning re: DISPATCH_DELAY).
 */

const T0 = new Date('2026-09-03T09:00:00.000Z');

export const validationScenarios: PredictionValidationScenario[] = [
  // ------------------------------------------------------------------------------------
  // SCENARIO 1 — LOW SLA RISK: comfortably inside SLA, no meaningful prediction expected.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S01',
    name: 'LOW_SLA_RISK',
    description: 'Order is comfortably within SLA with picking/packing already complete — the engine must not raise a meaningful risk.',
    t0: T0,
    targets: [{ predictionType: PredictionType.SLA_BREACH_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S01-ORD', expectedResult: 'TRUE_NEGATIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Order 200 minutes from dispatch, picking and packing already done',
        state: {
          orders: [
            {
              orderId: 'VAL-S01-ORD',
              customerId: 'CUST-1',
              priority: 'NORMAL',
              orderTime: new Date(T0.getTime() - 60 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 200 * 60_000),
              status: 'PACKING',
              items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 5, packedQuantity: 5 }],
            },
          ],
          pickingTasks: [
            {
              taskId: 'VAL-S01-TASK',
              orderId: 'VAL-S01-ORD',
              pickerId: 'PICKER-1',
              locationId: 'A1',
              startTime: new Date(T0.getTime() - 50 * 60_000),
              endTime: new Date(T0.getTime() - 40 * 60_000),
              errors: 0,
              distanceWalked: 50,
              status: 'COMPLETED',
              items: [],
            },
          ],
          packing: [{ orderId: 'VAL-S01-ORD', packingTime: new Date(T0.getTime() - 10 * 60_000), packageSize: 'M', weight: 2, damaged: false, packedBy: 'PACKER-1' }],
        },
      },
      {
        offsetMinutes: 210,
        label: 'Order dispatches normally, well within SLA',
        state: {
          orders: [
            {
              orderId: 'VAL-S01-ORD',
              customerId: 'CUST-1',
              priority: 'NORMAL',
              orderTime: new Date(T0.getTime() - 60 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 200 * 60_000),
              status: 'DISPATCHED',
              items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 5, packedQuantity: 5 }],
            },
          ],
          dispatch: [{ orderId: 'VAL-S01-ORD', truckId: 'TRUCK-1', carrier: 'CARRIER-1', dock: 'D1', loadingTime: new Date(T0.getTime() + 205 * 60_000), departureTime: new Date(T0.getTime() + 208 * 60_000) }],
        },
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 2 — HIGH SLA BREACH RISK: risk flagged well before the SLA_AT_RISK exception opens.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S02',
    name: 'HIGH_SLA_BREACH_RISK',
    description: 'Picking incomplete on an urgent order with 165 minutes left; SLA_AT_RISK opens 45 minutes later once the order enters the detection window.',
    t0: T0,
    targets: [{ predictionType: PredictionType.SLA_BREACH_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S02-ORD', expectedResult: 'TRUE_POSITIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Order due in 165 minutes, picking not started, HIGH priority',
        state: {
          orders: [
            {
              orderId: 'VAL-S02-ORD',
              customerId: 'CUST-2',
              priority: 'HIGH',
              orderTime: new Date(T0.getTime() - 30 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 165 * 60_000),
              status: 'PICKING',
              items: [{ sku: 'SKU-2', orderedQuantity: 5, pickedQuantity: 0, packedQuantity: 0 }],
            },
          ],
        },
      },
      {
        offsetMinutes: 45,
        label: 'Order now 120 minutes from dispatch — still not picked; SLA_AT_RISK opens',
        state: {},
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 3 — CRITICAL SLA RISK: prediction fires minutes before the exception opens.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S03',
    name: 'CRITICAL_SLA_RISK',
    description: 'Order is minutes away from entering the SLA detection window with everything still incomplete — a very short but genuine warning.',
    t0: T0,
    targets: [{ predictionType: PredictionType.SLA_BREACH_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S03-ORD', expectedResult: 'TRUE_POSITIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Order due in 124 minutes, nothing picked, URGENT priority',
        state: {
          orders: [
            {
              orderId: 'VAL-S03-ORD',
              customerId: 'CUST-3',
              priority: 'URGENT',
              orderTime: new Date(T0.getTime() - 20 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 124 * 60_000),
              status: 'PICKING',
              items: [{ sku: 'SKU-3', orderedQuantity: 8, pickedQuantity: 0, packedQuantity: 0 }],
            },
          ],
        },
      },
      {
        offsetMinutes: 4,
        label: 'Order now 120 minutes from dispatch — SLA_AT_RISK opens',
        state: {},
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 4 — PICKING DELAY PREDICTION: risk crosses MEDIUM before the task is stuck.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S04',
    name: 'PICKING_DELAY_PREDICTION',
    description: 'Task elapsed time grows past the 30-minute historical baseline; PICKING_DELAY opens once it crosses the 60-minute stuck threshold.',
    t0: T0,
    targets: [{ predictionType: PredictionType.PICKING_DELAY_RISK, entityType: EntityType.PICKING_TASK, entityId: 'VAL-S04-TASK', expectedResult: 'TRUE_POSITIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Task started 25 minutes ago; 5 historical tasks establish a ~30-minute baseline',
        state: {
          pickingTasks: [
            { taskId: 'VAL-S04-TASK', orderId: 'VAL-S04-ORD', pickerId: 'PICKER-4', locationId: 'A1', startTime: new Date(T0.getTime() - 25 * 60_000), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
            ...[0, 1, 2, 3, 4].map((i) => ({
              taskId: `VAL-S04-BASE-${i}`,
              orderId: `VAL-S04-BASE-ORD-${i}`,
              pickerId: 'PICKER-4',
              locationId: 'A1',
              startTime: new Date(T0.getTime() - (500 + i) * 60_000),
              endTime: new Date(T0.getTime() - (470 + i) * 60_000),
              errors: 0,
              distanceWalked: 50,
              status: 'COMPLETED' as const,
              items: [],
            })),
          ],
        },
      },
      {
        offsetMinutes: 25,
        label: 'Elapsed now 50 minutes — well past baseline, risk crosses MEDIUM',
        state: {
          pickingTasks: [
            { taskId: 'VAL-S04-TASK', orderId: 'VAL-S04-ORD', pickerId: 'PICKER-4', locationId: 'A1', startTime: new Date(T0.getTime() - 25 * 60_000), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
            ...[0, 1, 2, 3, 4].map((i) => ({
              taskId: `VAL-S04-BASE-${i}`,
              orderId: `VAL-S04-BASE-ORD-${i}`,
              pickerId: 'PICKER-4',
              locationId: 'A1',
              startTime: new Date(T0.getTime() - (500 + i) * 60_000),
              endTime: new Date(T0.getTime() - (470 + i) * 60_000),
              errors: 0,
              distanceWalked: 50,
              status: 'COMPLETED' as const,
              items: [],
            })),
          ],
        },
      },
      {
        offsetMinutes: 36,
        label: 'Elapsed now 61 minutes — PICKING_DELAY opens',
        state: {
          pickingTasks: [
            { taskId: 'VAL-S04-TASK', orderId: 'VAL-S04-ORD', pickerId: 'PICKER-4', locationId: 'A1', startTime: new Date(T0.getTime() - 25 * 60_000), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
          ],
        },
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 5 — PICKING DELAY FALSE POSITIVE: task finishes before the stuck threshold.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S05',
    name: 'PICKING_DELAY_FALSE_POSITIVE',
    description: 'Task already looks risky (elapsed well above baseline) but the picker completes it before the 60-minute stuck threshold — a false alarm.',
    t0: T0,
    targets: [{ predictionType: PredictionType.PICKING_DELAY_RISK, entityType: EntityType.PICKING_TASK, entityId: 'VAL-S05-TASK', expectedResult: 'FALSE_POSITIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Task started 45 minutes ago against a ~20-minute baseline — already HIGH risk',
        state: {
          pickingTasks: [
            { taskId: 'VAL-S05-TASK', orderId: 'VAL-S05-ORD', pickerId: 'PICKER-5', locationId: 'A1', startTime: new Date(T0.getTime() - 45 * 60_000), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
            ...[0, 1, 2, 3, 4].map((i) => ({
              taskId: `VAL-S05-BASE-${i}`,
              orderId: `VAL-S05-BASE-ORD-${i}`,
              pickerId: 'PICKER-5',
              locationId: 'A1',
              startTime: new Date(T0.getTime() - (500 + i) * 60_000),
              endTime: new Date(T0.getTime() - (480 + i) * 60_000),
              errors: 0,
              distanceWalked: 50,
              status: 'COMPLETED' as const,
              items: [],
            })),
          ],
        },
      },
      {
        offsetMinutes: 10,
        label: 'Picker finishes the task after 55 minutes — before the 60-minute stuck threshold',
        state: {
          pickingTasks: [
            { taskId: 'VAL-S05-TASK', orderId: 'VAL-S05-ORD', pickerId: 'PICKER-5', locationId: 'A1', startTime: new Date(T0.getTime() - 45 * 60_000), endTime: new Date(T0.getTime() + 10 * 60_000), errors: 0, distanceWalked: 60, status: 'COMPLETED', items: [] },
          ],
        },
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 6 — INVENTORY SHORTAGE: pending demand consumes available stock over time.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S06',
    name: 'INVENTORY_SHORTAGE',
    description: 'Open-order demand already exceeds available stock (a leading indicator); a later reservation increase pushes available stock below reorder level.',
    t0: T0,
    targets: [{ predictionType: PredictionType.INVENTORY_SHORTAGE_RISK, entityType: EntityType.PRODUCT, entityId: 'VAL-S06-SKU', expectedResult: 'TRUE_POSITIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: '30 units available, 100 units of open-order demand outstanding, reorder level 20',
        state: {
          products: [{ sku: 'VAL-S06-SKU', name: 'Widget', category: null, reorderLevel: 20, active: true }],
          inventory: [{ sku: 'VAL-S06-SKU', locationId: 'A1', quantity: 100, reservedQuantity: 70, damagedQuantity: 0, availableQuantity: 30, lastUpdated: T0 }],
          orders: [
            {
              orderId: 'VAL-S06-ORD',
              customerId: 'CUST-6',
              priority: 'NORMAL',
              orderTime: new Date(T0.getTime() - 30 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 300 * 60_000),
              status: 'ALLOCATED',
              items: [{ sku: 'VAL-S06-SKU', orderedQuantity: 100, pickedQuantity: 0, packedQuantity: 0 }],
            },
          ],
        },
      },
      {
        offsetMinutes: 20,
        label: 'Additional reservation drops available stock to 15 — below the reorder level of 20',
        state: {
          inventory: [{ sku: 'VAL-S06-SKU', locationId: 'A1', quantity: 100, reservedQuantity: 85, damagedQuantity: 0, availableQuantity: 15, lastUpdated: new Date(T0.getTime() + 20 * 60_000) }],
        },
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 7 — LOW INVENTORY BUT NO SHORTAGE.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S07',
    name: 'LOW_INVENTORY_NO_SHORTAGE',
    description: 'Available stock is comfortably above reorder level and demand is small — low inventory risk never becomes meaningful, no shortage ever occurs.',
    t0: T0,
    targets: [{ predictionType: PredictionType.INVENTORY_SHORTAGE_RISK, entityType: EntityType.PRODUCT, entityId: 'VAL-S07-SKU', expectedResult: 'TRUE_NEGATIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: '50 units available against a reorder level of 20 and only 10 units of pending demand',
        state: {
          products: [{ sku: 'VAL-S07-SKU', name: 'Gadget', category: null, reorderLevel: 20, active: true }],
          inventory: [{ sku: 'VAL-S07-SKU', locationId: 'A1', quantity: 100, reservedQuantity: 50, damagedQuantity: 0, availableQuantity: 50, lastUpdated: T0 }],
          orders: [
            {
              orderId: 'VAL-S07-ORD',
              customerId: 'CUST-7',
              priority: 'NORMAL',
              orderTime: new Date(T0.getTime() - 30 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 300 * 60_000),
              status: 'ALLOCATED',
              items: [{ sku: 'VAL-S07-SKU', orderedQuantity: 10, pickedQuantity: 0, packedQuantity: 0 }],
            },
          ],
        },
      },
      {
        offsetMinutes: 60,
        label: 'Stock position unchanged — steady state, no shortage',
        state: {},
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 8 — DISPATCH DELAY: packed and waiting, risk grows toward the 60-minute threshold.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S08',
    name: 'DISPATCH_DELAY',
    description: 'Order packed but not departed; packing-elapsed time and SLA urgency both grow until DISPATCH_DELAY opens at the 60-minute waiting threshold.',
    t0: T0,
    targets: [{ predictionType: PredictionType.DISPATCH_DELAY_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S08-ORD', expectedResult: 'TRUE_POSITIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Packed 20 minutes ago, 150 minutes from expected dispatch, not yet departed',
        state: {
          orders: [
            {
              orderId: 'VAL-S08-ORD',
              customerId: 'CUST-8',
              priority: 'NORMAL',
              orderTime: new Date(T0.getTime() - 180 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 150 * 60_000),
              status: 'READY_TO_DISPATCH',
              items: [],
            },
          ],
          pickingTasks: [
            { taskId: 'VAL-S08-TASK', orderId: 'VAL-S08-ORD', pickerId: 'PICKER-8', locationId: 'A1', startTime: new Date(T0.getTime() - 120 * 60_000), endTime: new Date(T0.getTime() - 100 * 60_000), errors: 0, distanceWalked: 50, status: 'COMPLETED', items: [] },
          ],
          packing: [{ orderId: 'VAL-S08-ORD', packingTime: new Date(T0.getTime() - 20 * 60_000), packageSize: 'M', weight: 3, damaged: false, packedBy: 'PACKER-8' }],
        },
      },
      {
        offsetMinutes: 25,
        label: 'Packing-elapsed now 45 minutes, still no departure — risk crosses MEDIUM',
        state: {},
      },
      {
        offsetMinutes: 41,
        label: 'Packing-elapsed now 61 minutes — DISPATCH_DELAY opens',
        state: {},
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 9 — DISPATCH RISK BUT OPERATION RECOVERS.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S09',
    name: 'DISPATCH_RISK_RECOVERS',
    description: 'Order packed and risk crosses MEDIUM, but the truck departs at 35 minutes — before the 60-minute DISPATCH_DELAY threshold.',
    t0: T0,
    targets: [{ predictionType: PredictionType.DISPATCH_DELAY_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S09-ORD', expectedResult: 'FALSE_POSITIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Packed 20 minutes ago, 150 minutes from expected dispatch, not yet departed',
        state: {
          orders: [
            {
              orderId: 'VAL-S09-ORD',
              customerId: 'CUST-9',
              priority: 'NORMAL',
              orderTime: new Date(T0.getTime() - 180 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 150 * 60_000),
              status: 'READY_TO_DISPATCH',
              items: [],
            },
          ],
          pickingTasks: [
            { taskId: 'VAL-S09-TASK', orderId: 'VAL-S09-ORD', pickerId: 'PICKER-9', locationId: 'A1', startTime: new Date(T0.getTime() - 120 * 60_000), endTime: new Date(T0.getTime() - 100 * 60_000), errors: 0, distanceWalked: 50, status: 'COMPLETED', items: [] },
          ],
          packing: [{ orderId: 'VAL-S09-ORD', packingTime: new Date(T0.getTime() - 20 * 60_000), packageSize: 'M', weight: 3, damaged: false, packedBy: 'PACKER-9' }],
        },
      },
      {
        offsetMinutes: 25,
        label: 'Packing-elapsed now 45 minutes, still no departure — risk crosses MEDIUM',
        state: {},
      },
      {
        offsetMinutes: 35,
        label: 'Truck departs at packing-elapsed 55 minutes — before the DISPATCH_DELAY threshold',
        state: {
          orders: [
            {
              orderId: 'VAL-S09-ORD',
              customerId: 'CUST-9',
              priority: 'NORMAL',
              orderTime: new Date(T0.getTime() - 180 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 150 * 60_000),
              status: 'DISPATCHED',
              items: [],
            },
          ],
          dispatch: [{ orderId: 'VAL-S09-ORD', truckId: 'TRUCK-9', carrier: 'CARRIER-9', dock: 'D2', loadingTime: new Date(T0.getTime() + 30 * 60_000), departureTime: new Date(T0.getTime() + 35 * 60_000) }],
        },
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 10 — MULTIPLE SIMULTANEOUS RISKS on the same order.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S10',
    name: 'MULTIPLE_SIMULTANEOUS_RISKS',
    description: 'One order carries both SLA_BREACH_RISK (order-level) and PICKING_DELAY_RISK (its picking task) at once — validated independently, never collapsed into one record.',
    t0: T0,
    targets: [
      { predictionType: PredictionType.SLA_BREACH_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S10-ORD', expectedResult: 'PENDING' },
      { predictionType: PredictionType.PICKING_DELAY_RISK, entityType: EntityType.PICKING_TASK, entityId: 'VAL-S10-TASK', expectedResult: 'TRUE_POSITIVE' },
    ],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Order due in 165 minutes (HIGH priority, unpicked) and its task already 50 minutes into picking',
        state: {
          orders: [
            {
              orderId: 'VAL-S10-ORD',
              customerId: 'CUST-10',
              priority: 'HIGH',
              orderTime: new Date(T0.getTime() - 60 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 165 * 60_000),
              status: 'PICKING',
              items: [{ sku: 'SKU-10', orderedQuantity: 5, pickedQuantity: 0, packedQuantity: 0 }],
            },
          ],
          pickingTasks: [
            { taskId: 'VAL-S10-TASK', orderId: 'VAL-S10-ORD', pickerId: 'PICKER-10', locationId: 'A1', startTime: new Date(T0.getTime() - 50 * 60_000), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
            ...[0, 1, 2, 3, 4].map((i) => ({
              taskId: `VAL-S10-BASE-${i}`,
              orderId: `VAL-S10-BASE-ORD-${i}`,
              pickerId: 'PICKER-10',
              locationId: 'A1',
              startTime: new Date(T0.getTime() - (500 + i) * 60_000),
              endTime: new Date(T0.getTime() - (480 + i) * 60_000),
              errors: 0,
              distanceWalked: 50,
              status: 'COMPLETED' as const,
              items: [],
            })),
          ],
        },
      },
      {
        offsetMinutes: 11,
        label: 'Task elapsed now 61 minutes — PICKING_DELAY opens; order still 154 minutes from dispatch',
        state: {
          pickingTasks: [
            { taskId: 'VAL-S10-TASK', orderId: 'VAL-S10-ORD', pickerId: 'PICKER-10', locationId: 'A1', startTime: new Date(T0.getTime() - 50 * 60_000), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
          ],
        },
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 11 — ALREADY CONFIRMED EXCEPTION: not a future prediction.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S11',
    name: 'ALREADY_CONFIRMED_EXCEPTION',
    description: 'A PICKING_DELAY exception already exists before the prediction engine ever runs — must be CONFIRMED, never counted as a successful future prediction.',
    t0: T0,
    targets: [{ predictionType: PredictionType.PICKING_DELAY_RISK, entityType: EntityType.PICKING_TASK, entityId: 'VAL-S11-TASK', expectedResult: 'CONFIRMED_BEFORE_PREDICTION' }],
    preExistingExceptions: [{ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'VAL-S11-TASK', severity: ExceptionSeverity.HIGH, detectedAtOffsetMinutes: -5 }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Task already 70 minutes into picking — the PICKING_DELAY exception already exists',
        state: {
          pickingTasks: [
            {
              taskId: 'VAL-S11-TASK',
              orderId: 'VAL-S11-ORD',
              pickerId: 'PICKER-11',
              locationId: 'A1',
              startTime: new Date(T0.getTime() - 70 * 60_000),
              endTime: null,
              errors: 2,
              distanceWalked: null,
              status: 'IN_PROGRESS',
              // 9 line items (above the high-complexity threshold of 8) plus recorded errors —
              // needed only so this task's risk score clears the MEDIUM bar even with no
              // historical baseline and no matching order, so it counts as a genuine
              // (meaningful) prediction that the engine must correctly mark CONFIRMED.
              items: Array.from({ length: 9 }, (_, i) => ({ sku: `SKU-11-${i}`, locationId: 'A1', requestedQuantity: 1, pickedQuantity: null, errorReason: null })),
            },
          ],
        },
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 12 — INSUFFICIENT DATA: never fabricated into a LOW-risk score.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S12',
    name: 'INSUFFICIENT_DATA',
    description: 'The order this prediction is requested for does not exist in the source system — must report INSUFFICIENT_DATA, never a fabricated score.',
    t0: T0,
    targets: [{ predictionType: PredictionType.SLA_BREACH_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S12-ORD-MISSING', expectedResult: 'NOT_MEASURABLE' }],
    insufficientDataEntityId: 'VAL-S12-ORD-MISSING',
    timeline: [],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 13 — DUPLICATE / IDEMPOTENCY.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S13',
    name: 'IDEMPOTENT_EXECUTION',
    description: 'Running the engines repeatedly at the same simulated instant with unchanged state must never create duplicate prediction or exception rows.',
    t0: T0,
    targets: [{ predictionType: PredictionType.SLA_BREACH_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S13-ORD', expectedResult: 'TRUE_POSITIVE' }],
    verifyIdempotencyAtEnd: true,
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Order due in 165 minutes, picking not started, HIGH priority',
        state: {
          orders: [
            {
              orderId: 'VAL-S13-ORD',
              customerId: 'CUST-13',
              priority: 'HIGH',
              orderTime: new Date(T0.getTime() - 30 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 165 * 60_000),
              status: 'PICKING',
              items: [{ sku: 'SKU-13', orderedQuantity: 5, pickedQuantity: 0, packedQuantity: 0 }],
            },
          ],
        },
      },
      {
        offsetMinutes: 45,
        label: 'Order now 120 minutes from dispatch — SLA_AT_RISK opens',
        state: {},
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 14 — PREDICTION TOO LATE: only 30 seconds of warning.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S14',
    name: 'PREDICTION_TOO_LATE',
    description: 'Risk reaches CRITICAL right at the edge of the detection window — the exception opens only 30 seconds later. A true positive, but operationally useless warning time.',
    t0: T0,
    targets: [{ predictionType: PredictionType.SLA_BREACH_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S14-ORD', expectedResult: 'TRUE_POSITIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Order due in 120.5 minutes, nothing picked, URGENT priority',
        state: {
          orders: [
            {
              orderId: 'VAL-S14-ORD',
              customerId: 'CUST-14',
              priority: 'URGENT',
              orderTime: new Date(T0.getTime() - 20 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() + 120.5 * 60_000),
              status: 'PICKING',
              items: [{ sku: 'SKU-14', orderedQuantity: 8, pickedQuantity: 0, packedQuantity: 0 }],
            },
          ],
        },
      },
      {
        offsetMinutes: 0.5,
        label: 'Order now 120 minutes from dispatch — SLA_AT_RISK opens 30 seconds later',
        state: {},
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 15 — NO EXCEPTION baseline: fully resolved order, nothing ever at risk.
  // ------------------------------------------------------------------------------------
  {
    scenarioId: 'S15',
    name: 'NO_EXCEPTION_BASELINE',
    description: 'Order is already dispatched at T0 — never a candidate for any predictor, never an exception. Baseline TRUE_NEGATIVE.',
    t0: T0,
    targets: [{ predictionType: PredictionType.SLA_BREACH_RISK, entityType: EntityType.ORDER, entityId: 'VAL-S15-ORD', expectedResult: 'TRUE_NEGATIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Order already dispatched, fully resolved',
        state: {
          orders: [
            {
              orderId: 'VAL-S15-ORD',
              customerId: 'CUST-15',
              priority: 'NORMAL',
              orderTime: new Date(T0.getTime() - 300 * 60_000),
              expectedDispatchTime: new Date(T0.getTime() - 30 * 60_000),
              status: 'DISPATCHED',
              items: [{ sku: 'SKU-15', orderedQuantity: 3, pickedQuantity: 3, packedQuantity: 3 }],
            },
          ],
          dispatch: [{ orderId: 'VAL-S15-ORD', truckId: 'TRUCK-15', carrier: 'CARRIER-15', dock: 'D3', loadingTime: new Date(T0.getTime() - 40 * 60_000), departureTime: new Date(T0.getTime() - 35 * 60_000) }],
        },
      },
    ],
  },

  // ------------------------------------------------------------------------------------
  // SCENARIO 16 — FALSE NEGATIVE: exception occurs but no meaningful prediction preceded it.
  // ------------------------------------------------------------------------------------
  // A genuine gap, not a fabricated one: PickingDelayPredictor's largest weight (35 of 100,
  // thresholds.prediction.pickingDelay.weights.durationVsBaseline) requires a historical
  // baseline of >= minBaselineSamples (5) COMPLETED tasks (see picking-delay.predictor.ts).
  // With zero completed tasks anywhere in this scenario, that signal is omitted entirely
  // (never fabricated). The task also has no matching order (SLA_REMAINING omitted, like
  // S04/S05), no items (TASK_COMPLEXITY contributes 0) and no errors (RECORDED_ERRORS
  // contributes 0) — so the ONLY signal that can ever fire is ELAPSED_VS_STUCK_THRESHOLD,
  // capped at weights.elapsedVsThreshold (20). That is below thresholds.prediction.riskLevel
  // .medium (30), so this (predictionType, entity) episode never reaches a "meaningful"
  // risk level (validationConfig.meaningfulRiskLevels) at any point on the timeline —
  // buildEpisodeSnapshot() correctly returns null even though the real PredictionEngine did
  // evaluate this task on every run and persisted a real (LOW-risk) row for it. Meanwhile
  // PickingDelayRule fires on the exact same fixed 60-minute stuck threshold regardless of
  // baseline availability (picking-delay.rule.ts), so PICKING_DELAY still opens — a real
  // exception with no preceding meaningful prediction.
  {
    scenarioId: 'S16',
    name: 'PICKING_DELAY_MISSED_NO_BASELINE',
    description:
      'Task has no historical baseline, no linked order, no complexity and no errors, so the predictor never crosses MEDIUM risk (caps at 20) even as elapsed time passes the 60-minute stuck threshold and PICKING_DELAY opens — a genuine FALSE_NEGATIVE.',
    t0: T0,
    targets: [{ predictionType: PredictionType.PICKING_DELAY_RISK, entityType: EntityType.PICKING_TASK, entityId: 'VAL-S16-TASK', expectedResult: 'FALSE_NEGATIVE' }],
    timeline: [
      {
        offsetMinutes: 0,
        label: 'Task started 30 minutes ago; no completed tasks anywhere (no baseline), no linked order',
        state: {
          pickingTasks: [
            { taskId: 'VAL-S16-TASK', orderId: 'VAL-S16-ORD', pickerId: 'PICKER-16', locationId: 'A1', startTime: new Date(T0.getTime() - 30 * 60_000), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
          ],
        },
      },
      {
        offsetMinutes: 31,
        label: 'Elapsed now 61 minutes — PICKING_DELAY opens; predictor risk score is still only 20 (LOW)',
        state: {
          pickingTasks: [
            { taskId: 'VAL-S16-TASK', orderId: 'VAL-S16-ORD', pickerId: 'PICKER-16', locationId: 'A1', startTime: new Date(T0.getTime() - 30 * 60_000), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS', items: [] },
          ],
        },
      },
    ],
  },
];
