/**
 * src/content/index.ts
 *
 * Barrel index for the Phase 2 content-variant generation module.
 *
 * This module generates offsite content variants (definition, answer_block,
 * faq, comparison, case_study, jsonld) gated through real §7 guardrail gates
 * and queued for Phase 3 deployment. It NEVER deploys or touches a customer
 * property (§0 off-site constraint).
 *
 * Sub-modules are exported here as they are implemented by the parallel
 * task agents (T03–T15). Each sub-module is a separate file; this barrel
 * is the public surface for CLI and pipeline consumers.
 */

// Types are the foundation — re-exported for all consumers once T03 lands.
// export * from './types.js';

// Word-count policy (T05)
// export * from './wordCount.js';

// Channel-content matrix (T05)
// export * from './channelContentMatrix.js';

// Content matrix builder (T06)
// export * from './contentMatrix.js';

// Prompt builder + per-language generation (T07)
// export * from './generationPromptContent.js';
// export * from './generateContentForLanguage.js';

// Multilingual orchestration (T08)
// export * from './multilingualContent.js';

// Claim extraction (T09)
// export * from './claimExtract.js';

// Claim verification (T10)
// export * from './claimVerify.js';

// JSON-LD builders (T13)
// export * from './jsonld.js';

// Content gate fold (T12)
// export * from './contentGate.js';

// Assemble + queue (T15)
// export * from './assembleContentSet.js';
// export * from './queueForDeploy.js';
