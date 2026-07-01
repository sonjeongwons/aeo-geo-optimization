"use server";

/**
 * apps/web/lib/actions/templates.ts
 *
 * Server Actions for staff template review/activate/edit operations.
 *
 * SECURITY:
 *  - Every action calls requireStaff() first; non-staff get a 403 error.
 *  - industry_template is STAFF-ONLY: it has no customer_id and activation is
 *    industry-global (it demotes the prior active row + emits YAML for ALL
 *    customers using that industry). A customer must NEVER reach these actions.
 *  - `by` = staff session email, stamped as reviewed_by for §12 audit trail.
 *
 * The actions call the EXACT same functions the CLI uses:
 *   actionReviewed / actionActive / actionEdit from src/cli/reviewTemplate.ts
 *
 * The production ReviewRepo is built lazily (dynamic imports of pg/kysely)
 * to avoid bundling server-only modules into the client bundle.
 * The production MaterializePort calls src/generate/materialize.ts.
 */

import { revalidatePath } from "next/cache";
import { requireStaff, ScopeError } from "../session";
import {
  actionReviewed,
  actionActive,
  actionEdit,
  InvalidStatusTransitionError,
  PayloadValidationError,
  type ReviewRepo,
  type MaterializePort,
  type TemplateRow,
  type MaterializeCtx,
} from "@engine/cli/reviewTemplate";

// ---------------------------------------------------------------------------
// Production repo — mirrors makeProductionRepo() from the CLI but as a module-
// level factory so it is constructed fresh per Server Action invocation.
// ---------------------------------------------------------------------------

function makeProductionRepo(): ReviewRepo {
  return {
    async getIndustryTemplate(id: string) {
      const { getIndustryTemplate } = await import("@engine/db/repo");
      return getIndustryTemplate(id);
    },

    async updateTemplateStatus(id, status, reviewedBy) {
      const { updateTemplateStatus } = await import("@engine/db/repo");
      return updateTemplateStatus(id, status, reviewedBy);
    },

    async demoteActiveTemplate(industry) {
      const { demoteActiveTemplate } = await import("@engine/db/repo");
      return demoteActiveTemplate(industry);
    },

    async nextTemplateVersion(industry) {
      const { nextTemplateVersion } = await import("@engine/db/repo");
      return nextTemplateVersion(industry);
    },

    async insertIndustryTemplate(t) {
      const { insertIndustryTemplate } = await import("@engine/db/repo");
      return insertIndustryTemplate(t);
    },

    async withTransaction(fn) {
      const { getDb } = await import("@engine/db/kysely");
      await getDb()
        .transaction()
        .execute(async (trx) => {
          const txRepo: ReviewRepo = {
            async getIndustryTemplate(id: string) {
              const { getIndustryTemplate } = await import("@engine/db/repo");
              return getIndustryTemplate(id);
            },
            async updateTemplateStatus(id, status, reviewedBy) {
              const { updateTemplateStatus } = await import("@engine/db/repo");
              return updateTemplateStatus(id, status, reviewedBy, trx as never);
            },
            async demoteActiveTemplate(industry) {
              const { demoteActiveTemplate } = await import("@engine/db/repo");
              return demoteActiveTemplate(industry, trx as never);
            },
            async nextTemplateVersion(industry) {
              const { nextTemplateVersion } = await import("@engine/db/repo");
              return nextTemplateVersion(industry);
            },
            async insertIndustryTemplate(t) {
              const { insertIndustryTemplate } = await import("@engine/db/repo");
              return insertIndustryTemplate(t);
            },
            async withTransaction(innerFn) {
              await innerFn(txRepo);
            },
          };
          await fn(txRepo);
        });
    },
  };
}

