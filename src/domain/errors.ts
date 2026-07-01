/**
 * Typed domain errors — no pg, no @google/genai.
 * Used across judge, budget, guardrails, and pipeline layers.
 */

// ---------------------------------------------------------------------------
// Base domain error
// ---------------------------------------------------------------------------

export class AeoGeoError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "AeoGeoError";
  }
}

// ---------------------------------------------------------------------------
// Provider / adapter errors
// ---------------------------------------------------------------------------

export class ProviderError extends AeoGeoError {
  constructor(
    message: string,
    public readonly provider: string,
    code: string = "PROVIDER_ERROR"
  ) {
    super(message, code);
    this.name = "ProviderError";
  }
}

export class NotConfiguredError extends ProviderError {
  constructor(provider: string) {
    super(
      `Provider "${provider}" is not configured (missing API key).`,
      provider,
      "NOT_CONFIGURED"
    );
    this.name = "NotConfiguredError";
  }
}

export class RateLimitedError extends ProviderError {
  constructor(provider: string, message?: string) {
    super(
      message ?? `Provider "${provider}" returned a rate-limit error.`,
      provider,
      "RATE_LIMITED"
    );
    this.name = "RateLimitedError";
  }
}

export class TimeoutError extends ProviderError {
  constructor(provider: string) {
    super(`Provider "${provider}" request timed out.`, provider, "TIMEOUT");
    this.name = "TimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Judge errors
// ---------------------------------------------------------------------------

export class JudgeParseError extends AeoGeoError {
  constructor(
    message: string,
    public readonly raw: unknown
  ) {
    super(message, "JUDGE_PARSE_FAILED");
    this.name = "JudgeParseError";
  }
}

export class JudgeEscalationError extends AeoGeoError {
  constructor(message: string) {
    super(message, "JUDGE_ESCALATION_FAILED");
    this.name = "JudgeEscalationError";
  }
}

// ---------------------------------------------------------------------------
// Budget / cost errors
// ---------------------------------------------------------------------------

export class BudgetExceededError extends AeoGeoError {
  constructor(
    message: string,
    public readonly customerId: string,
    public readonly capType: "weekly" | "monthly" | "shape"
  ) {
    super(message, "BUDGET_EXCEEDED");
    this.name = "BudgetExceededError";
  }
}

export class CostDataMissingError extends AeoGeoError {
  constructor(customerId: string) {
    super(
      `Cost data missing for customer "${customerId}". Failing closed per §11.`,
      "COST_DATA_MISSING"
    );
    this.name = "CostDataMissingError";
    this.customerId = customerId;
  }
  public readonly customerId: string;
}

// ---------------------------------------------------------------------------
// Guardrail errors
// ---------------------------------------------------------------------------

export class GuardrailViolationError extends AeoGeoError {
  constructor(
    message: string,
    public readonly gateName: string
  ) {
    super(message, "GUARDRAIL_VIOLATION");
    this.name = "GuardrailViolationError";
  }
}

// ---------------------------------------------------------------------------
// Config / template errors
// ---------------------------------------------------------------------------

export class TemplateValidationError extends AeoGeoError {
  constructor(
    message: string,
    public readonly details?: unknown
  ) {
    super(message, "TEMPLATE_VALIDATION_ERROR");
    this.name = "TemplateValidationError";
  }
}

export class CustomerNotFoundError extends AeoGeoError {
  constructor(slug: string) {
    super(`Customer "${slug}" not found.`, "CUSTOMER_NOT_FOUND");
    this.name = "CustomerNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Pipeline errors
// ---------------------------------------------------------------------------

export class PipelineError extends AeoGeoError {
  constructor(
    message: string,
    code: string = "PIPELINE_ERROR"
  ) {
    super(message, code);
    this.name = "PipelineError";
  }
}

export class RunNotFoundError extends AeoGeoError {
  constructor(runId: string) {
    super(`Run "${runId}" not found.`, "RUN_NOT_FOUND");
    this.name = "RunNotFoundError";
  }
}
