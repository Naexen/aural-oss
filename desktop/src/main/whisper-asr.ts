import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { MIC_AUDIO_SAMPLE_RATE } from "../../../src/lib/voice/mic-audio";
import type { AsrConnection, AsrEvent, AsrProfile } from "./asr";

export const WHISPER_ASR_MODEL = "whisper-1";

const FRAME_MS = 20;
const FRAME_BYTES = (MIC_AUDIO_SAMPLE_RATE * FRAME_MS / 1_000) * 2;
const MAX_WRITE_BYTES = 128 * 1024;
const VOICE_RMS = 300;
const PAUSE_FRAMES = 600 / FRAME_MS;
const PREROLL_FRAMES = 200 / FRAME_MS;
const TRAILING_FRAMES = 120 / FRAME_MS;
const MAX_CLIP_FRAMES = 6_000 / FRAME_MS;
const MAX_WAITING_CLIPS = 3;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_CHARS = 1_800;
const REQUEST_TIMEOUT_MS = 12_000;
const FINISH_TIMEOUT_MS = 18_000;

class WhisperError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "WhisperError";
  }
}

const loopbacks = ["localhost", "127.0.0.1", "[::1]"];

export function whisperEndpoint(baseUrl: string): URL {
  const address = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new WhisperError("请输入 Whisper 转写服务地址。");
  }

  const localHttp = url.protocol === "http:"
    && loopbacks.includes(url.hostname)
    && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(address);
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new WhisperError("Whisper 地址须使用 HTTPS 或本机 HTTP，且不能包含账号、查询参数或片段。");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/audio/transcriptions")) url.pathname = `${path || "/v1"}/audio/transcriptions`;
  else url.pathname = path;
  return url;
}

function whisperSettings(profile: AsrProfile) {
  const endpoint = whisperEndpoint(profile.baseUrl);
  const apiKey = profile.apiKey.trim();
  if ((!apiKey && !loopbacks.includes(endpoint.hostname)) || apiKey.length > 1024 || !/^[\x21-\x7e]*$/.test(apiKey)) {
    throw new WhisperError("请输入有效的 Whisper API Key。远程服务需要密钥。");
  }
  const model = profile.model.trim() || WHISPER_ASR_MODEL;
  if (!/^[\x21-\x7e]{1,160}$/.test(model)) throw new WhisperError("请输入有效的 Whisper 模型名称。");
  return { endpoint, apiKey, model };
}

