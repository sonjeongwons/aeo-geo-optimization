# AEO/GEO Research-Driven Improvement Plan (2026-06-26)

Source: multi-agent web research sweep (6 sources: arXiv/academic, GitHub, Reddit/practitioner,
patents, HuggingFace/RAG, industry) → adversarial synthesis → adversarial critique.
60 findings. Run: wf_c3888c08-49a.

## Critique-corrected priority (DO IN THIS ORDER)

The synthesis ranked syndication (rank 1) first, but the adversarial critique demoted it:
rank-1 is highest-leverage but lowest-readiness (all external connectors are NOT_CONFIGURED
stubs; `dispatch.ts` only fans out to `status==='ready'` channels → fan-out is INERT today;
its headline evidence is vendor/correlational = medium, not high; and it's gated on
ToS/account-warming). **Measurement must come first** — Gemini cites in only ~8% of answers
(92% zero-citation) and is our ONLY live judge, so every other lever is currently measured
through a broken instrument.

### P0 — Fix measurement (rank 4) — makes everything else falsifiable
- **4a (needs key):** register a 2nd, higher-citing provider (Perplexity > OpenAI) for the judge.
  Build adapters NOW so a key flips it on. Files: `src/providers/{openai,anthropic,perplexity}.ts`, `registry.ts`, `index.ts`.
- **4b (code):** split brand MENTION (absorption) vs clickable CITATION in `src/judge/extractMention.ts`.
- **4c (code):** per-engine citation-budget SoV normalization (ChatGPT ~2.4x Perplexity) in `src/metrics/aggregate.ts`; model SMR per-question as binary pass/fail.
- **Report honesty:** caveat that Gemini-only under-counts; report RELATIVE SoV vs competitors (rank 13); stop attributing citation lift to schema (rank 11). Files: `src/metrics/report.ts`.

### P1 — On-page evidence density (rank 2) — peer-reviewed, reuses our gates
KDD 2024 (2311.09735): Statistics +41%, Quotation +28%, Cite-Sources +31%; +115% for low-rank pages.
Absorption (2604.25707): numbers +61.6%, definitions +57.3%, comparisons +55.3%.
Make stats[] (value+unit+source_year+source_id), quotation{}, citations[] incentivized structured
fields in `src/content/generationPromptContent.ts` + `src/content/types.ts`, ROUTED THROUGH the
existing `verifiableNumbers` + `claimVerification` gates (unsourced → stripped/needs_human; never fabricate).
Per-category selector: stats for factual/comparison; quotation for explanation/history.
CRITIQUE CAVEAT: GEO edits only help pages ALREADY in the candidate set — a brand-new page with no
inbound links isn't "low-ranked", it's "not retrieved". So P1 compounds with discovery (P3/links).

### P1 — Proposition-grade BLUF authoring + self-containedness gate (rank 3)
Retrieval/citation is PASSAGE-level (Dense X EMNLP24; Anthropic Contextual Retrieval -35% failure;
patents US12346366B2/US11481646B2; 44.2% citations from first 30%). Each section: H2 = the
question verbatim; first sentence = complete brand-named answer restating the question's nouns;
40-80w lead + 150-300w section; no cross-section pronouns. NEW gate `src/content/gates/selfContainedness.ts`.
Keep brand entity string LITERAL/constant (BM25 lexical) while varying surrounding sentences (§7).

### P1 — Adversarial blocklist gate (rank 12) — fail-closed, also a perf lever
Hidden text (display:none/white-on-white/font-size:0/offscreen/aria-hidden stuffing), prompt-injection
strings ("ignore previous instructions"), cloaking (crawler≠human content), AND **dateModified bumped
without content delta**. NEW `src/content/gates/adversarialBlocklist.ts` wired fail-closed into contentGate.
Perplexity's binary rerank gate means borderline-spam = TOTAL exclusion, so honesty == performance.

### P2 — Long-form pillar template (rank 8) + query fan-out coverage (rank 6)
Absorption: high-influence pages had 11.4x words, 12.5x heading density, 8.9x list density;
Definition(+57.3%)/Comparison(+55.3%) top; pure Q&A slightly NEGATIVE (-5.7%) → FAQ as a SECTION,
not the whole page. Add a "pillar" format: Definition block → Comparison table, dense H2/H3, 10-20
item listicles w/ disclosed methodology + pros/cons/pricing. Generate per-question fan-out:
compare-variant, use-case-variant, alternative-variant, 2-3 implied follow-ups — each ONE narrow page.
DerivateX "Authority Inversion": self-published "alternatives to X"/comparison = 51% of ChatGPT citations.

### P2 — Freshness, CHANGE-triggered (rank 7) — §7 hazard if time-triggered
Emit real datePublished + dateModified in `jsonld.ts` (currently null) + visible on-page date.
Republish job MUST regenerate content first and restamp ONLY on material diff (critique: a timer that
bumps "2026" without a content delta manufactures a fake signal — add that check to rank-12 blocklist).

### P2 — Entity channel: English Wikipedia > bare Wikidata (rank 5)
Entity-bias (2606.21595): EN Wikipedia cut brand-fabrication odds 63% (p<.001); Wikidata alone NOT
significant (p=.437). "Brand Hallucination Paradox": famous brands fabricate MORE → need dense grounding.
Split entity targets: Wikidata QID (auto, low barrier) + Wikipedia notability check → HUMAN-ops draft
(never auto-submit). Hub-and-spoke owned-net (parent intent pages + leaf fact pages, sameAs edges).

### P3 — Discovery hygiene (rank 9) — low effort, low/uncertain evidence
Static render (no JS-dependency); llms.txt + llms-full.txt from sitemap; markdown twin served to
EVERYONE (NOT user-agent-switched — that's cloaking). Treat as discovery hygiene, not a guaranteed lever.

### Cross-cutting honesty (ranks 11, 13 + contradictions)
- Schema/JSON-LD: keep for entity/indexing hygiene; Ahrefs controlled study found ~0 citation effect →
  do NOT promise schema→citation lift (§7 overclaim).
- C-SEO Bench (NeurIPS 2025): GEO edits decay once everyone adopts → report RELATIVE SoV; Princeton
  +40/+115% are SINGLE-ACTOR upper bounds, not client promises.
- Keyword stuffing is HARMFUL on answer engines (KDD ~10% worse) → optimize fluency+entity consistency,
  never brand/category keyword repetition.

## Critique: genuine gaps to add to roadmap
- YouTube/video transcripts as a §7-honest, independent-domain citation modality (channel_class can't express it today).
- Internal-linking / hub-graph as a first-class DISCOVERY lever (inbound links decide if low-authority pages are found at all).
- Deindexing/decay detection: alert when a PREVIOUSLY-cited page LOSES its citation (cheap inverse signal on existing SoV sampling).
- Embedding-space proximity instrumentation: why was a competitor passage retrieved? Makes P1/P3 falsifiable, not faith-based.
- Rank-1 at scale risks coordinated-inauthentic-behavior detection (temporal/topological clustering) — phrasing-variation gate does NOT defeat this.

## Key citations
KDD2024 GEO 2311.09735 · absorption 2604.25707 · attribution-gap 2508.00838 · entity-bias 2606.21595 ·
Dense X EMNLP24 · Anthropic Contextual Retrieval · C-SEO Bench NeurIPS25 · patents US12158907B1 /
US12346366B2 / US11481646B2 / US20240289407A1 / WO2025063948A1 · GASLITE 2412.20953 · hidden-text 2406.18382.
