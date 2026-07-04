"use client";

/**
 * GapListWithEvidence — client wrapper that wires GapList's 증거(evidence)
 * button to the EvidenceDrawer.
 *
 * W7.1 — The gaps page is a Server Component, so it cannot pass an
 * onEvidenceClick handler to GapList (the button was dead). This thin client
 * boundary owns the selected-evidence state and renders the drawer, letting
 * the server page stay a Server Component while the interaction works.
 */

import { useState } from "react";
import { GapList } from "./GapList";
import { EvidenceDrawer } from "./EvidenceDrawer";
import type { PriorityGapQuestion } from "../lib/wire";

interface GapListWithEvidenceProps {
  questions: PriorityGapQuestion[];
  limit?: number;
}

export function GapListWithEvidence({
  questions,
  limit,
}: GapListWithEvidenceProps) {
  const [evidenceId, setEvidenceId] = useState<string | null>(null);

  return (
    <>
      <GapList
        questions={questions}
        {...(limit !== undefined ? { limit } : {})}
        showEvidence
        onEvidenceClick={setEvidenceId}
      />
      <EvidenceDrawer
        evidenceId={evidenceId}
        onClose={() => setEvidenceId(null)}
      />
    </>
  );
}
