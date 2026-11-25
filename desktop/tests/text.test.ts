import assert from "node:assert/strict";
import { test } from "node:test";

import { listTextModels, runText, testText, TextModelError, type TextProfile } from "../src/main/text";

const qwen: TextProfile = { protocol: "compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", apiKey: "mock-key" };
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

test("uses documented reasoning controls only for named compatible vendors and models", async (context) => {
  const profiles = [
    { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", path: "/chat/completions", options: { thinking: { type: "disabled" }, max_tokens: 1024, response_format: { type: "json_object" } } },
    { baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6", path: "/v1/chat/completions", options: { thinking: { type: "disabled" }, max_tokens: 1024, response_format: { type: "json_object" } } },
    { baseUrl: "https://api.moonshot.ai/v1", model: "kimi-k3.1-pro", path: "/v1/chat/completions", options: { reasoning_effort: "low", max_completion_tokens: 1024, response_format: { type: "json_object" } } },
    { baseUrl: "https://api.minimax.cn/v1", model: "MiniMax-M3.1-Flash", path: "/v1/chat/completions", options: { reasoning_split: true, reasoning_effort: "low", max_completion_tokens: 1024 } },
    { baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M3", path: "/v1/chat/completions", options: { reasoning_split: true, thinking: { type: "disabled" }, max_completion_tokens: 1024 } },
    { baseUrl: "https://compatible.example.test/v1", model: "kimi-k2.6", path: "/v1/chat/completions", options: { max_tokens: 1024, response_format: { type: "json_object" } } },
  ];
  let index = 0;
  context.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    const profile = profiles[index++];
    const { model, messages, ...options } = JSON.parse(String(init.body));
    assert.equal(input.origin, new URL(profile.baseUrl).origin);
    assert.equal(input.pathname, profile.path);
    assert.equal(model, profile.model);
    assert.match(messages[0].content, /JSON/);
    assert.deepEqual(options, profile.options);
    if (input.hostname.startsWith("api.minimax.")) {
      return Response.json({ choices: [{ message: { reasoning_content: "separate reasoning", content: '```json\n{"ok":true}\n```' } }] });
    }
    return completion({ ok: true });
  });
  for (const { baseUrl, model } of profiles) {
    assert.deepEqual(await testText({ protocol: "compatible", apiKey: "mock-key", baseUrl, model }), { ok: true });
  }
  assert.equal(index, profiles.length);
});

test("Anthropic-compatible Messages sends top-level system instructions and reads only final text blocks", async (context) => {
  let response = Response.json({ stop_reason: "end_turn", content: [{ type: "thinking", text: "ignore this" }, { type: "text", text: '```json\n{"ok":' }, { type: "text", text: "true}\n```" }] });
  const fetch = context.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    assert.equal(init.method, "POST");
    assert.equal(url.pathname, "/v1/messages");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.has("Authorization"), false);
    if (url.protocol === "https:") assert.equal(headers.get("x-api-key"), "mock-key");
    else assert.equal(headers.has("x-api-key"), false);
    assert.equal(body.model, "mock-model");
    assert.equal(body.max_tokens, 1024);
    assert.match(body.system, /JSON/);
    assert.deepEqual(body.messages, [{ role: "user", content: 'Return this JSON: {"ok":true}' }]);
    assert.equal(body.response_format, undefined);
    return response;
  });
  const profile: TextProfile = { protocol: "anthropic", baseUrl: "https://anthropic.example.test/v1/messages", model: "mock-model", apiKey: "mock-key" };
  assert.deepEqual(await testText(profile), { ok: true });
  response = Response.json({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"ok":true}' }] });
  await assert.rejects(testText({ ...profile, baseUrl: "http://localhost:8000", apiKey: "" }), { code: "response_too_large" });
  await assert.rejects(testText({ ...profile, apiKey: "" }), { code: "invalid_config" });
  assert.equal(fetch.mock.callCount(), 2);
});

test("model discovery and generation normalize the same compatible base and full endpoint paths", async (context) => {
  const paths = [
    { base: "", prefix: "/v1" },
    { base: "/v1/", prefix: "/v1" },
    { base: "/v1/chat/completions", prefix: "/v1" },
    { base: "/gateway/v1/chat/completions/", prefix: "/gateway/v1" },
    { base: "/chat/completions", prefix: "" },
    { base: "/v1/models", prefix: "/v1" },
  ];
  let index = 0;
  context.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const isList = index % 2 === 0;
    const { prefix } = paths[Math.floor(index++ / 2)];
    assert.equal(url.pathname, `${prefix}${isList ? "/models" : "/chat/completions"}`);
    assert.equal(url.search, "");
    assert.equal(init.method, isList ? "GET" : "POST");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    return isList ? Response.json({ data: [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "\u0001invalid" }] }) : completion({ ok: true });
  });
  for (const { base } of paths) {
    const profile = { protocol: "compatible", baseUrl: `http://127.0.0.1:8000${base}`, apiKey: "" } as const;
    assert.deepEqual(await listTextModels(profile), ["a", "b"]);
    assert.deepEqual(await testText({ ...profile, model: "a" }), { ok: true });
  }
  assert.equal(index, paths.length * 2);
});

test("model discovery distinguishes disabled listing from generation errors", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  await assert.rejects(listTextModels(local), {
    code: "model_list_unavailable",
    status: 404,
    message: /未提供模型列表，请检查 API 地址或网关设置/,
  });
  await assert.rejects(testText(local), { code: "provider_failure", status: 404 });
});

test("Anthropic discovery follows official cursors within size and page bounds", async (context) => {
  let page = 0;
  let mode: "paginate" | "repeat" | "http-error" = "paginate";
  context.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    const current = ++page;
    assert.equal(url.pathname, "/proxy/v1/models");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("after_id"), current === 1 ? null : `cursor ${current - 1}`);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-api-key"), "mock-key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    if (mode === "http-error") return new Response("mock-key leaked by vendor", { status: 429 });
    return Response.json({ data: [{ id: `model-${current}` }], has_more: true, last_id: mode === "repeat" ? "cursor 1" : `cursor ${current}` });
  });
  const profile = { protocol: "anthropic", baseUrl: "https://anthropic.example.test/proxy/v1/messages/", apiKey: "mock-key" } as const;
  assert.deepEqual(await listTextModels(profile), Array.from({ length: 8 }, (_, index) => `model-${index + 1}`));
  assert.equal(page, 8);
  page = 0;
  mode = "repeat";
  await assert.rejects(listTextModels(profile), { code: "invalid_output" });
  assert.equal(page, 2);
  page = 0;
  mode = "http-error";
  await assert.rejects(listTextModels(profile), (error) => {
    assert(error instanceof TextModelError);
    assert.equal(error.status, 429);
    assert.doesNotMatch(error.message, /mock-key/);
    return true;
  });
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
