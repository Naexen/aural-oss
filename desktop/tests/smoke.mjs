import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const { _electron } = requireDesktop("playwright");
const executablePath = requireDesktop("electron");
assert(existsSync(path.join(desktop, "build", "main.cjs")), "Run npm --prefix desktop run build first.");

const candidateQuote = "我核对了监控、实施回滚，并验证错误率从 5% 降到了 1%。";
const interviewerText = "面试官测试内容，不得发送为候选人证据。";
const feedback = "回答给出了操作及前后对照数据。";
const followUp = "如何排除同期其他改动的影响？";
const questionTwo = "那段经历中，最难的问题是什么？你怎么验证解决方案有效？";
const defaultModel = "synthetic-default";
const scoreModel = "synthetic-score";
const anthropicModel = "synthetic-anthropic";
const defaultKey = "local-smoke-default-key";
const scoreKey = "local-smoke-score-key";
const anthropicKey = "local-smoke-anthropic-key";
const legacySpeechKey = "local-smoke-legacy-speech-key";
const whisperQuote = "这是一条本机兼容语音服务的测试转写。";
const whisperPath = "/whisper/v1/audio/transcriptions";
const screenshotDirectory = process.env.AURAL_DESKTOP_SMOKE_SCREENSHOTS;

const requests = [];
const audioRequests = [];
const modelDiscoveries = [];
const anthropicRequests = [];

function respondJson(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function assertAnthropicHeaders(request) {
  assert.equal(request.headers["x-api-key"], anthropicKey);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers.authorization, undefined);
}

function modelList(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const known = {
    "/default/v1/models": { key: defaultKey, model: defaultModel },
    "/score/v1/models": { key: scoreKey, model: scoreModel },
    "/anthropic/v1/models": { key: anthropicKey, model: anthropicModel },
  };
  const setup = known[url.pathname];
  assert(setup, "Unexpected model list path.");
  modelDiscoveries.push(url.pathname);
  if (setup.model === anthropicModel) {
    assertAnthropicHeaders(request);
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.has("after_id"), false);
    respondJson(response, {
      data: [{ id: setup.model, type: "model", display_name: "Synthetic Anthropic model", created_at: "2026-01-01T00:00:00Z" }],
      has_more: false,
    });
    return;
  }
  assert.equal(request.headers.authorization, `Bearer ${setup.key}`);
  assert.equal(url.search, "");
  respondJson(response, { object: "list", data: [{ id: "another-local-model", object: "model" }, { id: setup.model, object: "model" }] });
}

async function readWhisperRequest(request, body) {
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, undefined);
  assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
  const form = await new Response(body, { headers: { "Content-Type": request.headers["content-type"] } }).formData();
  assert.equal(form.get("model"), "whisper-1");
  assert.equal(form.get("response_format"), "json");
  const file = form.get("file");
  assert(file instanceof File);
  assert.equal(file.type, "audio/wav");
  const wav = Buffer.from(await file.arrayBuffer());
  assert(wav.length > 44 && wav.length <= 44 + 16_000 * 2 * 6);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  let peak = 0;
  for (let index = 44; index < wav.length; index += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(index)));
  audioRequests.push({ bytes: wav.length - 44, peak });
  return { text: peak ? whisperQuote : "" };
}

