import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
import type { PublicSettings, TextTask } from "./bridge-types";
import { QWEN_COMPATIBLE_PRESET, type TextProfile } from "./text";

const address = z.string().trim().max(2048);
const model = z.string().trim().max(256);
const textFields = { protocol: z.enum(["compatible", "gemini"]), baseUrl: address, model };
const speechFields = { provider: z.enum(["qwen", "qwen-audio"]), baseUrl: address, model };
const secretUpdate = {
  apiKey: z.string().trim().max(4096).regex(/^[!-~]*$/).optional(),
  clearKey: z.boolean().optional(),
};
const encryptedKey = z.string().max(16_384).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional();
const textUpdate = z.strictObject({ ...textFields, ...secretUpdate });
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

function serviceOrigin(baseUrl: string, speech = false): string {
  if (!baseUrl) return speech ? "wss://dashscope.aliyuncs.com" : "";
  try {
    const url = new URL(baseUrl);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    const allowed = speech ? url.protocol === "wss:" : url.protocol === "https:" || (local && url.protocol === "http:");
    if (allowed && !url.username && !url.password && !url.search && !url.hash) return url.origin;
  } catch {
    // The field error below covers both malformed addresses and invalid protocols.
  }
  throw new SettingError(speech ? "语音 API 地址须为有效的 wss:// 地址。" : "文本 API 地址须为有效的 HTTPS 地址或本机 HTTP 地址。");
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

async function nextSecret(update: KeyUpdate, priorKey: string | undefined, sameService: boolean): Promise<string | undefined> {
  if (update.clearKey && update.apiKey) throw new SettingError("请取消移除密钥，或清空新输入的密钥。");
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
  return { text: publicText(text), tasks: publicTasks, speech: { provider, baseUrl, model, enabled, hasKey: Boolean(encryptedKey) } };
}

async function updateText(update: SecretUpdate, prior?: StoredText): Promise<StoredText> {
  const { protocol, baseUrl, model } = update;
  const origin = serviceOrigin(baseUrl);
  const sameService = prior?.protocol === protocol && serviceOrigin(prior.baseUrl) === origin;
  const encryptedKey = await nextSecret(update, prior?.encryptedKey, sameService);
  return { protocol, baseUrl, model, encryptedKey };
}

const defaults: StoredSettings = {
  version: 1,
  text: { ...QWEN_COMPATIBLE_PRESET },
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
          const sameService = serviceOrigin(baseUrl, true) === serviceOrigin(prior.baseUrl, true);
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
    async speech(requireEnabled: boolean) {
      await pending;
      const { provider, baseUrl, model, enabled, encryptedKey } = (await read()).speech;
      if (requireEnabled && !enabled) throw new SettingError("请先在设置中启用在线语音识别。");
      const apiKey = await readSecret(encryptedKey);
      if (!apiKey) throw new SettingError("请先在设置中填写语音识别 API 密钥。");
      return { protocol: provider, baseUrl, model, apiKey };
    },
  };
}
