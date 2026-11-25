import assert from "node:assert/strict";
import test from "node:test";

import {
  getCandidateEvidence,
  validateEvidence,
  type TranscriptSegment,
} from "../src/lib/human-interview/transcript";

test("uses finalized candidate speech and trims the segment text", () => {
  const segments: TranscriptSegment[] = [
    { id: "q", role: "interviewer", text: "你做了什么？", finalized: true },
    { id: "unknown", role: "unknown", text: "我部署了新版本。", finalized: true },
    { id: "partial", role: "candidate", text: "我还在讲", finalized: false },
    { id: "blank", role: "candidate", text: " \n\t", finalized: true },
    { id: "a", role: "candidate", text: "  我优化了数据库查询。\n", finalized: true },
  ];

  assert.deepEqual(getCandidateEvidence(segments), [
    { id: "a", text: "我优化了数据库查询。" },
  ]);
});

test("later interim updates cannot replace finals and corrections keep the segment order", () => {
  const segments: TranscriptSegment[] = [
    { id: "a", role: "candidate", text: "I changed", finalized: false },
    { id: "b", role: "candidate", text: "I checked the results.", finalized: true },
    { id: "a", role: "candidate", text: "I changed the cache settings.", finalized: true },
    { id: "a", role: "candidate", text: "I changed the connection settings.", finalized: true },
    { id: "a", role: "interviewer", text: "Late partial", finalized: false },
  ];

  assert.deepEqual(getCandidateEvidence(segments), [
    { id: "a", text: "I changed the connection settings." },
    { id: "b", text: "I checked the results." },
  ]);
});

test("newer finals can correct speaker attribution or remove the text", () => {
  const segments: TranscriptSegment[] = [
    { id: "a", role: "candidate", text: "Misattributed question", finalized: true },
    { id: "b", role: "unknown", text: "I optimized the query.", finalized: true },
    { id: "c", role: "candidate", text: "False start", finalized: true },
    { id: "a", role: "interviewer", text: "Question confirmed", finalized: true },
    { id: "b", role: "candidate", text: "I optimized the query.", finalized: true },
    { id: "c", role: "candidate", text: " ", finalized: true },
  ];

  assert.deepEqual(getCandidateEvidence(segments), [
    { id: "b", text: "I optimized the query." },
  ]);
});

test("accepts multiple exact quotes from their cited candidate segments", () => {
  const evidence = [
    { id: "a", text: "我优化了数据库查询。" },
    { id: "b", text: "I measured latency before and after." },
  ];

  assert.equal(validateEvidence(evidence, [
    { segmentId: "a", quote: "数据库查询" },
    { segmentId: "b", quote: "measured latency" },
  ]), true);
});

test("rejects empty citations, blanks, and text outside the cited segment", () => {
  const evidence = [{ id: "a", text: "I optimized the query." }];

  assert.equal(validateEvidence(evidence, []), false);
  assert.equal(validateEvidence(evidence, [{ segmentId: "a", quote: " \t" }]), false);
  assert.equal(validateEvidence(evidence, [{ segmentId: "", quote: "I" }]), false);
  assert.equal(validateEvidence(evidence, [{ segmentId: "other", quote: "the query" }]), false);
  assert.equal(validateEvidence(evidence, [{ segmentId: "a", quote: "Optimized" }]), false);
  assert.equal(validateEvidence(evidence, [
    { segmentId: "a", quote: "optimized the query" },
    { segmentId: "a", quote: "reduced latency by 40%" },
  ]), false);
});
