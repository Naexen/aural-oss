import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { QWEN_ASR_MODEL, QWEN_ASR_URL } from "../../../server/qwen-asr";
import { QWEN_AUDIO_ASR_MODEL, QWEN_AUDIO_ASR_URL } from "../../../server/qwen-audio-asr";
import { connectStreamingAsr } from "../../../server/streaming-asr";
import { BIGMODEL_ASYNC_ASR_URL, SEED_ASR_RESOURCE, seedResponseError, type AsrResponse } from "../../../server/volcengine-asr";
import { openWhisperAsr, testWhisperAsr } from "./whisper-asr";

export type AsrProfile = {
  protocol: "qwen" | "qwen-audio" | "seed" | "whisper-http";
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type AsrEvent =
  | { type: "partial" | "final"; id: string; text: string }
  | { type: "error"; text: string };

export type AsrConnection = { write(pcm: Uint8Array): void; close(): void; readonly closed: Promise<void> };
type SocketFactory = NonNullable<Parameters<typeof connectStreamingAsr>[1]>;

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;
const MAX_PROVIDER_MESSAGE_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_SEGMENT_ID_CHARS = 256;
const MAX_SEGMENTS = 10_000;
const MAX_PENDING_SEGMENTS = 32;
const FINISH_TIMEOUT_MS = 5_000;

async function connectProfile(profile: AsrProfile, socketFactory?: SocketFactory) {
  if (profile.protocol !== "qwen" && profile.protocol !== "qwen-audio" && profile.protocol !== "seed") {
    throw new Error("请选择有效的 WebSocket 转写协议。");
  }
  const apiKey = profile.apiKey.trim();
  if (!apiKey || apiKey.length > 1024 || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error("请输入有效的 ASR API Key。");
  }

  const realtime = profile.protocol === "qwen";
  const seed = profile.protocol === "seed";
  const defaultUrl = seed ? BIGMODEL_ASYNC_ASR_URL : realtime ? QWEN_ASR_URL : QWEN_AUDIO_ASR_URL;
  const defaultModel = seed ? SEED_ASR_RESOURCE : realtime ? QWEN_ASR_MODEL : QWEN_AUDIO_ASR_MODEL;
  let url: URL;
  try {
    url = new URL(profile.baseUrl.trim() || defaultUrl);
  } catch {
    throw new Error("请输入有效的 ASR WebSocket 地址。");
  }
  if (url.protocol !== "wss:" || url.username || url.password || url.hash) {
    throw new Error("ASR WebSocket 地址必须使用 wss://，且不能包含凭据或片段。");
  }
  const model = profile.model.trim() || (realtime ? url.searchParams.get("model") : null) || defaultModel;
  if (!/^[\w.:-]{1,160}$/.test(model)) throw new Error("请输入有效的 ASR 模型名。");
  if (realtime) url.searchParams.set("model", model);

  try {
    return await connectStreamingAsr({
      provider: profile.protocol,
      apiKey,
      url: url.toString(),
      ...(seed ? { resourceId: model, seedAsync: true } : { model }),
      requestId: randomUUID(),
      config: seed ? { enableNonstream: true, showUtterance: true, endWindowSize: 800 } : {},
      maxPayload: MAX_PROVIDER_MESSAGE_BYTES,
    }, socketFactory);
  } catch {
    throw new Error("无法连接或配置 ASR，请检查地址、模型与 API Key。");
  }
}

export async function testAsr(profile: AsrProfile, socketFactory?: SocketFactory): Promise<void> {
  if (profile.protocol === "whisper-http") return testWhisperAsr(profile);
  const connection = await connectProfile(profile, socketFactory);
  // The provider has acknowledged the configuration. No microphone audio is sent by this check.
  connection.close();
}

export async function openAsr(
  profile: AsrProfile,
  emit: (event: AsrEvent) => void,
  socketFactory?: SocketFactory,
): Promise<AsrConnection> {
  if (profile.protocol === "whisper-http") return openWhisperAsr(profile, emit);
  const seed = profile.protocol === "seed";
  const connection = await connectProfile(profile, socketFactory);
  const { socket } = connection;
  const partials = new Map<string, string>();
  const finalized = new Set<string>();
  const seedFinalIds = new Set<string>();
  let seedDraft: { id: string; start?: number; end?: number } | undefined;
  let seedDraftCount = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let state: "active" | "finishing" | "closed" = "active";
  let finishTimer: ReturnType<typeof setTimeout> | undefined;

  function dispose() {
    state = "closed";
    clearTimeout(finishTimer);
    partials.clear();
    finalized.clear();
    seedFinalIds.clear();
    socket.off("message", onMessage).off("error", onError).off("close", onClose);
    connection.close();
    resolveClosed();
  }

  function fail(text: string) {
    if (state === "closed") return;
    dispose();
    socket.terminate();
    emit({ type: "error", text });
  }

  function onError() {
    fail("语音转写连接出错，请重新启动转写。");
  }

  function onClose() {
    fail("语音转写连接在完成前关闭，请重新启动转写。");
  }

  function finishFromProvider() {
    if (state === "finishing") dispose();
    else fail("ASR 服务结束了转写，请重新启动转写。");
  }

  function publishSegment(id: string, text: string, definite: boolean) {
    if (state === "closed" || finalized.has(id)) return;
    if (typeof id !== "string" || !id || id.length > MAX_SEGMENT_ID_CHARS || text.length > MAX_TRANSCRIPT_CHARS) {
      fail("语音转写达到处理上限，请重新启动转写。");
      return;
    }
    if (definite) {
      if (finalized.size >= MAX_SEGMENTS) {
        fail("语音转写达到处理上限，请重新启动转写。");
        return;
      }
      const hadPartial = partials.delete(id);
      finalized.add(id);
      if (text || hadPartial) emit({ type: "final", id, text });
    } else if (text !== (partials.get(id) ?? "")) {
      if (!partials.has(id) && partials.size >= MAX_PENDING_SEGMENTS) {
        fail("语音转写收到过多未完成片段，请重新启动转写。");
        return;
      }
      partials.set(id, text);
      emit({ type: "partial", id, text });
    }
  }

  function processSeedResponse(response: AsrResponse | null) {
    if (!response || response.messageType === 0 || seedResponseError(response)) {
      fail("豆包语音服务未能完成转写，请检查服务状态或重新连接。");
      return;
    }
    const utterances = response.utterances ?? [];
    if (!Array.isArray(utterances)) throw new Error("Invalid Seed utterance list");
    for (const item of utterances) {
      if (state === "closed") return;
      if (typeof item?.text !== "string" || typeof item.definite !== "boolean") throw new Error("Invalid Seed utterance");
      const start = typeof item.start_time === "number" && item.start_time >= 0 && Number.isSafeInteger(item.start_time) ? item.start_time : undefined;
      const end = typeof item.end_time === "number" && item.end_time >= 0 && Number.isSafeInteger(item.end_time) ? item.end_time : undefined;
      // Seed may replay older definite utterances. A timestamp identifies the utterance
      // even when two different utterances have exactly the same words.
      const timedId = start !== undefined ? `seed-${start}` : end !== undefined ? `seed-end-${end}` : undefined;
      if (timedId && seedFinalIds.has(timedId)) continue;

      // A first hypothesis sometimes has no start time. Match it to the timed
      // result when it arrives, or keep a stable ID through small timestamp revisions.
      const draft = seedDraft;
      const matchesDraft = draft && (
        draft.start === undefined || start === undefined || draft.start === start ||
        (draft.end !== undefined && end !== undefined && start < draft.end && draft.start < end)
      );
      if (item.definite) {
        // Aggregate or untimed results cannot be deduplicated safely.
        if (!timedId) continue;
        seedFinalIds.add(timedId);
        if (matchesDraft) seedDraft = undefined;
        publishSegment(matchesDraft ? draft.id : timedId, item.text, true);
      } else {
        const id = matchesDraft ? draft.id : timedId ?? `seed-draft-${++seedDraftCount}`;
        seedDraft = { id, start, end };
        publishSegment(id, item.text, false);
      }
    }
    if (state === "closed") return;
    if (!utterances.length && !response.isLastPackage && typeof response.text === "string" && response.text) {
      seedDraft ??= { id: `seed-draft-${++seedDraftCount}` };
      publishSegment(seedDraft.id, response.text, false);
    }
    if (response.isLastPackage) {
      // Clear an unfinished hypothesis without treating it as candidate evidence.
      for (const id of partials.keys()) publishSegment(id, "", true);
      finishFromProvider();
    }
  }

  function onMessage(data: WebSocket.RawData, binary: boolean) {
    if (state === "closed") return;
    try {
      if (binary !== seed || !Buffer.isBuffer(data)) throw new Error("Invalid ASR event format");
      if (seed) {
        processSeedResponse(connection.parseMessage(data));
        return;
      }
      const event = connection.parseTranscriptEvent(data);
      if (!event || event.kind === "started") return;
      if (event.kind === "error") {
        fail("ASR 服务未能完成转写，请检查服务状态或重新连接。");
        return;
      }
      if (event.kind === "finished") {
        finishFromProvider();
        return;
      }

      publishSegment(event.id, event.text, event.finalized);
    } catch {
      fail("ASR 服务返回了无法读取的转写结果。");
    }
  }

  socket.on("message", onMessage).on("error", onError).on("close", onClose);
  if (socket.readyState !== WebSocket.OPEN) onClose();

  return {
    closed,
    write(pcm) {
      if (state !== "active" || !pcm.byteLength) return;
      if (pcm.byteLength > MAX_FRAME_BYTES || pcm.byteLength % 2 !== 0) {
        fail("收到无效的 16 位 PCM 音频数据。");
        return;
      }
      if (socket.bufferedAmount + pcm.byteLength > MAX_QUEUED_BYTES) {
        fail("语音转写发送队列已满，请检查网络后重试。");
        return;
      }
      try {
        connection.sendAudio(Buffer.from(pcm));
      } catch {
        onError();
      }
    },
    close() {
      if (state !== "active") return;
      state = "finishing";
      try {
        connection.finish();
        finishTimer = setTimeout(() => fail("等待语音转写定稿超时。"), FINISH_TIMEOUT_MS);
        finishTimer.unref();
      } catch {
        onError();
      }
    },
  };
}
