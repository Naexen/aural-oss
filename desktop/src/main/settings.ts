import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
import { speechProviders, type PublicSettings, type SpeechProvider, type TextTask } from "./bridge-types";
import type { TextProfile } from "./text";

const address = z.string().trim().max(2048);
const model = z.string().trim().max(256);
const textFields = { protocol: z.enum(["compatible", "anthropic", "gemini"]), baseUrl: address, model };
const speechFields = { provider: z.enum(speechProviders), baseUrl: address, model };
const secretUpdate = {
  apiKey: z.string().trim().max(4096).regex(/^[!-~]*$/).optional(),
  clearKey: z.boolean().optional(),
};
const encryptedKey = z.string().max(16_384).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional();
const textUpdate = z.strictObject({ ...textFields, ...secretUpdate });
const textConnection = z.strictObject({
  protocol: z.enum(["compatible", "anthropic"]),
  baseUrl: address.min(1),
  ...secretUpdate,
});
const storedText = z.strictObject({ ...textFields, encryptedKey });
const storedSpeech = z.strictObject({ ...speechFields, enabled: z.boolean(), encryptedKey });
export const textTask = z.enum(["prepare", "suggest", "score", "polish"]);
const updateSchema = z.strictObject({
  text: textUpdate.optional(),
  tasks: z.partialRecord(textTask, textUpdate.nullable()).optional(),
  speech: z.strictObject({ ...speechFields, enabled: z.boolean().optional(), ...secretUpdate }).optional(),
});
const storedSchema = z.strictObject({
  version: z.literal(1),
  text: storedText,
  tasks: z.partialRecord(textTask, storedText),
  speech: storedSpeech,
});
type StoredSettings = z.infer<typeof storedSchema>;
type StoredText = z.infer<typeof storedText>;
type SecretUpdate = z.infer<typeof textUpdate>;
type KeyUpdate = Pick<SecretUpdate, "apiKey" | "clearKey">;

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function serviceOrigin(baseUrl: string, service: "text" | SpeechProvider = "text"): string {
  if (!baseUrl) {
    if (service === "whisper-http") throw new SettingError("请填写兼容转写服务的地址。");
    if (service === "seed") return "wss://openspeech.bytedance.com";
    return service === "text" ? "" : "wss://dashscope.aliyuncs.com";
  }
  const webSocket = service !== "text" && service !== "whisper-http";
  try {
    const url = new URL(baseUrl);
    const allowed = webSocket
      ? url.protocol === "wss:"
      : url.protocol === "https:" || (loopbackHosts.has(url.hostname) && url.protocol === "http:");
    if (allowed && !url.username && !url.password && !url.search && !url.hash) return url.origin;
  } catch {
    // The field error below covers both malformed addresses and invalid protocols.
  }
  throw new SettingError(webSocket ? "实时转写地址须使用 wss://。" : "API 地址须使用 HTTPS 或本机 HTTP。");
}

function keyOptional(provider: SpeechProvider, baseUrl: string) {
  if (provider !== "whisper-http") return false;
  try {
    return loopbackHosts.has(new URL(serviceOrigin(baseUrl, provider)).hostname);
  } catch {
    return false;
  }
}

function speechFamily(provider: SpeechProvider) {
  return provider === "qwen-audio" ? "qwen" : provider;
}

export class SettingError extends Error {}

async function readSecret(encrypted?: string): Promise<string> {
  if (!encrypted) return "";
  try {
    return (await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"))).result;
  } catch {
    throw new SettingError("无法读取已保存的 API 密钥，请重新填写。");
  }
}

function validateKeyUpdate(update: KeyUpdate) {
  if (update.clearKey && update.apiKey) throw new SettingError("请取消移除密钥，或清空新输入的密钥。");
}

async function nextSecret(update: KeyUpdate, priorKey: string | undefined, sameService: boolean): Promise<string | undefined> {
  validateKeyUpdate(update);
  if (update.clearKey) return undefined;
  if (!update.apiKey) {
    if (priorKey && !sameService) throw new SettingError("更换服务商地址时，请输入新密钥或移除之前保存的密钥。");
    return priorKey;
  }
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error();
    return (await safeStorage.encryptStringAsync(update.apiKey)).toString("base64");
  } catch {
    throw new SettingError("Windows 密钥加密不可用，设置暂时无法保存。");
  }
}

function publicText({ protocol, baseUrl, model, encryptedKey }: StoredText): PublicSettings["text"] {
  return { protocol, baseUrl, model, hasKey: Boolean(encryptedKey) };
}