const modelServer = createServer(async (request, response) => {
  try {
    if (request.method === "GET") {
      modelList(request, response);
      return;
    }
    const whisper = request.url === whisperPath;
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      assert(length < (whisper ? 256 : 128) * 1024, "Unexpectedly oversized test request.");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (whisper) {
      respondJson(response, await readWhisperRequest(request, body));
      return;
    }
    const payload = JSON.parse(body.toString());
    assert.equal(request.method, "POST");
    if (request.url === "/anthropic/v1/messages") {
      assertAnthropicHeaders(request);
      assert.equal(payload.model, anthropicModel);
      assert.equal(payload.messages[0].role, "user");
      anthropicRequests.push(request.url);
      respondJson(response, {
        id: "msg_synthetic", type: "message", role: "assistant", model: anthropicModel,
        content: [{ type: "text", text: '{"ok":true}' }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      });
      return;
    }
    requests.push({ pathname: request.url, body: payload });
    assert.deepEqual(payload.response_format, { type: "json_object" });
    const scoring = request.url === "/score/v1/chat/completions";
    assert.equal(request.url, scoring ? "/score/v1/chat/completions" : "/default/v1/chat/completions");
    assert.equal(payload.model, scoring ? scoreModel : defaultModel);
    assert.equal(request.headers.authorization, `Bearer ${scoring ? scoreKey : defaultKey}`);

    let result;
    if (payload.messages[1].content === 'Return this JSON: {"ok":true}') {
      result = { ok: true };
    } else if (payload.messages[0].content.includes("建议一句")) {
      assert(!scoring, "Suggestions must use the default text model.");
      result = { followUp, nextQuestionId: "q2" };
    } else {
      assert(scoring, "Scoring must use the score override.");
      const input = JSON.parse(payload.messages[1].content);
      assert.equal(input.question.id, "q1");
      assert.equal(input.candidateSegments.length, 1);
      assert.equal(input.candidateSegments[0].text, candidateQuote);
      assert(!payload.messages[1].content.includes(interviewerText));
      result = {
        score: 4,
        feedback,
        evidence: [{ segmentId: input.candidateSegments[0].id, quote: candidateQuote }],
        followUp,
        nextQuestionId: "q2",
      };
    }
    respondJson(response, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] });
  } catch (error) {
    process.stderr.write(`Local mock assertion failed: ${error.message}\n`);
    response.writeHead(500).end();
  }
});

