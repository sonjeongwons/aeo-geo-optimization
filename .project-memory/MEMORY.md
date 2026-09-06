# Memory Index

- [Project: AEO/GEO Phase 0](project-aeo-geo-phase0.md) — what we're building, stack/DB/key decisions
- [Design reference: gpto.kr](ref-gpto-design.md) — feature/constraint + future-UI benchmark
- [Working style: workflows + model split](feedback-workflow-model-split.md) — always run cross-checking workflows; Opus=design, Sonnet=code
- [Project: SMIM hub](project-smim-hub.md) — 2nd customer, live smim-branded GitHub Pages hub + publish flow
- [Reference: Korean claim binding](reference-korean-claim-binding.md) — CJK tokenizer/stem fix; numeral gap now fixed, see reference-verifiable-numbers-gate-fix
- [Reference: verifiableNumbersGate fix](reference-verifiable-numbers-gate-fix.md) — 2026-09-06: cheap gates checked ctx.claimSources, not empty asset.claims; 유튜브 프리미엄 exception; facts.json numeric-kind lesson
- [Project: AEO/GEO quality overhaul](project-aeo-geo-quality-overhaul.md) — 2026-07 audit roadmap W1-W10; shipped render/hub/content/email/dashboard; remaining W1 gate-plumbing + W10 off-site
- [Multi-PC git sync](feedback-multipc-git-sync.md) — git is source of truth; pull before, push+memory(HANDOFF) after
- [Prod Neon ids](reference-prod-timescale-ids.md) — live emora/unsanpartners/sharejoa ids on Neon (Timescale DB deleted 2026-09-05); localhost≠prod trap
- [Project: Neon migration](project-neon-migration.md) — why/how DB moved off TimescaleDB Cloud to Neon, verified end-to-end
- [Project: unsanpartners onboarding](project-unsanpartners-onboarding.md) — 3rd customer (운산파트너스) — ✅ completed, live
- [Project: sharejoa onboarding](project-sharejoa-onboarding.md) — 4th customer (쉐어조아) — onboarded, gate bug fixed, still 0 live pages (transient?)
- [Reference: Gemini multi-key rotation](reference-gemini-multikey.md) — GEMINI_API_KEYS round-robin + key-format lesson + model-deprecation fix
