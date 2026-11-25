import type {
  DesktopBridge,
  PublicSettings,
  PublicSpeechProfile,
  PublicTextProfile,
  SettingsUpdate,
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
const qwen = { protocol: "compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", hasKey: false } satisfies PublicTextProfile;
const gemini = { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.1-flash-lite" };

function keyField(saved: boolean) {
  return `<label>API Key<input name="apiKey" type="password" autocomplete="off" spellcheck="false" maxlength="4096"
    placeholder="${saved ? "已保存 · 留空保留" : "输入 API Key"}"></label>
    ${saved ? '<label class="check"><input name="clearKey" type="checkbox">移除已保存的密钥</label>' : ""}`;
}

function textFields(profile: PublicTextProfile) {
  return `<label>供应商接口<select name="protocol"><option value="compatible">OpenAI 兼容</option>
    <option value="gemini" ${profile.protocol === "gemini" ? "selected" : ""}>Gemini</option></select></label>
    <label>API 地址<input name="baseUrl" value="${h(profile.baseUrl)}" type="url" placeholder="https://…" maxlength="300" spellcheck="false"></label>
    <label>模型名称<input name="model" value="${h(profile.model)}" placeholder="模型 ID" maxlength="160" spellcheck="false"></label>
    ${keyField(profile.hasKey)}`;
}

function speechFields(profile: PublicSpeechProfile) {
  return `<label class="check"><input name="enabled" type="checkbox" ${profile.enabled ? "checked" : ""}>启用在线语音识别</label>
    <label>供应商接口<select name="provider">
    <option value="qwen-audio">Qwen Audio</option><option value="qwen" ${profile.provider === "qwen" ? "selected" : ""}>Qwen Realtime</option></select></label>
    <label>API 地址<input name="baseUrl" value="${h(profile.baseUrl)}" type="url"
    placeholder="留空使用供应商默认地址" maxlength="300" spellcheck="false"></label>
    <label>模型名称<input name="model" value="${h(profile.model)}" placeholder="留空使用默认模型" maxlength="160" spellcheck="false"></label>
    ${keyField(profile.hasKey)}`;
}

function fields(tab: Tab, settings: PublicSettings) {
  if (tab === "speech") return speechFields(settings.speech);
  if (tab === "text") return textFields(settings.text);

  const override = settings.tasks[tab];
  const fallback: PublicTextProfile = { ...settings.text, hasKey: false };
  return `<label class="check"><input name="inherit" type="checkbox" ${override ? "" : "checked"}>使用默认文本模型</label>
    <fieldset ${override ? "" : "disabled"}>${textFields(override ?? fallback)}</fieldset>`;
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
    const provider = input("provider") === "qwen" ? "qwen" : "qwen-audio";
    return { speech: { ...connection, provider, enabled: data.has("enabled") } };
  }
  const protocol: TextProtocol = input("protocol") === "gemini" ? "gemini" : "compatible";
  const text = { ...connection, protocol };
  return tab === "text" ? { text } : { tasks: { [tab]: data.has("inherit") ? null : text } };
}

export function showSettings(
  bridge: DesktopBridge,
  initial: PublicSettings,
  onSave: (settings: PublicSettings) => void,
  preferred: Tab = "text",
) {
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
    dialog.querySelector(`[data-select="${tab}"]`)?.addEventListener("click", () => {
      for (const item of dialog.querySelectorAll<HTMLFormElement>("form")) item.hidden = item.dataset.tab !== tab;
      for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-select]")) button.setAttribute("aria-pressed", String(button.dataset.select === tab));
    });
    form.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.name === "inherit") {
        const fieldset = form.querySelector("fieldset");
        if (fieldset) fieldset.disabled = target.checked;
      }
      if (target.name === "protocol") {
        const address = form.querySelector<HTMLInputElement>("[name='baseUrl']");
        const model = form.querySelector<HTMLInputElement>("[name='model']");
        const before = target.value === "gemini" ? qwen : gemini;
        const after = target.value === "gemini" ? gemini : qwen;
        if (address && (!address.value || address.value === before.baseUrl)) address.value = after.baseUrl;
        if (model && (!model.value || model.value === before.model)) model.value = after.model;
      }
    });
    async function save(test: boolean) {
      if (!form.reportValidity()) return;
      status.textContent = test ? "测试中…" : "保存中…";
      status.classList.remove("error");
      saveButton.disabled = true;
      testButton.disabled = true;
      try {
        const settings = await bridge.saveSettings(settingsUpdate(tab, form));
        onSave(settings);
        fieldArea.innerHTML = fields(tab, settings);
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