function publicSettings({ text, tasks, speech }: StoredSettings): PublicSettings {
  const publicTasks: PublicSettings["tasks"] = {};
  for (const task of textTask.options) {
    if (tasks[task]) publicTasks[task] = publicText(tasks[task]);
  }
  const { provider, baseUrl, model, enabled, encryptedKey } = speech;
  const hasKey = Boolean(encryptedKey);
  return { text: publicText(text), tasks: publicTasks, speech: { provider, baseUrl, model, enabled, hasKey, configured: hasKey || keyOptional(provider, baseUrl) } };
}

function sameTextService(protocol: StoredText["protocol"], origin: string, prior?: StoredText) {
  return prior?.protocol === protocol && serviceOrigin(prior.baseUrl) === origin;
}

async function updateText(update: SecretUpdate, prior?: StoredText): Promise<StoredText> {
  const { protocol, baseUrl, model } = update;
  const encryptedKey = await nextSecret(update, prior?.encryptedKey, sameTextService(protocol, serviceOrigin(baseUrl), prior));
  return { protocol, baseUrl, model, encryptedKey };
}

const defaults: StoredSettings = {
  version: 1,
  text: { protocol: "compatible", baseUrl: "", model: "" },
  tasks: {},
  speech: { provider: "qwen-audio", baseUrl: "", model: "", enabled: false },
};

export function createSettings(directory: string) {
  const file = path.join(directory, "interview-settings.json");
  let pending: Promise<unknown> = Promise.resolve();

  async function read(): Promise<StoredSettings> {
    try {
      return storedSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
      throw new SettingError("无法读取本机应用设置。");
    }
  }

  async function write(settings: StoredSettings) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new SettingError("无法写入本机应用设置。");
    }
  }

  return {
    async get() {
      await pending;
      return publicSettings(await read());
    },
    save(input: unknown) {
      const parsed = updateSchema.safeParse(input);
      if (!parsed.success) throw new SettingError("应用设置格式无效。");
      const update = parsed.data;
      const result = pending.then(async () => {
        const previous = await read();
        const next: StoredSettings = { ...previous, tasks: { ...previous.tasks } };
        if (update.text) next.text = await updateText(update.text, previous.text);
        for (const task of textTask.options) {
          const taskUpdate = update.tasks?.[task];
          if (taskUpdate === null) delete next.tasks[task];
          else if (taskUpdate) next.tasks[task] = await updateText(taskUpdate, previous.tasks[task]);
        }
        if (update.speech) {
          const { provider, baseUrl, model, enabled } = update.speech;
          const prior = previous.speech;
          const origin = serviceOrigin(baseUrl, provider);
          const sameService = speechFamily(provider) === speechFamily(prior.provider) && origin === serviceOrigin(prior.baseUrl, prior.provider);
          const encryptedKey = await nextSecret(update.speech, prior.encryptedKey, sameService);
          next.speech = { provider, baseUrl, model, enabled: enabled ?? (prior.enabled || Boolean(encryptedKey)), encryptedKey };
        }
        await write(next);
        return publicSettings(next);
      });
      pending = result.catch(() => undefined);
      return result;
    },
    async text(task?: TextTask): Promise<TextProfile> {
      await pending;
      const settings = await read();
      const { protocol, baseUrl, model, encryptedKey } = (task && settings.tasks[task]) || settings.text;
      return { protocol, baseUrl, model, apiKey: await readSecret(encryptedKey) };
    },
    async textConnection(input: unknown, task?: TextTask): Promise<Omit<TextProfile, "model">> {
      const parsed = textConnection.safeParse(input);
      if (!parsed.success) throw new SettingError("请选择接口格式并填写有效的 API 地址。");
      const draft = parsed.data;
      validateKeyUpdate(draft);
      const { protocol, baseUrl } = draft;
      const origin = serviceOrigin(baseUrl);
      if (draft.apiKey || draft.clearKey) return { protocol, baseUrl, apiKey: draft.apiKey || "" };
      await pending;
      const settings = await read();
      // A new task override is its own profile, including its credential.
      const prior = task ? settings.tasks[task] : settings.text;
      const apiKey = sameTextService(protocol, origin, prior) ? await readSecret(prior?.encryptedKey) : "";
      return { protocol, baseUrl, apiKey };
    },
    async speech(requireEnabled: boolean) {
      await pending;
      const { provider, baseUrl, model, enabled, encryptedKey } = (await read()).speech;
      if (requireEnabled && !enabled) throw new SettingError("请先在设置中启用语音识别。");
      serviceOrigin(baseUrl, provider);
      const apiKey = await readSecret(encryptedKey);
      if (!apiKey && !keyOptional(provider, baseUrl)) throw new SettingError("请填写所选语音服务的 API Key。");
      return { protocol: provider, baseUrl, model, apiKey };
    },
  };
}
