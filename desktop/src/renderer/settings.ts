import type {
  DesktopBridge,
  PublicSettings,
  PublicSpeechProfile,
  PublicTextProfile,
  SettingsUpdate,
  SpeechProvider,
  TextProtocol,
} from "../main/bridge-types";
import { escapeHtml as h, icon, message } from "./ui";

const tabLabels = {
  text: "默认文本模型",
  speech: "语音识别",
  prepare: "面前简报",
  polish: "文字整理",
  suggest: "提问",
  score: "评分",
} as const;
type Tab = keyof typeof tabLabels;
const tabs = Object.keys(tabLabels) as Tab[];
const speechServices = {
  qwen: "阿里云 · 千问实时转写",
  seed: "火山引擎 · 豆包实时转写",
  "whisper-http": "兼容转写服务 · Whisper",
} as const;
type SpeechService = keyof typeof speechServices;

function keyField(saved: boolean, label = "API Key", placeholder = "输入 API Key", removePrevious = false) {
  const removeLabel = removePrevious ? "移除上一个服务的密钥" : "移除已保存的密钥";
  return `<label>${label}<input name="apiKey" type="password" autocomplete="off" spellcheck="false" maxlength="4096"
    placeholder="${saved ? "已保存 · 留空保留" : placeholder}"></label>
    ${saved || removePrevious ? `<label class="check"><input name="clearKey" type="checkbox">${removeLabel}</label>` : ""}`;
}

function advancedSettings(content: string) {
  return `<details class="advanced-settings">
    <summary>${icon("chevron", 14)}高级设置</summary>
    <div class="advanced-settings-fields">${content}</div>
  </details>`;
}

function textFields(profile: PublicTextProfile) {
  const legacy = profile.protocol === "gemini";
  const model = legacy ? "" : profile.model;
  return `<label>接口格式<select name="textProtocol" required ${legacy ? "data-legacy" : ""}>
    <option value="compatible">OpenAI Compatible</option>
    <option value="anthropic" ${profile.protocol === "anthropic" ? "selected" : ""}>Anthropic Compatible</option>
    </select></label>
    ${legacy ? '<small class="muted">旧版 Gemini 配置仍在使用。更换连接时请选择接口格式。</small>' : ""}
    <label>API 地址<input name="baseUrl" value="${h(legacy ? "" : profile.baseUrl)}" type="url"
      placeholder="https://…/v1" maxlength="2048" spellcheck="false" required></label>
    ${keyField(!legacy && profile.hasKey, "API Key", "输入 API Key", legacy && profile.hasKey)}
    <div class="model-picker">
      <label>模型<select name="model" required>
        <option value="" disabled ${model ? "" : "selected"}>请选择模型</option>
        ${model ? `<option value="${h(model)}" selected>${h(model)}</option>` : ""}
      </select></label>
      <button class="button" type="button" name="readModels">读取模型</button>
    </div>`;
}

function speechService(provider: SpeechProvider): SpeechService {
  return provider === "qwen-audio" ? "qwen" : provider;
}

function speechConnection(profile: PublicSpeechProfile, service: SpeechService) {
  const sameService = service === speechService(profile.provider);
  const baseUrl = sameService ? profile.baseUrl : "";
  const model = sameService ? profile.model : "";
  const whisper = service === "whisper-http";
  const saved = sameService && profile.hasKey;
  const keyLabel = service === "qwen" ? "百炼 API Key" : service === "seed" ? "火山引擎 API Key" : "API Key";
  const address = `<label>${whisper ? "服务地址" : "API 地址"}<input name="baseUrl" value="${h(baseUrl)}" type="url"
    placeholder="${whisper ? "例如 http://127.0.0.1:8000/v1" : "默认服务地址"}" maxlength="2048" spellcheck="false" ${whisper ? "required" : ""}></label>`;
  const version = service === "qwen" ? `<label>接口版本<select name="provider">
    <option value="qwen-audio">千问音频流式（默认）</option><option value="qwen" ${sameService && profile.provider === "qwen" ? "selected" : ""}>千问 Realtime</option>
    </select></label>` : "";
  return `${whisper ? address : ""}
    ${keyField(saved, keyLabel, whisper ? "本机服务可留空" : "输入 API Key", !sameService && profile.hasKey)}
    ${advancedSettings(`${version}${whisper ? "" : address}
      <label>${service === "seed" ? "语音资源 ID" : "模型名称"}<input name="model" value="${h(model)}"
        placeholder="${whisper ? "默认 whisper-1" : "使用服务默认值"}" maxlength="160" spellcheck="false"></label>`)}`;
}

