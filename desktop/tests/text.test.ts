import assert from "node:assert/strict";
import { test } from "node:test";

import { QWEN_COMPATIBLE_PRESET, runText, testText, TextModelError, type TextProfile } from "../src/main/text";

const qwen = { ...QWEN_COMPATIBLE_PRESET, apiKey: "mock-key" };
const local: TextProfile = { protocol: "compatible", baseUrl: "http://127.0.0.1:7258/v1/chat/completions", model: "local", apiKey: "" };
const question = { id: "q1", prompt: "怎样排查接口延迟？", criterion: "故障定位", strongAnswer: "描述操作和数据", minutes: 5 };
const nextQuestion = { ...question, id: "q2", prompt: "怎样回滚这项改动？" };
const evaluationInput = {
  question,
  remainingQuestions: [nextQuestion],
  segments: [
    { id: "interviewer", text: "模拟面试官独有内容", finalized: true, role: "interviewer" },
    { id: "draft", text: "模拟未确认内容", finalized: false, role: "candidate" },
    { id: "answer", text: "我先用链路监控定位瓶颈。", finalized: true, role: "candidate" },
  ],
};

function completion(output: unknown): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
}

test("uses DashScope JSON mode and tests a native Gemini profile without exposing keys in URLs", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    assert.equal(init.redirect, "error");
    if (input.hostname === "dashscope.aliyuncs.com") {
      assert.equal(input.pathname, "/compatible-mode/v1/chat/completions");
      assert.equal(headers.get("authorization"), "Bearer mock-key");
      assert.deepEqual(request.response_format, { type: "json_object" });
      assert.equal(request.enable_thinking, false);
      return completion({ ok: true });
    }

    assert.equal(input.href, "https://generativelanguage.googleapis.com/v1beta/models/mock-model:generateContent");
    assert.equal(headers.get("x-goog-api-key"), "second-mock-key");
    assert.equal(request.generationConfig.responseMimeType, "application/json");
    assert.equal(request.contents[0].role, "user");
    return Response.json({ candidates: [{ content: { parts: [{ thought: true, text: "ignore" }, { text: '{"ok":true}' }] } }] });
  });

  assert.deepEqual(await testText(qwen), { ok: true });
  assert.deepEqual(await testText({ protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "models/mock-model", apiKey: "second-mock-key" }), { ok: true });
  assert.equal(fetch.mock.callCount(), 2);
});

test("prepares a generic plan without candidate documents, and keeps local compatible profiles independent", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    assert.equal(input.href, local.baseUrl);
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.equal(request.model, local.model);
    assert.equal(request.enable_thinking, undefined);
    assert.match(request.messages[0].content, /没有 JD，生成通用能力题/);
    assert.deepEqual(JSON.parse(request.messages[1].content), { action: "prepare", jobDescription: "", resume: "", durationMinutes: 20 });
    return completion({ summary: "通用面试", verify: ["核对项目交付职责"], agenda: [question, nextQuestion] });
  });
  const result = await runText(local, "prepare", { durationMinutes: 20 });
  assert.deepEqual(result, { summary: "通用面试", verify: ["核对项目交付职责"], agenda: [question, nextQuestion] });
});

test("sends only finalized candidate evidence to score and rejects model-invented quotes", async (context) => {
  let quote = "我先用链路监控定位瓶颈。";
  const fetch = context.mock.method(globalThis, "fetch", async (_input: URL, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    const input = JSON.parse(payload.messages[1].content);
    assert.deepEqual(input.candidateSegments, [{ id: "answer", text: evaluationInput.segments[2].text }]);
    return completion({ score: 3, feedback: "回答有定位步骤。", evidence: [{ segmentId: "answer", quote }], followUp: null, nextQuestionId: "q2" });
  });

  const result = await runText(qwen, "score", evaluationInput);
  assert.equal(result && "score" in result && result.score, 3);
  quote = "这是没有说过的话。";
  await assert.rejects(runText(qwen, "score", evaluationInput), { code: "invalid_output" });
  await assert.rejects(runText(qwen, "score", { ...evaluationInput, segments: evaluationInput.segments.slice(0, 2) }), { code: "missing_evidence" });
  assert.equal(fetch.mock.callCount(), 2);
});

test("allows pre-answer suggestions and rejects an unknown next question", async (context) => {
  let nextQuestionId = "q2";
  context.mock.method(globalThis, "fetch", async (_input: URL, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    assert.deepEqual(JSON.parse(payload.messages[1].content).candidateSegments, []);
    return completion({ followUp: "可以讲一次具体排查吗？", nextQuestionId });
  });
  const input = { ...evaluationInput, segments: [] };
  assert.deepEqual(await runText(local, "suggest", input), { followUp: "可以讲一次具体排查吗？", nextQuestionId: "q2" });
  nextQuestionId = "missing";
  await assert.rejects(runText(local, "suggest", input), { code: "invalid_output" });
});

test("polish only submits the selected draft and requires structured text", async (context) => {
  const draft = "故障定位暂评 3/5，待核实索引写入开销。";
  let output: unknown = { text: "暂评 3/5。待核实索引的写入开销。" };
  context.mock.method(globalThis, "fetch", async (_input: URL, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.messages[1].content, draft);
    return completion(output);
  });
  assert.deepEqual(await runText(local, "polish", { draft }), output);
  output = { unstructured: "未通过校验" };
  await assert.rejects(runText(local, "polish", { draft }), { code: "invalid_output" });
});

test("caps provider bodies and keeps provider error details out of the UI", async (context) => {
  let response = new Response("mock-key and a copy of private input", { status: 429 });
  context.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(testText(qwen), (error) => {
    assert(error instanceof TextModelError);
    assert.equal(error.code, "provider_failure");
    assert.equal(error.status, 429);
    assert.doesNotMatch(error.message, /mock-key|private input/);
    return true;
  });
  response = new Response("x".repeat(129 * 1024));
  await assert.rejects(testText(qwen), { code: "response_too_large" });
});
