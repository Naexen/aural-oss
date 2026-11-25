import assert from "node:assert/strict";
import { test } from "node:test";

import type { AsrEvent, AsrProfile } from "../src/main/asr";
import { openWhisperAsr, testWhisperAsr, whisperEndpoint } from "../src/main/whisper-asr";

const profile: AsrProfile = { protocol: "whisper-http", apiKey: "", baseUrl: "http://127.0.0.1:8000/v1", model: "" };

function pcm(durationMs: number, value: number): Buffer {
  const data = Buffer.alloc(durationMs * 32);
  for (let offset = 0; offset < data.length; offset += 2) data.writeInt16LE(value, offset);
  return data;
}

async function wavPayload(body: RequestInit["body"]): Promise<Buffer> {
  assert(body instanceof FormData);
  const file = body.get("file");
  assert(file instanceof File);
  assert.equal(file.name, "clip.wav");
  assert.equal(file.type, "audio/wav");
  assert.equal(body.get("response_format"), "json");
  const wav = Buffer.from(await file.arrayBuffer());
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  return wav.subarray(44);
}

test("validates endpoint normalization, remote HTTPS and optional loopback key", async (context) => {
  assert.equal(whisperEndpoint("http://localhost:8000/").pathname, "/v1/audio/transcriptions");
  assert.equal(whisperEndpoint("http://[::1]:8000/v1/").pathname, "/v1/audio/transcriptions");
  assert.equal(whisperEndpoint("https://example.test/prefix/v1/audio/transcriptions/").pathname, "/prefix/v1/audio/transcriptions");
  for (const value of ["", "http://127.1/v1", "http://example.test", "https://user:pass@example.test/v1", "https://example.test/?key=value", "https://example.test/#fragment"]) {
    assert.throws(() => whisperEndpoint(value));
  }

  const request = context.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.pathname, "/v1/audio/transcriptions");
    assert.equal(options.redirect, "error");
    const form = options.body as FormData;
    assert.equal(form.get("model"), url.protocol === "http:" ? "whisper-1" : "Systran/faster-whisper-small");
    assert.equal(new Headers(options.headers).get("Authorization"), url.protocol === "http:" ? null : "Bearer placeholder-key");
    assert.deepEqual(await wavPayload(form), pcm(500, 0));
    return Response.json({ text: "" });
  });
  await testWhisperAsr(profile);
  await assert.rejects(testWhisperAsr({ ...profile, baseUrl: "https://example.test" }), /API Key/);
  await testWhisperAsr({ ...profile, baseUrl: "https://example.test", apiKey: "placeholder-key", model: "Systran/faster-whisper-small" });
  assert.equal(request.mock.callCount(), 2);
});

test("skips silence, starts via PCM front padding, flushes on pause and preserves a partial tail on close", async (context) => {
  const bodies: Buffer[] = [];
  const request = context.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    bodies.push(await wavPayload(options.body));
    return Response.json({ text: `  片段 ${bodies.length}  ` });
  });
  const events: AsrEvent[] = [];
  const asr = openWhisperAsr(profile, (event) => events.push(event));
  asr.write(pcm(1000, 0));
  assert.equal(request.mock.callCount(), 0);

  asr.write(pcm(93, 1000));
  asr.write(pcm(107, 1000));
  asr.write(pcm(590, 0));
  assert.equal(request.mock.callCount(), 0);
  asr.write(pcm(10, 0));
  assert.equal(request.mock.callCount(), 1);

  asr.write(pcm(83, -1200));
  asr.close();
  await asr.closed;
  assert.deepEqual(bodies[0], Buffer.concat([pcm(200, 0), pcm(200, 1000), pcm(120, 0)]));
  assert.deepEqual(bodies[1], Buffer.concat([pcm(200, 0), pcm(83, -1200)]));
  assert.deepEqual(events.map(({ type, text }) => [type, text]), [["final", "片段 1"], ["final", "片段 2"]]);
  assert.notEqual("id" in events[0] && events[0].id, "id" in events[1] && events[1].id);
  asr.write(pcm(200, 1000));
  asr.close();
  assert.equal(request.mock.callCount(), 2);
});

test("splits unbroken speech into bounded clips and never overlaps transcription requests", async (context) => {
  let active = 0;
  const bodies: Buffer[] = [];
  const request = context.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    assert.equal(++active, 1);
    bodies.push(await wavPayload(options.body));
    active--;
    return Response.json({ text: "语音" });
  });
  const asr = openWhisperAsr(profile, () => {});
  for (let i = 0; i < 32; i++) asr.write(pcm(200, 900));
  asr.close();
  await asr.closed;
  assert.equal(request.mock.callCount(), 2);
  assert.deepEqual(bodies.map(({ length }) => length), [6000 * 32, 400 * 32]);
});

test("retries a temporary HTTP failure once and emits the successful clip once", async (context) => {
  const bodies: Buffer[] = [];
  context.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    bodies.push(await wavPayload(options.body));
    return bodies.length === 1 ? new Response("provider debug data", { status: 503 }) : Response.json({ text: "已定稿" });
  });
  const events: AsrEvent[] = [];
  const asr = openWhisperAsr(profile, (event) => events.push(event));
  asr.write(pcm(125, 1000));
  asr.close();
  await asr.closed;
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(events.map(({ type, text }) => [type, text]), [["final", "已定稿"]]);
});

test("bounds a stalled request queue and aborts the active upload", async (context) => {
  let aborts = 0;
  const request = context.mock.method(globalThis, "fetch", async (_url: URL, { signal }: RequestInit) => {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => { aborts++; reject(new Error("mock abort")); }, { once: true });
    });
  });
  const events: AsrEvent[] = [];
  const asr = openWhisperAsr(profile, (event) => events.push(event));
  for (let i = 0; i < 5; i++) {
    asr.write(pcm(200, 1100));
    asr.write(pcm(600, 0));
  }
  await asr.closed;
  assert.equal(request.mock.callCount(), 1);
  assert.equal(aborts, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].text, /队列已满/);
});

test("bounds provider responses and sanitizes all provider error text", async (context) => {
  let response = new Response("provider-debug-contains-candidate-audio-and-secret", { status: 401 });
  context.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(testWhisperAsr(profile), (error: Error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /provider-debug/);
    return true;
  });
  response = Response.json({ text: "x".repeat(65 * 1024) });
  await assert.rejects(testWhisperAsr(profile), /长度限制/);
});