const temporaryRoot = await realpath(tmpdir());
const userData = await mkdtemp(path.join(temporaryRoot, "aural-desktop-smoke-"));
let electron;
let clipboardBefore;
let clipboardAfter;
try {
  await new Promise((resolve, reject) => modelServer.once("error", reject).listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${modelServer.address().port}`;
  const env = { ...process.env, AURAL_DESKTOP_TEST_MODE: "1", AURAL_DESKTOP_TEST_DATA_DIR: userData, AURAL_DESKTOP_TEST_MIC: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath, args: [desktop], cwd: desktop, env, timeout: 15_000 });
  electron = await launch();
  const main = await electron.firstWindow();
  main.setDefaultTimeout(10_000);
  const errors = [];
  main.on("pageerror", (error) => errors.push(error.message));
  const visible = (locator) => locator.waitFor({ state: "visible" });
  const button = (part, name) => part.getByRole("button", { name, exact: true });
  const exactText = (part, text) => part.getByText(text, { exact: true });
  const screenshot = async (window, name) => {
    if (screenshotDirectory) await window.screenshot({ path: path.join(screenshotDirectory, `Aural-Interview-${name}.png`) });
  };
  assert.equal(await electron.evaluate(({ app }) => app.getPath("userData")), userData);
  assert(await electron.evaluate(({ app }) => app.commandLine.hasSwitch("use-fake-device-for-media-stream")));

  const startButton = button(main, "开始面试");
  const startMic = main.getByRole("switch", { name: "开始时开启电脑麦克风" });
  const intakeSummary = exactText(main, "面试资料");
  await visible(startButton);
  assert.equal(await startButton.count(), 1);
  assert.equal(await exactText(main, "开始面试").filter({ visible: true }).count(), 1);
  const [startBounds, micBounds, intakeBounds] = await Promise.all([
    startButton.boundingBox(), startMic.boundingBox(), intakeSummary.boundingBox(),
  ]);
  assert(startBounds && micBounds && intakeBounds, "Expected the start button, microphone switch, and interview materials on the homepage.");
  const startBottom = startBounds.y + startBounds.height;
  assert(startBottom <= micBounds.y && startBottom <= intakeBounds.y, "Expected the start button above the microphone switch and interview materials.");
  assert.equal(await main.getByLabel("JD", { exact: true }).inputValue(), "");
  assert.equal(await main.getByLabel("简历", { exact: true }).inputValue(), "");
  assert.equal(requests.length, 0);
  await screenshot(main, "Home");

  await button(main, "模型设置").click();
  const modal = main.getByRole("dialog", { name: "模型设置" });
  await visible(modal);
  await button(modal, "语音识别").click();
  const defaultSpeech = modal.locator('form[data-tab="speech"]');
  const service = defaultSpeech.getByRole("combobox", { name: /语音服务/ });
  assert.equal(await service.inputValue(), "qwen");
  assert.deepEqual(await service.locator("option").evaluateAll((options) => options.map(({ value, label }) => [value, label])), [
    ["qwen", "阿里云 · 千问实时转写"],
    ["seed", "火山引擎 · 豆包实时转写"],
    ["whisper-http", "兼容转写服务 · Whisper"],
  ]);
  await visible(defaultSpeech.getByLabel("百炼 API Key", { exact: true }));
  const defaultAdvanced = defaultSpeech.locator("details");
  assert.equal(await defaultAdvanced.evaluate((details) => details.open), false);
  await screenshot(main, "Speech-Settings-0.1.1");
  await defaultAdvanced.locator("summary").click();
  assert.equal(await defaultSpeech.locator('select[name="provider"]').inputValue(), "qwen-audio");
  await button(modal, "默认文本模型").click();
  console.log("PASS fresh setup defaults to 千问 and keeps realtime protocol choices in advanced settings");
  const defaultTextForm = modal.locator('form[data-tab="text"]');
  const protocolSelector = (form) => form.locator('select[name="textProtocol"]');
  const interfaces = await protocolSelector(defaultTextForm).locator("option").evaluateAll((options) => options.map(({ label }) => label));
  assert.deepEqual(interfaces, ["OpenAI Compatible", "Anthropic Compatible"]);
  assert.equal(await defaultTextForm.getByLabel("API 地址", { exact: true }).inputValue(), "");
  assert.equal(await defaultTextForm.locator('select[name="model"]').inputValue(), "");
  await screenshot(main, "Text-Settings-0.1.1");
  const settingsFile = path.join(userData, "interview-settings.json");
  const savedText = () => existsSync(settingsFile) ? readFile(settingsFile, "utf8") : undefined;
  const saveAndProbe = async (tab, model, key, endpoint, compatibleInterface = "OpenAI Compatible") => {
    const form = modal.locator(`form[data-tab="${tab}"]`);
    await protocolSelector(form).selectOption({ label: compatibleInterface });
    await form.getByLabel("API 地址").fill(`${base}/${endpoint}`);
    await form.getByLabel("API Key").fill(key);
    const before = await savedText();
    await button(form, "读取模型").click();
    const modelPicker = form.locator('select[name="model"]');
    await modelPicker.locator(`option[value="${model}"]`).waitFor({ state: "attached" });
    assert.equal(await modelPicker.inputValue(), "", "Discovery should leave model selection to the interviewer.");
    assert.equal(await savedText(), before, "Model discovery must leave saved settings unchanged.");
    await modelPicker.selectOption(model);
    await button(form, "保存并测试").click();
    await visible(exactText(form, "连接成功"));
    assert.equal(await form.getByLabel("API Key").inputValue(), "");
  };
  await saveAndProbe("text", defaultModel, defaultKey, "default/v1");
  await button(modal, "评分").click();
  await modal.locator('form[data-tab="score"]').getByRole("checkbox", { name: "使用默认文本模型" }).uncheck();
  await saveAndProbe("score", scoreModel, scoreKey, "score/v1/chat/completions");
  await button(modal, "文字整理").click();
  await modal.locator('form[data-tab="polish"]').getByRole("checkbox", { name: "使用默认文本模型" }).uncheck();
  await saveAndProbe("polish", anthropicModel, anthropicKey, "anthropic/v1/messages", "Anthropic Compatible");
  await button(modal, "关闭模型设置").click();
  const stored = await readFile(settingsFile, "utf8");
  assert(!stored.includes(defaultKey) && !stored.includes(scoreKey) && !stored.includes(anthropicKey));
  const settings = JSON.parse(stored);
  assert.equal(settings.text.model, defaultModel);
  assert.equal(settings.tasks.score.model, scoreModel);
  assert.equal(settings.tasks.polish.model, anthropicModel);
  assert(settings.text.encryptedKey && settings.tasks.score.encryptedKey && settings.tasks.polish.encryptedKey);
  assert.deepEqual(modelDiscoveries, ["/default/v1/models", "/score/v1/models", "/anthropic/v1/models"]);
  assert.deepEqual(anthropicRequests, ["/anthropic/v1/messages"]);
  assert.equal(requests.length, 2);
  console.log("PASS two compatible text interfaces, real draft model discovery, default/per-task model selection and encrypted storage");

  await startMic.check();
  await startButton.click();
  await visible(main.getByRole("heading", { name: "面试中" }));
  await visible(exactText(main, "麦克风开启 · 本地监听"));
  await main.waitForFunction(() => document.querySelector("#mic-meter")?.value > 0, undefined, { timeout: 12_000 });
  await button(main, "关闭麦克风").click();
  await visible(exactText(main, "麦克风关闭"));
  assert.equal(requests.length, 2);
  console.log("PASS zero-context start with fake-device microphone, moving audio meter and stop");

  const facing = main.getByRole("region", { name: "实时转写" });
  const assessment = main.getByRole("region", { name: "当前问题" });
  const manual = facing.getByRole("textbox", { name: "添加转写" });
  const attribution = facing.getByLabel("录入归属");
  const score = button(assessment, "评本题");
  const addLine = async (role, text) => {
    await attribution.selectOption(role);
    await manual.fill(text);
    await button(facing, "添加转写").click();
    await visible(exactText(facing, text));
    return facing.getByRole("article").filter({ hasText: text });
  };
  await addLine("interviewer", interviewerText);
  assert(await score.isDisabled());
  const candidate = await addLine("unknown", candidateQuote);
  assert(await score.isDisabled());
  await candidate.getByRole("combobox", { name: "更改此段说话人" }).selectOption("candidate");
  assert(await score.isEnabled());
  await button(assessment, "建议提问").click();
  await visible(exactText(assessment, followUp));

  const overlayOpened = electron.waitForEvent("window");
  await button(main, "浮窗").click();
  const overlay = await overlayOpened;
  overlay.setDefaultTimeout(10_000);
  overlay.on("pageerror", (error) => errors.push(error.message));
  await visible(button(overlay, "收起浮窗"));
  await visible(exactText(overlay, candidateQuote));
  const nativeOverlay = () => electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith("?view=overlay"));
    return window ? { onTop: window.isAlwaysOnTop(), visible: window.isVisible(), ...window.getBounds() } : null;
  });
  const waitForHeight = async (height) => {
    let dimensions;
    for (let attempt = 0; attempt < 60; attempt++) {
      dimensions = await nativeOverlay();
      if (dimensions?.onTop && dimensions.visible && Math.abs(dimensions.height - height) <= 8) return dimensions;
      await delay(100);
    }
    assert.fail(`Always-on-top overlay failed to reach visible height ${height}. Found ${JSON.stringify(dimensions)}.`);
  };
  const expanded = await waitForHeight(550);
  await button(overlay, "收起浮窗").click();
  await visible(button(overlay, "展开浮窗"));
  assert((await waitForHeight(78)).width < expanded.width);
  await button(overlay, "展开浮窗").click();
  await waitForHeight(550);
  await button(overlay, "评本题").click();
  await visible(exactText(overlay, "4 / 5"));
  await visible(exactText(assessment, feedback));
  await visible(assessment.locator("blockquote").filter({ hasText: candidateQuote }));
  await screenshot(main, "Workbench");
  await screenshot(overlay, "Overlay");
  await button(overlay, "切换").click();
  await visible(assessment.locator(".question").filter({ hasText: questionTwo }));
  assert.equal(await exactText(facing, candidateQuote).count(), 0);
  assert(await score.isDisabled());
  const overlayClosed = overlay.waitForEvent("close");
  await button(overlay, "关闭浮窗").click();
  await overlayClosed;
  console.log("PASS manual attribution, separate suggestion/score routes, exact evidence, overlay compact/expand and next-question control");

  await button(main, "结束面试").click();
  await visible(main.getByRole("heading", { name: "面试结束" }));
  const draft = await main.getByLabel("面评草稿").inputValue();
  assert(draft.includes("暂评分：4/5") && draft.includes(candidateQuote));
  assert(!draft.includes(interviewerText));
  clipboardBefore = await electron.evaluate(async ({ clipboard }) => {
    const formats = (await clipboard.read()).flatMap(({ types }) => types);
    return { formats, text: formats.every((format) => format === "text/plain") ? await clipboard.readText() : "" };
  });
  const canRestoreClipboard = clipboardBefore.formats.every((format) => format === "text/plain");
  if (!canRestoreClipboard) {
    await electron.evaluate(({ clipboard }) => Object.defineProperty(clipboard, "writeText", {
      value: async (text) => { globalThis.__auralSmokeClipboard = text; },
    }));
  }
  await main.bringToFront();
  await button(main, "复制到 Moka").click();
  await visible(exactText(main, "已复制面评草稿"));
  clipboardAfter = canRestoreClipboard ? await electron.evaluate(({ clipboard }) => clipboard.readText()) : undefined;
  const copied = clipboardAfter ?? await electron.evaluate(() => globalThis.__auralSmokeClipboard);
  assert.equal(copied.replace(/\r\n/g, "\n"), draft);
  console.log(`PASS Moka-ready draft copy (${canRestoreClipboard ? "native clipboard" : "isolated clipboard stub preserving user data"})`);

  await button(main, "模型设置").click();
  const defaultForm = modal.locator('form[data-tab="text"]');
  await button(defaultForm, "保存").click();
  await visible(exactText(defaultForm, "已保存"));
  assert.equal(JSON.parse(await readFile(path.join(userData, "interview-settings.json"), "utf8")).text.encryptedKey, settings.text.encryptedKey);
  await defaultForm.getByRole("checkbox", { name: "移除已保存的密钥" }).check();
  await button(defaultForm, "保存").click();
  await defaultForm.getByRole("checkbox", { name: "移除已保存的密钥" }).waitFor({ state: "detached" });
  assert.equal(JSON.parse(await readFile(path.join(userData, "interview-settings.json"), "utf8")).text.encryptedKey, undefined);
  assert.equal(requests.length, 4);
  console.log("PASS blank API key save keeps the encrypted key, explicit removal clears it");

  const legacy = JSON.parse(await readFile(settingsFile, "utf8"));
  delete legacy.tasks.polish;
  const legacyCipher = await electron.evaluate(async ({ safeStorage }, key) => {
    return (await safeStorage.encryptStringAsync(key)).toString("base64");
  }, legacySpeechKey);
  await electron.close();
  electron = undefined;
  legacy.version = 1;
  legacy.tasks.prepare = {
    protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "legacy-gemini-model", encryptedKey: legacyCipher,
  };
  legacy.speech = {
    provider: "qwen", baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    model: "legacy-realtime-model", enabled: false, encryptedKey: legacyCipher,
  };
  await writeFile(settingsFile, JSON.stringify(legacy));
  electron = await launch();
  const speechWindow = await electron.firstWindow();
  speechWindow.setDefaultTimeout(10_000);
  speechWindow.on("pageerror", (error) => errors.push(error.message));
  await visible(button(speechWindow, "开始面试"));
  const readSettings = () => speechWindow.evaluate(() => window.auralDesktop.getSettings());
  const migrated = await readSettings();
  assert.equal(migrated.text.model, defaultModel);
  assert.equal(migrated.tasks.score.model, scoreModel);
  assert.equal(migrated.tasks.prepare.protocol, "gemini");
  assert.equal(migrated.tasks.prepare.model, legacy.tasks.prepare.model);
  assert.equal(migrated.tasks.prepare.hasKey, true);
  assert.equal(migrated.speech.provider, legacy.speech.provider);
  assert.equal(migrated.speech.baseUrl, legacy.speech.baseUrl);
  assert.equal(migrated.speech.model, legacy.speech.model);
  assert.equal(migrated.speech.hasKey, true);
  assert.equal(migrated.speech.enabled, false);
  assert(!JSON.stringify(migrated).includes(legacyCipher) && !JSON.stringify(migrated).includes(legacySpeechKey));
  assert.equal(await electron.evaluate(({ app }) => app.commandLine.hasSwitch("use-fake-device-for-media-stream")), true);

  await button(speechWindow, "模型设置").click();
  const speechModal = speechWindow.getByRole("dialog", { name: "模型设置" });
  await button(speechModal, "语音识别").click();
  const speechForm = speechModal.locator('form[data-tab="speech"]');
  const speechService = speechForm.getByRole("combobox", { name: /语音服务/ });
  const legacyAdvanced = speechForm.locator("details");
  await legacyAdvanced.locator("summary").click();
  assert.equal(await speechForm.locator('select[name="provider"]').inputValue(), "qwen");
  assert.equal(await speechForm.locator('input[name="baseUrl"]').inputValue(), legacy.speech.baseUrl);
  assert.equal(await speechForm.locator('input[name="model"]').inputValue(), legacy.speech.model);
  assert.equal(await speechForm.getByLabel("百炼 API Key", { exact: true }).inputValue(), "");
  await button(speechForm, "保存").click();
  await visible(exactText(speechForm, "已保存"));
  const afterLegacySave = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(afterLegacySave.speech.encryptedKey, legacyCipher);
  assert.deepEqual(afterLegacySave.tasks, legacy.tasks);
  await speechService.selectOption("seed");
  await visible(speechForm.getByLabel("火山引擎 API Key", { exact: true }));
  assert.equal(await speechForm.getByLabel("火山引擎 API Key", { exact: true }).inputValue(), "");
  assert.equal(await speechForm.locator("details").evaluate((details) => details.open), false);
  console.log("PASS v0.1.0 settings reopen with Qwen transport, text override and encrypted key intact; Seed fields selectable");

  await speechService.selectOption("whisper-http");
  const address = speechForm.getByLabel("服务地址", { exact: true });
  await visible(address);
  assert(await address.evaluate((input) => input.required));
  await address.fill("https://speech.example.invalid/v1");
  await speechForm.getByRole("switch", { name: "启用语音识别", exact: true }).check();
  const removePrevious = speechForm.getByRole("checkbox", { name: "移除上一个服务的密钥", exact: true });
  await button(speechForm, "保存并测试").click();
  await visible(exactText(speechForm, "更换服务商地址时，请输入新密钥或移除之前保存的密钥。"));
  await removePrevious.check();
  await button(speechForm, "保存并测试").click();
  await visible(exactText(speechForm, "请填写所选语音服务的 API Key。"));
  assert.equal((await readSettings()).speech.configured, false);
  assert.deepEqual(audioRequests, []);
  await address.fill(`${base}/whisper/v1`);
  await button(speechForm, "保存并测试").click();
  await visible(exactText(speechForm, "连接成功"));
  assert.deepEqual(audioRequests, [{ bytes: 16_000, peak: 0 }]);
  const configured = (await readSettings()).speech;
  assert.equal(configured.provider, "whisper-http");
  assert.equal(configured.hasKey, false);
  assert.equal(configured.configured, true);
  assert.equal(configured.enabled, true);
  await button(speechModal, "关闭模型设置").click();
  await button(speechWindow, "开始面试").click();
  await visible(speechWindow.getByRole("heading", { name: "面试中" }));
  await button(speechWindow, "开启麦克风").click();
  await visible(exactText(speechWindow, "分段转写中"));
  await speechWindow.waitForFunction(() => document.querySelector("#mic-meter")?.value > 0.06, undefined, { timeout: 12_000 });
  await button(speechWindow, "关闭麦克风").click();
  await visible(exactText(speechWindow, "麦克风关闭"));
  await visible(exactText(speechWindow, whisperQuote));
  assert(audioRequests.slice(1).some(({ peak }) => peak > 300), "No genuine microphone PCM reached the local ASR mock.");
  const speechSegment = speechWindow.getByRole("article").filter({ hasText: whisperQuote }).first();
  assert.equal(await speechSegment.getByRole("combobox", { name: "更改此段说话人" }).inputValue(), "unknown");
  assert.equal(requests.length, 4);
  assert.deepEqual(errors, []);
  console.log("PASS keyless local Whisper probe and genuine fake-microphone PCM → WAV HTTP → final transcript");
} finally {
  try {
    if (electron) {
      try {
        if (clipboardBefore && clipboardAfter !== undefined) {
          await electron.evaluate(async ({ clipboard }, { before, after }) => {
            if ((await clipboard.readText()) !== after) return;
            if (before.formats.length) await clipboard.writeText(before.text);
            else clipboard.clear();
          }, { before: clipboardBefore, after: clipboardAfter });
        }
      } finally {
        await electron.close();
      }
    }
  } finally {
    await new Promise((resolve) => {
      modelServer.close(resolve);
      modelServer.closeAllConnections();
    });
    assert(path.dirname(userData) === temporaryRoot && path.basename(userData).startsWith("aural-desktop-smoke-"));
    await rm(userData, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}
