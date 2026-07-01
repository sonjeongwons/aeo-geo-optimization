/**
 * src/cost/alerts.ts
 *
 * Cost alerting — checkThreshold() compares rolling spend against a fraction
 * of the configured cap and fires an AlertSink when the threshold is crossed.
 *
 * Design rules (DESIGN.md §11):
 * - checkThreshold(%) reads from the cost_daily CAGG (via CostReadPort).
 * - AlertSink is pluggable: pino logger now, webhook later.
 * - Threshold is configured per environment (COST_ALERT_THRESHOLD in env.ts,
 *   default 0.8 = 80% of cap).
 * - Both weekly and monthly caps are checked independently.
 * - This module has NO direct DB import — it uses the CostReadPort seam.
 */

import type { Budget } from "../domain/types.js";
import type { CostReadPort } from "./budget.js";

// ---------------------------------------------------------------------------
// AlertSink — pluggable output
// ---------------------------------------------------------------------------

export type AlertLevel = "warning" | "critical";

export interface CostAlert {
  customerId: string;
  capType: "weekly" | "monthly";
  level: AlertLevel;
  spentUsd: number;
  capUsd: number;
  fractionUsed: number; // [0, 1]
  threshold: number;    // the configured threshold [0, 1]
  message: string;
}

/**
 * AlertSink — receives a CostAlert and dispatches it.
 * Production default: pino-based logger.
 * Phase 2+: webhook / Slack / PagerDuty adapter.
 */
export interface AlertSink {
  fire(alert: CostAlert): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Pino-based AlertSink (default for Phase 0)
// ---------------------------------------------------------------------------

/**
 * Minimal pino-compatible logger interface.
 * Keeps alerts.ts free from a hard pino import so tests can pass a console stub.
 */
export interface AlertLogger {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Creates the default AlertSink backed by a pino logger.
 * Level < 1.0 → warn; level = 1.0 → error (cap reached).
 */
export function createPinoAlertSink(logger: AlertLogger): AlertSink {
  return {
    fire(alert: CostAlert): void {
      const logFn =
        alert.fractionUsed >= 1.0 ? logger.error.bind(logger) : logger.warn.bind(logger);
      logFn(
        {
          customerId: alert.customerId,
          capType: alert.capType,
          level: alert.level,
          spentUsd: alert.spentUsd,
          capUsd: alert.capUsd,
          fractionUsed: alert.fractionUsed,
          threshold: alert.threshold,
        },
        alert.message
      );
    },
  };
}

// ---------------------------------------------------------------------------
// checkThreshold — main alerting function
// ---------------------------------------------------------------------------

export interface CheckThresholdInput {
  customerId: string;
  budget: Budget;
  /**
   * Fraction of cap at which to fire [0, 1].
   * e.g. 0.8 = fire when 80% of the weekly or monthly cap is consumed.
   * Defaults to 0.8 if not provided.
   */
  threshold?: number;
  costReader: CostReadPort;
  alertSink: AlertSink;
}

export interface CheckThresholdResult {
  weeklyFraction: number | null;   // null = no spend data yet
  monthlyFraction: number | null;
  weeklyAlert: boolean;
  monthlyAlert: boolean;
}

/**
 * Read rolling spend from cost_daily and fire alerts when spend exceeds the
 * threshold fraction of the configured cap.
 *
 * Both weekly (7-day) and monthly (30-day) caps are checked independently.
 * When cost data is missing (null), the check is silently skipped for that
 * window (the customer has no spend yet — not an error in the alert path;
 * the budget gate handles fail-closed separately).
 */
export async function checkThreshold(
  input: CheckThresholdInput
): Promise<CheckThresholdResult> {
  const {
    customerId,
    budget,
    threshold = 0.8,
    costReader,
    alertSink,
  } = input;

  const [weeklySpent, monthlySpent] = await Promise.all([
    costReader.getRollingSpendUsd(customerId, 7),
    costReader.getRollingSpendUsd(customerId, 30),
  ]);

  const weeklyFraction =
    weeklySpent !== null ? weeklySpent / budget.weeklyUsdCap : null;
  const monthlyFraction =
    monthlySpent !== null ? monthlySpent / budget.monthlyUsdCap : null;

  let weeklyAlert = false;
  let monthlyAlert = false;

  // Weekly check
  if (weeklyFraction !== null && weeklyFraction >= threshold) {
    weeklyAlert = true;
    const level: AlertLevel = weeklyFraction >= 1.0 ? "critical" : "warning";
    const alert: CostAlert = {
      customerId,
      capType: "weekly",
      level,
      spentUsd: weeklySpent!,
      capUsd: budget.weeklyUsdCap,
      fractionUsed: weeklyFraction,
      threshold,
      message:
        level === "critical"
          ? `[CRITICAL] Customer ${customerId} has REACHED weekly USD cap ($${weeklySpent!.toFixed(4)} / $${budget.weeklyUsdCap}).`
          : `[WARNING] Customer ${customerId} has used ${(weeklyFraction * 100).toFixed(1)}% of weekly USD cap ($${weeklySpent!.toFixed(4)} / $${budget.weeklyUsdCap}).`,
    };
    await alertSink.fire(alert);
  }

  // Monthly check
  if (monthlyFraction !== null && monthlyFraction >= threshold) {
    monthlyAlert = true;
    const level: AlertLevel = monthlyFraction >= 1.0 ? "critical" : "warning";
    const alert: CostAlert = {
      customerId,
      capType: "monthly",
      level,
      spentUsd: monthlySpent!,
      capUsd: budget.monthlyUsdCap,
      fractionUsed: monthlyFraction,
      threshold,
      message:
        level === "critical"
          ? `[CRITICAL] Customer ${customerId} has REACHED monthly USD cap ($${monthlySpent!.toFixed(4)} / $${budget.monthlyUsdCap}).`
          : `[WARNING] Customer ${customerId} has used ${(monthlyFraction * 100).toFixed(1)}% of monthly USD cap ($${monthlySpent!.toFixed(4)} / $${budget.monthlyUsdCap}).`,
    };
    await alertSink.fire(alert);
  }

  return {
    weeklyFraction,
    monthlyFraction,
    weeklyAlert,
    monthlyAlert,
  };
}

// ---------------------------------------------------------------------------
// Multi-customer sweep (used by the periodic monitoring job)
// ---------------------------------------------------------------------------

export interface CustomerBudget {
  customerId: string;
  budget: Budget;
}

/**
 * Run checkThreshold for a list of customers.
 * Used by the scheduler's periodic cost-monitoring job.
 */
export async function sweepThresholds(
  customers: CustomerBudget[],
  costReader: CostReadPort,
  alertSink: AlertSink,
  threshold?: number
): Promise<CheckThresholdResult[]> {
  return Promise.all(
    customers.map((c) =>
      checkThreshold(
        threshold !== undefined
          ? { customerId: c.customerId, budget: c.budget, costReader, alertSink, threshold }
          : { customerId: c.customerId, budget: c.budget, costReader, alertSink }
      )
    )
  );
}
