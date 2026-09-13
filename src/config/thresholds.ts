/**
 * Tunable numbers for every rule, centralized so business thresholds aren't scattered
 * as magic numbers across rule files. Candidates for moving to env/DB-backed config
 * once rules need to be tunable per-warehouse without a code change.
 */
export const thresholds = {
  inventoryShortage: { medium: 0.25, high: 0.5, critical: 0.75 },
  inventoryDiscrepancy: { medium: 0.1, high: 0.3, critical: 0.6 },
  pickingDelay: {
    stuckAfterMinutes: 60,
    severity: { medium: 60, high: 120, critical: 240 },
  },
  pickingError: { medium: 1, high: 3, critical: 5 },
  excessivePickingTime: { medium: 1.5, high: 2, critical: 3 },
  excessivePickerDistance: { medium: 1.5, high: 2, critical: 3 },
  slaAtRisk: {
    windowMinutes: 120,
    severity: { medium: 0.5, high: 0.8, critical: 1.0 },
  },
  packingDelay: {
    thresholdMinutes: 60,
    severity: { medium: 60, high: 180, critical: 360 },
  },
  dispatchDelay: {
    thresholdMinutes: 60,
    severity: { medium: 60, high: 240, critical: 480 },
  },
  highReturnRate: {
    windowDays: 30,
    minOrderedForSignificance: 5,
    severity: { medium: 0.05, high: 0.1, critical: 0.2 },
  },
  /**
   * Root Cause Engine scoring. Every candidate cause is scored by summing whichever of
   * these named rules its correlated evidence matches — never an arbitrary/hardcoded
   * confidence number. `confidenceScore` turns a candidate's total into HIGH/MEDIUM/LOW;
   * no single rule below is worth enough on its own to reach HIGH, so a candidate needs
   * at least two independent corroborating facts to be reported with high confidence.
   */
  rootCause: {
    // Shared across every analyzer, not per-type: a candidate needs at least two
    // independent corroborating facts to cross into HIGH, since no single scoring rule
    // in any analyzer below is worth `high` on its own.
    confidenceScore: { high: 70, medium: 40 },
    pickingDelay: {
      pickerOverload: { mediumConcurrentTasks: 2, highConcurrentTasks: 3 },
      complexity: { itemCountHigh: 8, totalQuantityHigh: 20, distinctLocationsHigh: 4 },
      weights: {
        inventoryShortage: { pendingSkuMatch: 50, pickedOnlySkuMatch: 20, highSeverity: 25, multipleSkus: 15 },
        inventoryDiscrepancy: { exactMatch: 50, skuOnlyMatch: 25, multipleItems: 15, highSeverity: 10 },
        pickingError: { sameTask: 50, highErrorCount: 25, mediumErrorCount: 10, pendingItemAffected: 15 },
        excessivePickerDistance: { sameTask: 50, criticalRatio: 30, highRatio: 20, mediumRatio: 10 },
        excessivePickingTime: {
          observed: { sameTask: 50, criticalRatio: 30, highRatio: 20, mediumRatio: 10 },
          inferred: { criticalRatio: 40, highRatio: 25, mediumRatio: 15 },
        },
        pickerOverload: { high: 40, medium: 20 },
        highOrderComplexity: { itemCount: 30, totalQuantity: 20, distinctLocations: 20 },
      },
    },
    pickingError: {
      pickerPerformance: { mediumRecurringErrors: 2, highRecurringErrors: 4 },
      complexity: { itemCountHigh: 8, errorDensityHigh: 0.3 },
      weights: {
        inventoryDiscrepancy: { exactMatch: 50, skuOnlyMatch: 25, multipleItems: 15, highSeverity: 10 },
        inventoryShortage: { skuMatch: 50, highSeverity: 25, multipleSkus: 15, stockRelatedReason: 10 },
        locationMismatch: { anyMatch: 50, multipleMatches: 25, majorityOfErrors: 15 },
        highPickingComplexity: { itemCount: 30, errorDensity: 25, multipleSkus: 15 },
        pickerPerformance: { high: 40, medium: 20 },
      },
    },
    inventoryShortage: {
      // Fraction of the shortfall that damage/over-reservation must cover to count as
      // "explaining" it, and the fraction that must be unexplained for STOCK_DEPLETION
      // to be scored as the residual, no-alternative-explanation cause.
      explanationCoverageRatio: 0.5,
      weights: {
        reservationOverAllocation: { anyLocation: 50, explainsShortfall: 30, multipleLocations: 15 },
        damagedInventory: { explainsShortfall: 50, fullyExplains: 25, multipleLocations: 15 },
        // Reuses thresholds.inventoryShortage's own medium/high/critical ratio bands —
        // the same numbers the detection rule used to set this exception's severity.
        stockDepletion: { criticalRatio: 40, highRatio: 25, mediumRatio: 10, zeroAvailable: 30, noOtherExplanation: 15 },
        inventoryDiscrepancy: { exactMatch: 50, skuOnlyMatch: 25, multipleLocations: 15, highSeverity: 10 },
      },
    },
    inventoryDiscrepancy: {
      weights: {
        damagedInventory: { damageExceedsQuantity: 50, damageExceedsReservation: 20, multipleLocationsDamaged: 15 },
        pickingError: { exactMatch: 50, stockRelatedReason: 20, multipleMatches: 15 },
        // The residual, no-alternative-explanation cause — there is no receiving/movement-log
        // table in this schema, so a reservation-only mismatch defaults to a record-keeping error.
        stockRecordError: { reservationMismatchUnexplained: 40, noCompetingExplanation: 20 },
      },
    },
    slaAtRisk: {
      // Unlike every other analyzer, primary-cause selection here is chain-position-based
      // (earliest supported pipeline stage wins), not score-based — score only breaks ties
      // between multiple correlated causes at the same stage. See the analyzer for PIPELINE_ORDER.
      weights: { anyMatch: 50, highSeverity: 25, multipleMatches: 15 },
    },
    excessivePickerDistance: {
      complexity: { distinctLocationsHigh: 4, spreadRatioHigh: 0.8, itemCountHigh: 8 },
      pickerPattern: { mediumRecurring: 2, highRecurring: 4 },
      weights: {
        multiLocationOrder: { distinctLocations: 50, spreadRatio: 25, itemCount: 15 },
        poorLocationAssignment: { high: 40, medium: 20 },
      },
    },
    excessivePickingTime: {
      complexity: { itemCountHigh: 8, totalQuantityHigh: 20 },
      weights: {
        pickingError: { sameTask: 50, highErrorCount: 25, mediumErrorCount: 10 },
        excessivePickerDistance: { sameTask: 50, criticalRatio: 30, highRatio: 20, mediumRatio: 10 },
        inventoryDiscrepancy: { exactMatch: 50, skuOnlyMatch: 25, multipleItems: 15, highSeverity: 10 },
        highItemCount: { itemCount: 50, totalQuantity: 30 },
      },
    },
    packingDelay: {
      complexity: { itemCountHigh: 8, totalQuantityHigh: 20 },
      backlog: { mediumOtherOrders: 5, highOtherOrders: 15 },
      weights: {
        pickingDelay: { anyMatch: 50, highSeverity: 25, multipleMatches: 15 },
        orderComplexity: { itemCount: 50, totalQuantity: 30 },
        queueBacklog: { high: 40, medium: 20 },
      },
    },
    dispatchDelay: {
      dockCongestion: { mediumOtherOrders: 2, highOtherOrders: 5 },
      weights: {
        packingDelay: { anyMatch: 50, highSeverity: 25, multipleMatches: 15 },
        pickingDelay: { anyMatch: 50, highSeverity: 25, multipleMatches: 15 },
        // Reuses thresholds.dispatchDelay's own severity bands for how long the order has
        // sat loaded-but-not-departed — the same numbers the detection rule itself uses.
        loadingDelay: { baseFact: 50, criticalRatio: 30, highRatio: 20, mediumRatio: 10 },
        dockCongestion: { high: 40, medium: 20 },
      },
    },
    highReturnRate: {
      sampleSize: { smallSampleThreshold: 3, recurringThreshold: 2, highVolumeThreshold: 5, majorityRatio: 0.5 },
      weights: {
        returnReason: { base: 30, recurring: 20, majority: 20, highVolume: 20 },
        pickingError: { anyMatch: 50, highSeverity: 25, multipleMatches: 15 },
      },
    },
  },
  /**
   * Recommendation Engine scoring — one shared 5-factor rubric (see recommendation/shared.ts
   * scoreCandidateAction) reused by every recommender, rather than a bespoke rubric per type.
   * Mirrors thresholds.rootCause's philosophy: named, additive, explainable, capped at 100.
   */
  recommendation: {
    weights: {
      rootCauseMatch: 30,
      contributingCauseMatch: 15,
      genericFallback: 5,
      evidenceHigh: 25,
      evidenceMedium: 15,
      evidenceLow: 8,
      slaUrgent: 20,
      slaSeverity: 12,
      operationalConfirmed: 15,
      operationalPlausible: 8,
      riskLow: 10,
      riskMedium: 5,
    },
    // An order is treated as SLA-urgent when less than this many minutes remain (or it has
    // already breached) — used to boost PRIORITIZE-type actions over slower ones like REPLENISH.
    slaUrgentMinutesRemaining: 60,
  },
  /**
   * Action/Outcome Engine — turns a simulated before/after percentage improvement into a
   * deterministic OutcomeResult (src/actions/outcome-engine.ts). Mirrors the recommendation
   * rubric's philosophy: named, explainable bands, not an arbitrary single cutoff.
   */
  actionEngine: {
    outcome: {
      // >= this improvement on the primary metric is SUCCESS; > 0 but below it is PARTIAL_SUCCESS;
      // <= 0 is NO_IMPROVEMENT. A failed simulation is always FAILED regardless of these bands.
      successImprovementPercentage: 20,
    },
  },
  /**
   * Prediction/Risk Scoring Engine (src/predictors/) — deterministic, explainable, rule-based
   * risk scoring. Every predictor produces a 0-100 additive score from named signal weights
   * (same philosophy as thresholds.rootCause/recommendation above), classified into a
   * RiskLevel band by `riskLevel` below. riskScore is NOT a calibrated statistical
   * probability — see ARCHITECTURE.md's "Prediction vs exception detection" section.
   */
  prediction: {
    // Ascending breakpoints a 0-100 risk score must reach to be classified at each band.
    riskLevel: { medium: 30, high: 60, critical: 80 },
    slaBreach: {
      // How far ahead of the actual SLA_AT_RISK detection window (thresholds.slaAtRisk.windowMinutes)
      // this predictor starts flagging risk — deliberately wider so risk surfaces before detection does.
      windowMinutes: 240,
      weights: {
        slaUrgency: 40,
        pickingIncomplete: 25,
        packingIncomplete: 15,
        priorityUrgent: 10,
        priorityHigh: 5,
        itemsPending: 10,
      },
    },
    pickingDelay: {
      // Minimum COMPLETED tasks required before a historical duration baseline is trusted;
      // below this, the PICKING_DURATION signal is omitted (never a fabricated baseline) —
      // see PickingDelayPredictor for how the baseline itself is computed.
      minBaselineSamples: 5,
      // How far past the historical baseline duration (as a multiple, e.g. 1.5 = 50% over)
      // the PICKING_DURATION signal needs to reach before it fully saturates (shared.ts's
      // overageRatio, called with this instead of its 2.0x default). Typical baselines in
      // this system (~25-35min) sit well under the fixed 60min stuck threshold
      // (thresholds.pickingDelay.stuckAfterMinutes), so requiring a full 100% overage before
      // this signal contributes its maximum leaves very little runway for an early warning —
      // a task already running 50% over its own historical average is already a meaningfully
      // underperforming outlier, not a borderline case that needs 2x confirmation. Lowering
      // this from 2.0 to 1.5 was measured to move the MEDIUM-risk crossing point for a
      // representative 30min-baseline task from elapsed=44min to elapsed=38min — 6 extra
      // minutes of lead time before the fixed 60min stuck threshold, with zero change at
      // elapsed=0 (no new early false alarms) and identical behavior once fully saturated.
      durationBaselineSaturationRatio: 1.5,
      weights: {
        durationVsBaseline: 35,
        slaUrgency: 30,
        elapsedVsThreshold: 20,
        highComplexity: 10,
        hasErrors: 5,
      },
    },
    inventoryShortage: {
      weights: {
        pendingDemandShortfall: 50,
        reorderProximity: 30,
        damagedExposure: 20,
      },
    },
    dispatchDelay: {
      // How far ahead of the actual DISPATCH_DELAY detection threshold (thresholds.dispatchDelay.thresholdMinutes)
      // this predictor starts flagging risk once an order is packed but not yet departed.
      windowMinutes: 240,
      weights: {
        slaUrgency: 35,
        packingElapsedVsThreshold: 30,
        pickingIncomplete: 20,
        notYetPacked: 15,
      },
    },
  },
} as const;