function makeProductionMaterializePort(): MaterializePort {
  return {
    async materialize(row: TemplateRow, ctx: MaterializeCtx) {
      const { materialize } = await import("@engine/generate/materialize");
      return materialize(row, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// reviewTemplate — transition draft → reviewed
// ---------------------------------------------------------------------------

/**
 * Mark a template as reviewed (draft → reviewed).
 *
 * §5.5 gate: status must be 'draft'.
 * `by` = staff session email (§12 audit).
 */
export async function reviewTemplate(
  templateId: string,
): Promise<{ ok: boolean; error?: string; result?: { industry: string; version: number } }> {
  let staffEmail: string;
  try {
    const session = await requireStaff();
    staffEmail = session.email;
  } catch (err) {
    if (err instanceof ScopeError) {
      return { ok: false, error: "스태프 권한이 필요합니다." };
    }
    return { ok: false, error: "인증이 필요합니다." };
  }

  const repo = makeProductionRepo();

  try {
    const result = await actionReviewed(templateId, staffEmail, repo);
    revalidatePath("/staff/templates");
    return { ok: true, result: { industry: result.industry, version: result.version } };
  } catch (err) {
    if (err instanceof InvalidStatusTransitionError) {
      return { ok: false, error: `상태 전환 오류: ${err.message}` };
    }
    if (err instanceof PayloadValidationError) {
      return { ok: false, error: `페이로드 검증 실패: ${err.message}` };
    }
    console.error("[templates.action] reviewTemplate error:", err);
    return { ok: false, error: "검토 처리 중 오류가 발생했습니다." };
  }
}

// ---------------------------------------------------------------------------
// activateTemplate — transition reviewed → active
// ---------------------------------------------------------------------------

/**
 * Activate a template (reviewed → active).
 *
 * §5.5 gate: refuses if status is 'draft' (InvalidStatusTransitionError).
 * Inside ONE transaction: demotes prior active → promotes this one.
 * Then materializes YAML + upserts DB rows.
 *
 * This is a HEAVY, side-effectful operation:
 *   - Demotes the industry's prior active template to 'reviewed'.
 *   - Sets this template to 'active'.
 *   - Emits config/customers/<slug>.yaml via materialize().
 *   - Upserts all DB rows (customer, brand, competitor, question, budget, language).
 *
 * `by` = staff session email (§12 audit).
 */
export async function activateTemplate(
  templateId: string,
): Promise<{
  ok: boolean;
  error?: string;
  result?: {
    industry: string;
    version: number;
    yamlPath: string;
    questionCount: number;
    competitorCount: number;
  };
}> {
  let staffEmail: string;
  try {
    const session = await requireStaff();
    staffEmail = session.email;
  } catch (err) {
    if (err instanceof ScopeError) {
      return { ok: false, error: "스태프 권한이 필요합니다." };
    }
    return { ok: false, error: "인증이 필요합니다." };
  }

  const repo = makeProductionRepo();
  const materializePort = makeProductionMaterializePort();

  try {
    const result = await actionActive(
      templateId,
      staffEmail,
      repo,
      materializePort,
      // materializeCtx: let actionActive derive from the template row.
      undefined,
    );
    revalidatePath("/staff/templates");
    return {
      ok: true,
      result: {
        industry: result.industry,
        version: result.version,
        yamlPath: result.yamlPath,
        questionCount: result.questionCount,
        competitorCount: result.competitorCount,
      },
    };
  } catch (err) {
    if (err instanceof InvalidStatusTransitionError) {
      return {
        ok: false,
        error: `상태 전환 오류 (§5.5 게이트): ${err.message}`,
      };
    }
    if (err instanceof PayloadValidationError) {
      return { ok: false, error: `페이로드 검증 실패: ${err.message}` };
    }
    console.error("[templates.action] activateTemplate error:", err);
    return { ok: false, error: "활성화 처리 중 오류가 발생했습니다." };
  }
}

// ---------------------------------------------------------------------------
// editTemplate — create a new draft version from an existing template
// ---------------------------------------------------------------------------

/**
 * Create a new draft version of a template from a JSON payload string.
 *
 * The original row is NEVER mutated — this is append-only (new draft, version+1).
 * Validates questions/competitors before inserting.
 *
 * `filePath` is a server-side path to the JSON file, OR we accept a JSON
 * string payload directly for web use (written to a temp file).
 *
 * For the web UI we accept a raw JSON string payload (since the browser can't
 * pass file paths). We write it to a temp file on the server and call actionEdit.
 */
export async function editTemplate(
  templateId: string,
  payloadJson: string,
): Promise<{
  ok: boolean;
  error?: string;
  result?: { newTemplateId: string; industry: string; newVersion: number };
}> {
  let staffEmail: string;
  try {
    const session = await requireStaff();
    staffEmail = session.email;
  } catch (err) {
    if (err instanceof ScopeError) {
      return { ok: false, error: "스태프 권한이 필요합니다." };
    }
    return { ok: false, error: "인증이 필요합니다." };
  }

  // Write payload to a temp file so actionEdit can read it.
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");

  const tmpPath = join(tmpdir(), `aeo-template-edit-${randomUUID()}.json`);

  try {
    writeFileSync(tmpPath, payloadJson, "utf-8");
  } catch (err) {
    return { ok: false, error: `임시 파일 작성 실패: ${String(err)}` };
  }

  const repo = makeProductionRepo();

  try {
    const result = await actionEdit(templateId, tmpPath, repo, staffEmail);
    revalidatePath("/staff/templates");
    return {
      ok: true,
      result: {
        newTemplateId: result.newTemplateId,
        industry: result.industry,
        newVersion: result.newVersion,
      },
    };
  } catch (err) {
    if (err instanceof PayloadValidationError) {
      return { ok: false, error: `페이로드 검증 실패: ${err.message}` };
    }
    console.error("[templates.action] editTemplate error:", err);
    return { ok: false, error: "편집 처리 중 오류가 발생했습니다." };
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}
