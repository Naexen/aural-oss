import assert from "node:assert/strict";
import test from "node:test";

import { evaluateInterviewAnswer, prepareInterviewAnalysis } from "../src/lib/human-interview/analysis";

const question = { id: "first", prompt: "如何处理缓存过期？", criterion: "系统可靠性", strongAnswer: "说明取舍和验证方法", minutes: 8 };
const nextQuestion = { ...question, id: "second", prompt: "如何验证峰值负载？" };

test("preparation bounds the agenda to the interview duration and assigns stable question IDs", () => {
  const prepare = prepareInterviewAnalysis({ action: "prepare", jobDescription: "后端工程师", resume: "候选人自述有缓存经验", durationMinutes: 15 });
  const brief = { summary: "候选人自述有缓存经验。", verify: ["具体负责的模块"], agenda: [question, nextQuestion] };
  assert.equal(prepare.parse(brief), null);
  assert.deepEqual(prepare.parse({ ...brief, agenda: [question, { ...nextQuestion, minutes: 7 }] })?.agenda.map((item) => item.id), ["q1", "q2"]);
});

test("evaluation can cite only the candidate and choose only a remaining question", () => {
  const evaluate = evaluateInterviewAnswer({
    action: "evaluate",
    question,
    remainingQuestions: [nextQuestion],
    segments: [
      { id: "i", role: "interviewer", text: "你可以用队列限流。", finalized: true },
      { id: "c", role: "candidate", text: "我先让同一个键只回源一次。", finalized: true },
    ],
  });
  assert.ok(evaluate);
  assert.doesNotMatch(evaluate.messages[1].content, /队列限流/);
  const output = { score: 3, feedback: "说明了并发回源的做法。", evidence: [{ segmentId: "c", quote: "只回源一次" }], followUp: "失败时如何降级？", nextQuestionId: "second" };
  assert.deepEqual(evaluate.parse(output), output);
  assert.equal(evaluate.parse({ ...output, evidence: [{ segmentId: "i", quote: "队列限流" }] }), null);
  assert.equal(evaluate.parse({ ...output, nextQuestionId: "first" }), null);
  assert.equal(evaluate.parse({ ...output, evidence: [] }), null);
  assert.equal(evaluate.parse({ ...output, score: null, evidence: [] })?.score, null);
});

test("a question without finalized candidate speech cannot start evaluation", () => {
  assert.equal(evaluateInterviewAnswer({
    action: "evaluate", question, remainingQuestions: [],
    segments: [{ id: "draft", role: "candidate", text: "我会先看一下", finalized: false }],
  }), null);
});
