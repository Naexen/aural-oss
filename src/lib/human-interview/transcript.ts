export type SpeakerRole = "interviewer" | "candidate" | "unknown";

export type TranscriptSegment = {
  id: string;
  role: SpeakerRole;
  text: string;
  finalized: boolean;
};

type CandidateEvidence = { id: string; text: string };

export function getCandidateEvidence(
  segments: readonly TranscriptSegment[],
): CandidateEvidence[] {
  const segmentsById = new Map<string, TranscriptSegment>();
  for (const segment of segments) {
    const previous = segmentsById.get(segment.id);
    if (segment.finalized || !previous?.finalized) {
      segmentsById.set(segment.id, segment);
    }
  }

  // Updating a segment leaves it at its first position in the turn.
  const evidence: CandidateEvidence[] = [];
  for (const segment of segmentsById.values()) {
    if (!segment.finalized || segment.role !== "candidate") continue;
    const text = segment.text.trim();
    if (text) evidence.push({ id: segment.id, text });
  }
  return evidence;
}

export function validateEvidence(
  candidateEvidence: readonly CandidateEvidence[],
  citations: readonly { segmentId: string; quote: string }[],
): boolean {
  if (citations.length === 0) return false;

  const textById = new Map(candidateEvidence.map(({ id, text }) => [id, text]));
  return citations.every(({ segmentId, quote }) =>
    segmentId.trim().length > 0 &&
    quote.trim().length > 0 &&
    textById.get(segmentId)?.includes(quote) === true
  );
}
