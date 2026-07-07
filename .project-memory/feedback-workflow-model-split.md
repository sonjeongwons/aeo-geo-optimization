---
name: feedback-workflow-model-split
description: "Always orchestrate via cross-checking workflows; Opus for design, Sonnet for code implementation"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ff4bc712-38f1-4212-abc7-824793702d20
---

User directive (2026-06-19): keep running dynamic multi-agent workflows continuously for this project. Agents should design → implement → verify while being **skeptical of each other and cross-checking** (adversarial verification).

**Model split (efficiency requirement):** use **Opus** for design/architecture/judging tasks, **Sonnet** for code development/implementation tasks. Match model tier to task — this is a standing expectation, not one-off.

**Why:** user wants high-confidence output via independent perspectives + cost-efficient model allocation.
**How to apply:** in Workflow scripts, pass `model: 'opus'` to design/synthesis/verify agents and `model: 'sonnet'` to implementation agents. Lean on parallel finders + adversarial verify patterns. See [[project-aeo-geo-phase0]].
