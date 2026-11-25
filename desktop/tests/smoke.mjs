import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
const defaultKey = "local-smoke-default-key";
const scoreKey = "local-smoke-score-key";
const screenshotDirectory = process.env.AURAL_DESKTOP_SMOKE_SCREENSHOTS;

const requests = [];
const modelServer = createServer(async (request, response) => {
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      assert(length < 128 * 1024, "Unexpectedly oversized test request.");
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ pathname: request.url, body: payload });
    assert.equal(request.method, "POST");
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
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] }));
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
  electron = await _electron.launch({ executablePath, args: [desktop], cwd: desktop, env, timeout: 15_000 });
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

  await visible(main.getByRole("heading", { name: "开始面试" }));
  assert.equal(await main.getByLabel("JD", { exact: true }).inputValue(), "");
  assert.equal(await main.getByLabel("简历", { exact: true }).inputValue(), "");
  assert.equal(requests.length, 0);
  await screenshot(main, "Home");

  await button(main, "模型设置").click();
  const modal = main.getByRole("dialog", { name: "模型设置" });
  await visible(modal);
  const saveAndProbe = async (tab, model, key, route) => {
    const form = modal.locator(`form[data-tab="${tab}"]`);
    await form.getByLabel("API 地址").fill(`${base}/${route}/v1`);
    await form.getByLabel("模型名称").fill(model);
    await form.getByLabel("API Key").fill(key);
    await button(form, "保存并测试").click();
    await visible(exactText(form, "连接成功"));
    assert.equal(await form.getByLabel("API Key").inputValue(), "");
  };
  await saveAndProbe("text", defaultModel, defaultKey, "default");
  await button(modal, "评分").click();
  await modal.locator('form[data-tab="score"]').getByRole("checkbox", { name: "使用默认文本模型" }).uncheck();
  await saveAndProbe("score", scoreModel, scoreKey, "score");
  await button(modal, "关闭模型设置").click();
  const stored = await readFile(path.join(userData, "interview-settings.json"), "utf8");
  assert(!stored.includes(defaultKey) && !stored.includes(scoreKey));
  const settings = JSON.parse(stored);
  assert.equal(settings.text.model, defaultModel);
  assert.equal(settings.tasks.score.model, scoreModel);
  assert(settings.text.encryptedKey && settings.tasks.score.encryptedKey);
  assert.equal(requests.length, 2);
  console.log("PASS default and per-task model settings, encryption and connection probes");

  await main.getByRole("switch", { name: "开始时开启电脑麦克风" }).check();
  await button(main, "开始面试").click();
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
  assert.deepEqual(errors, []);
  console.log("PASS blank API key save keeps the encrypted key, explicit removal clears it");
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