function wavBytes(pcm: Buffer): Uint8Array<ArrayBuffer> {
  const file = Buffer.alloc(44 + pcm.length);
  file.write("RIFF", 0);
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WAVEfmt ", 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(MIC_AUDIO_SAMPLE_RATE, 24);
  file.writeUInt32LE(MIC_AUDIO_SAMPLE_RATE * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write("data", 36);
  file.writeUInt32LE(pcm.length, 40);
  pcm.copy(file, 44);
  return new Uint8Array(file);
}

async function readTranscript(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new WhisperError("Whisper 没有返回转写结果。");
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new WhisperError("Whisper 返回的转写超出长度限制。");
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  let output: { text?: unknown } | null;
  try {
    output = JSON.parse(body + decoder.decode());
  } catch {
    throw new WhisperError("Whisper 没有返回有效的转写 JSON。");
  }
  if (typeof output?.text !== "string" || output.text.length > MAX_TRANSCRIPT_CHARS) {
    throw new WhisperError("Whisper 返回的转写格式或长度超出支持范围。");
  }
  return output.text.trim();
}

async function requestTranscript(settings: ReturnType<typeof whisperSettings>, pcm: Buffer, connectionSignal?: AbortSignal) {
  const form = new FormData();
  form.set("file", new Blob([wavBytes(pcm)], { type: "audio/wav" }), "clip.wav");
  form.set("model", settings.model);
  form.set("response_format", "json");
  const headers = new Headers({ Accept: "application/json" });
  if (settings.apiKey) headers.set("Authorization", `Bearer ${settings.apiKey}`);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = connectionSignal ? AbortSignal.any([connectionSignal, timeout]) : timeout;

  try {
    const response = await fetch(settings.endpoint, { method: "POST", headers, body: form, redirect: "error", cache: "no-store", signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new WhisperError(`Whisper 转写请求失败（HTTP ${response.status}）。`, [429, 502, 503, 504].includes(response.status));
    }
    return await readTranscript(response);
  } catch (error) {
    if (error instanceof WhisperError) throw error;
    throw new WhisperError(timeout.aborted ? "Whisper 转写请求超时。" : "无法连接 Whisper 转写服务。");
  }
}

export async function testWhisperAsr(profile: AsrProfile): Promise<void> {
  // A half-second WAV generated in memory probes compatibility without capturing audio.
  await requestTranscript(whisperSettings(profile), Buffer.alloc(MIC_AUDIO_SAMPLE_RATE));
}

function isVoiced(frame: Buffer): boolean {
  let energy = 0;
  for (let offset = 0; offset < frame.length; offset += 2) {
    const sample = frame.readInt16LE(offset);
    energy += sample * sample;
  }
  return energy >= VOICE_RMS * VOICE_RMS * frame.length / 2;
}

export function openWhisperAsr(profile: AsrProfile, emit: (event: AsrEvent) => void): AsrConnection {
  const settings = whisperSettings(profile);
  const abort = new AbortController();
  const queue: Buffer[] = [];
  let state: "active" | "finishing" | "closed" = "active";
  let processing = false;
  let preroll: Buffer[] = [];
  let clip: Buffer[] = [];
  let quietFrames = 0;
  let frame = Buffer.alloc(FRAME_BYTES);
  let buffered = 0;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  function finish() {
    state = "closed";
    clearTimeout(finishTimer);
    queue.length = 0;
    preroll = [];
    clip = [];
    frame = Buffer.alloc(0);
    abort.abort();
    resolveClosed();
  }

  function fail(text: string) {
    if (state === "closed") return;
    finish();
    emit({ type: "error", text });
  }

  async function transcribe(pcm: Buffer) {
    try {
      return await requestTranscript(settings, pcm, abort.signal);
    } catch (error) {
      if (!(error instanceof WhisperError) || !error.retryable || abort.signal.aborted) throw error;
      await delay(400, undefined, { signal: abort.signal });
      return requestTranscript(settings, pcm, abort.signal);
    }
  }

  async function drain() {
    if (processing || state === "closed") return;
    processing = true;
    try {
      while (queue.length && !abort.signal.aborted) {
        const text = await transcribe(queue.shift()!);
        if (text && !abort.signal.aborted) emit({ type: "final", id: randomUUID(), text });
      }
    } catch (error) {
      fail(error instanceof WhisperError ? error.message : "Whisper 无法完成语音转写。");
    } finally {
      processing = false;
      if (state === "finishing") finish();
    }
  }

  function flushClip() {
    if (!clip.length) return;
    if (queue.length >= MAX_WAITING_CLIPS) {
      fail("Whisper 转写队列已满，请检查服务速度后重新开始转写。");
      return;
    }
    preroll = quietFrames ? clip.slice(-Math.min(quietFrames, PREROLL_FRAMES)) : [];
    const trailingSilence = Math.max(0, quietFrames - TRAILING_FRAMES);
    queue.push(Buffer.concat(clip.slice(0, clip.length - trailingSilence)));
    clip = [];
    quietFrames = 0;
    void drain();
  }

  function consume(pcm: Buffer) {
    const voice = isVoiced(pcm);
    if (clip.length === 0) {
      if (!voice) {
        preroll.push(pcm);
        if (preroll.length > PREROLL_FRAMES) preroll.shift();
        return;
      }
      clip = preroll;
      preroll = [];
    }
    clip.push(pcm);
    quietFrames = voice ? 0 : quietFrames + 1;
    if (quietFrames >= PAUSE_FRAMES || clip.length >= MAX_CLIP_FRAMES) flushClip();
  }

  return {
    closed,
    write(pcm) {
      if (state !== "active" || pcm.byteLength === 0) return;
      if (pcm.byteLength > MAX_WRITE_BYTES || pcm.byteLength % 2) {
        fail("收到无效的 16 位 PCM 音频数据。");
        return;
      }
      for (let offset = 0; offset < pcm.length && !abort.signal.aborted;) {
        const length = Math.min(frame.length - buffered, pcm.length - offset);
        frame.set(pcm.subarray(offset, offset + length), buffered);
        offset += length;
        buffered += length;
        if (buffered === frame.length) {
          const full = frame;
          frame = Buffer.alloc(FRAME_BYTES);
          buffered = 0;
          consume(full);
        }
      }
    },
    close() {
      if (state !== "active") return;
      state = "finishing";
      finishTimer = setTimeout(() => fail("等待 Whisper 尾段转写超时，可能有内容未保存。"), FINISH_TIMEOUT_MS);
      finishTimer.unref();
      if (buffered) consume(frame.subarray(0, buffered));
      flushClip();
      void drain();
    },
  };
}