function speechFields(profile: PublicSpeechProfile) {
  const service = speechService(profile.provider);
  return `<label class="check speech-switch"><input name="enabled" type="checkbox" role="switch" ${profile.enabled ? "checked" : ""}>启用语音识别</label>
    <label>语音服务<select name="service">${Object.entries(speechServices).map(([value, label]) =>
      `<option value="${value}" ${value === service ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <div class="provider-profile" data-speech-profile>${speechConnection(profile, service)}</div>`;
}

function fields(tab: Tab, settings: PublicSettings) {
  if (tab === "speech") return speechFields(settings.speech);
  if (tab === "text") return textFields(settings.text);

  const override = settings.tasks[tab];
  return `<label class="check"><input name="inherit" type="checkbox" ${override ? "" : "checked"}>使用默认文本模型</label>
    <fieldset ${override ? "" : "disabled"}>${textFields(override ?? { ...settings.text, hasKey: false })}</fieldset>`;
}

function settingsUpdate(tab: Tab, form: HTMLFormElement): SettingsUpdate {
  const data = new FormData(form);
  const input = (name: string) => String(data.get(name) ?? "").trim();
  const connection = {
    baseUrl: input("baseUrl"),
    model: input("model"),
    apiKey: input("apiKey"),
    clearKey: data.has("clearKey"),
  };
  if (tab === "speech") {
    const service = input("service");
    const provider: SpeechProvider = service === "seed" || service === "whisper-http" ? service : input("provider") === "qwen" ? "qwen" : "qwen-audio";
    return { speech: { ...connection, provider, enabled: data.has("enabled") } };
  }
  if (tab !== "text" && data.has("inherit")) return { tasks: { [tab]: null } };
  const protocol: TextProtocol = input("textProtocol") === "anthropic" ? "anthropic" : "compatible";
  const text = { ...connection, protocol };
  return tab === "text" ? { text } : { tasks: { [tab]: text } };
}

function resetLegacyPicker(form: HTMLElement) {
  const picker = form.querySelector<HTMLSelectElement>("[name='textProtocol'][data-legacy]");
  if (picker) picker.selectedIndex = -1;
}

function setModelOptions(picker: HTMLSelectElement, models: string[] = [], selected = "") {
  const placeholder = new Option("请选择模型", "");
  placeholder.disabled = true;
  picker.replaceChildren(placeholder, ...models.map((id) => new Option(id, id)));
  picker.value = models.includes(selected) ? selected : "";
}

function bindModelPicker(
  bridge: DesktopBridge,
  form: HTMLFormElement,
  status: HTMLElement,
  tab: Exclude<Tab, "speech">,
) {
  let revision = 0;
  let pending = false;
  function setStatus(text: string, failed = false) {
    status.textContent = text;
    status.classList.toggle("error", failed);
  }
  form.addEventListener("input", (event) => {
    const field = event.target as HTMLInputElement;
    if (!["textProtocol", "baseUrl", "apiKey"].includes(field.name)) return;
    revision++;
    pending = false;
    const button = form.querySelector<HTMLButtonElement>("[name='readModels']")!;
    button.disabled = false;
    button.textContent = "读取模型";
    setStatus("");
    setModelOptions(form.querySelector<HTMLSelectElement>("[name='model']")!);
    const key = form.querySelector<HTMLInputElement>("[name='apiKey']")!;
    if (field.name !== "apiKey") key.placeholder = "输入 API Key";
  });
  form.addEventListener("click", async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[name='readModels']");
    if (!button || pending) return;
    const protocol = form.querySelector<HTMLSelectElement>("[name='textProtocol']")!;
    const address = form.querySelector<HTMLInputElement>("[name='baseUrl']")!;
    if (!protocol.reportValidity() || !address.reportValidity()) return;
    const data = new FormData(form);
    const model = form.querySelector<HTMLSelectElement>("[name='model']")!;
    const before = model.value;
    const current = ++revision;
    pending = true;
    button.disabled = true;
    button.textContent = "读取中…";
    setStatus("");
    try {
      const models = await bridge.listTextModels({
        protocol: protocol.value === "anthropic" ? "anthropic" : "compatible",
        baseUrl: address.value.trim(),
        apiKey: String(data.get("apiKey") ?? "").trim(),
        clearKey: data.has("clearKey"),
      }, tab === "text" ? undefined : tab);
      if (revision !== current || !button.isConnected) return;
      setModelOptions(model, models, before);
      setStatus(models.length ? `已读取 ${models.length} 个模型` : "该服务没有返回可选模型。");
    } catch (error) {
      if (revision === current && button.isConnected) setStatus(message(error, "模型读取失败"), true);
    } finally {
      if (revision === current) {
        pending = false;
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = "读取模型";
        }
      }
    }
  });
}

export function showSettings(
  bridge: DesktopBridge,
  initial: PublicSettings,
  onSave: (settings: PublicSettings) => void,
  preferred: Tab = "text",
) {
  let savedSettings = initial;
  const dialog = document.createElement("dialog");
  const sections = tabs.map((tab) => `<form data-tab="${tab}" ${tab === preferred ? "" : "hidden"}>
    <div class="fields">${fields(tab, initial)}</div>
    <footer class="settings-actions"><small role="status"></small>
      <button type="button" class="button" name="test">保存并测试</button>
      <button type="submit" class="button primary">保存</button>
    </footer></form>`).join("");
  dialog.className = "settings-modal";
  dialog.setAttribute("aria-labelledby", "settings-title");
  dialog.innerHTML = `<header class="dialog-title"><h2 id="settings-title">模型设置</h2>
    <button class="icon-button" type="button" data-close aria-label="关闭模型设置">${icon("close")}</button></header>
    <div class="settings-content"><nav aria-label="模型设置">${tabs.map((tab) =>
      `<button type="button" data-select="${tab}" aria-pressed="${tab === preferred}">${tabLabels[tab]}</button>`).join("")}</nav>
      <div class="settings-forms">${sections}</div></div>`;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());

  for (const tab of tabs) {
    const form = dialog.querySelector<HTMLFormElement>(`[data-tab="${tab}"]`)!;
    const status = form.querySelector("small")!;
    const fieldArea = form.querySelector<HTMLElement>(".fields")!;
    const testButton = form.querySelector<HTMLButtonElement>("[name='test']")!;
    const saveButton = form.querySelector<HTMLButtonElement>("[type='submit']")!;
    if (tab !== "speech") {
      resetLegacyPicker(form);
      bindModelPicker(bridge, form, status, tab);
    }
    dialog.querySelector(`[data-select="${tab}"]`)?.addEventListener("click", () => {
      for (const item of dialog.querySelectorAll<HTMLFormElement>("form")) item.hidden = item.dataset.tab !== tab;
      for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-select]")) button.setAttribute("aria-pressed", String(button.dataset.select === tab));
    });
    form.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.name === "service" && Object.hasOwn(speechServices, target.value)) {
        const profile = form.querySelector<HTMLElement>("[data-speech-profile]");
        if (profile) profile.innerHTML = speechConnection(savedSettings.speech, target.value as SpeechService);
      }
      if (target.name === "provider") {
        const sameProtocol = savedSettings.speech.provider === target.value;
        const address = form.querySelector<HTMLInputElement>("[name='baseUrl']");
        const model = form.querySelector<HTMLInputElement>("[name='model']");
        if (address) address.value = sameProtocol ? savedSettings.speech.baseUrl : "";
        if (model) model.value = sameProtocol ? savedSettings.speech.model : "";
      }
      if (target.name === "inherit") {
        const fieldset = form.querySelector("fieldset");
        if (fieldset) fieldset.disabled = target.checked;
      }
    });
    form.addEventListener("invalid", (event) => {
      const details = (event.target as Element).closest("details");
      if (details) details.open = true;
    }, true);
    async function save(test: boolean) {
      if (!form.reportValidity()) return;
      status.textContent = test ? "测试中…" : "保存中…";
      status.classList.remove("error");
      saveButton.disabled = true;
      testButton.disabled = true;
      try {
        const settings = await bridge.saveSettings(settingsUpdate(tab, form));
        savedSettings = settings;
        onSave(settings);
        fieldArea.innerHTML = fields(tab, settings);
        resetLegacyPicker(fieldArea);
        if (tab === "text") {
          for (const inherited of dialog.querySelectorAll<HTMLFormElement>("form")) {
            const inherit = inherited.querySelector<HTMLInputElement>("[name='inherit']");
            const inheritedFields = inherited.querySelector<HTMLElement>(".fields");
            if (inherit?.checked && inheritedFields) {
              inheritedFields.innerHTML = fields(inherited.dataset.tab as Tab, settings);
              resetLegacyPicker(inheritedFields);
            }
          }
        }
        if (test) {
          if (tab === "speech") await bridge.testAsr();
          else await bridge.testText(tab === "text" ? undefined : tab);
        }
        status.textContent = test ? "连接成功" : "已保存";
      } catch (error) {
        status.textContent = message(error, "设置未完成");
        status.classList.add("error");
      } finally {
        saveButton.disabled = false;
        testButton.disabled = false;
      }
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void save(false);
    });
    testButton.addEventListener("click", () => void save(true));
  }
  dialog.showModal();
}
