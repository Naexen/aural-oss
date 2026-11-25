import "server-only";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-plus";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_OUTPUT_TOKENS = 4_096;

type QwenSettings = { apiKey: string; model: string; baseUrl: string };
type QwenMessage = { role: "system" | "user"; content: string };

export type QwenRequestErrorCode =
  | "invalid_config"
  | "invalid_json"
  | "response_too_large"
  | "timeout"
  | "aborted"
  | "provider_failure";

export class QwenRequestError extends Error {
  constructor(
    readonly code: QwenRequestErrorCode,
    readonly status?: number,
  ) {
    super(`Qwen request failed (${code})`);
    this.name = "QwenRequestError";
  }
}

export function getQwenSettings(): QwenSettings | null {
  const apiKey = process.env.HUMAN_INTERVIEW_QWEN_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    apiKey,
    model: process.env.HUMAN_INTERVIEW_QWEN_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: process.env.HUMAN_INTERVIEW_QWEN_BASE_URL?.trim() || DEFAULT_BASE_URL,
  };
}

function completionEndpoint(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new QwenRequestError("invalid_config");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new QwenRequestError("invalid_config");
  }

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new QwenRequestError("invalid_json");
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new QwenRequestError("invalid_json");

  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new QwenRequestError("response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return parseJson(text + decoder.decode());
}

export async function requestQwenJson(
  messages: QwenMessage[],
  settings: QwenSettings,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  const endpoint = completionEndpoint(settings.baseUrl);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  // DashScope requires the word JSON in a system or user message for JSON mode.
  const jsonInstruction = "Return a valid JSON object.";
  const [firstMessage, ...remainingMessages] = messages;
  const requestMessages = firstMessage?.role === "system"
    ? [{ ...firstMessage, content: `${firstMessage.content}\n\n${jsonInstruction}` }, ...remainingMessages]
    : [{ role: "system", content: jsonInstruction }, ...messages];

  try {
    signal.throwIfAborted();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        messages: requestMessages,
        response_format: { type: "json_object" },
        enable_thinking: false,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      cache: "no-store",
      redirect: "error",
      signal,
    });

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new QwenRequestError("provider_failure", response.status);
    }

    const result = await readResponseJson(response) as {
      error?: unknown;
      choices?: { finish_reason?: string; message?: { content?: unknown } }[];
    } | null;
    if (result?.error) throw new QwenRequestError("provider_failure");

    const choice = result?.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new QwenRequestError("response_too_large");
    }
    const content = choice?.message?.content;
    if (typeof content !== "string") throw new QwenRequestError("invalid_json");

    return parseJson(content);
  } catch (error) {
    if (error instanceof QwenRequestError) throw error;
    if (signal.aborted) {
      // AbortSignal.any preserves the reason from the first signal to abort.
      throw new QwenRequestError(timeout.aborted && signal.reason === timeout.reason ? "timeout" : "aborted");
    }
    throw new QwenRequestError("provider_failure");
  }
}
