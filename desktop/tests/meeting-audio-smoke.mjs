import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const { _electron } = requireDesktop("playwright");
const executablePath = requireDesktop("electron");
const fixtureTitle = `Aural Synthetic Meeting ${process.pid}`;
const toneHz = 860;
const sampleRate = 16_000;
const text = "这是独立合成会议音轨的验证转写。";
const microphoneText = "这是模拟本机麦克风音轨的验证转写。";

assert(process.platform === "win32" && Number(release().split(".")[2]) >= 20_348, "Requires Windows build 20348 or later.");
assert(existsSync(path.join(desktop, "build", "main.cjs")) && existsSync(path.join(desktop, "build", "native", "aural-meeting-audio.exe")),
  "Run npm --prefix desktop run build first.");

const tempRoot = await realpath(tmpdir());
const isolated = await mkdtemp(path.join(tempRoot, "aural-meeting-smoke-"));
const playerDirectory = path.join(isolated, "player");
const playerProfile = path.join(isolated, "player-profile");
const interviewProfile = path.join(isolated, "interview-profile");
const uploads = [];
const requestErrors = [];
let microphoneAllowed = false;
let player;
let desktopApp;

function toneAmplitude(pcm, hz) {
  let sine = 0;
  let cosine = 0;
  const count = pcm.length / 2;
  for (let sample = 0; sample < count; sample++) {
    const value = pcm.readInt16LE(sample * 2);
    const phase = 2 * Math.PI * hz * sample / sampleRate;
    sine += value * Math.sin(phase);
    cosine += value * Math.cos(phase);
  }
  return Math.hypot(sine, cosine) * 2 / count;
}

const whisper = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/audio/transcriptions");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, undefined);
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert(size < 256 * 1024, "Synthetic upload exceeds the chunk limit.");
      chunks.push(chunk);
    }
    const multipart = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers["content-type"] } }).formData();
    assert.equal(multipart.get("model"), "whisper-1");
    const file = multipart.get("file");
    assert(file instanceof File);
    const wav = Buffer.from(await file.arrayBuffer());
    assert(wav.length > 44 && wav.length <= 44 + sampleRate * 2 * 6);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), sampleRate);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    const pcm = wav.subarray(44);
    const pickedTone = toneAmplitude(pcm, toneHz);
    const otherTone = toneAmplitude(pcm, 490);
    const source = pickedTone > 400 && pickedTone > otherTone * 6 ? "meeting" : "mic";
    assert(source === "meeting" || microphoneAllowed,
      `Whisper received a clip without the fixture tone before the fake mic was opened: ${Math.round(pickedTone)} versus ${Math.round(otherTone)}.`);
    uploads.push({ source, bytes: pcm.length, pickedTone });
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: source === "meeting" ? text : microphoneText }));
  } catch (error) {
    requestErrors.push(error.message);
    response.writeHead(500).end();
  }
});

async function writeToneFixture() {
  await mkdir(playerDirectory);
  await writeFile(path.join(playerDirectory, "package.json"), JSON.stringify({ name: "aural-tone-fixture", main: "main.cjs" }));
  await writeFile(path.join(playerDirectory, "main.cjs"), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.AURAL_MEETING_SMOKE_PLAYER_PROFILE);
app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(() => {
  const window = new BrowserWindow({ title: ${JSON.stringify(fixtureTitle)}, width: 500, height: 240, show: true,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  window.loadFile('player.html');
});
app.on('window-all-closed', () => app.quit());
`);
  await writeFile(path.join(playerDirectory, "player.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${fixtureTitle}</title></head><body>
<button type="button">Play synthetic tone</button><script>
const button = document.querySelector("button");
let context;
button.addEventListener("click", async () => {
  button.disabled = true;
  context ??= new AudioContext();
  await context.resume();
  const signal = context.createOscillator();
  const gain = context.createGain();
  const start = context.currentTime + 0.05;
  signal.frequency.value = ${toneHz};
  gain.gain.setValueAtTime(0.07, start);
  gain.gain.setValueAtTime(0.001, start + 0.85);
  signal.connect(gain).connect(context.destination);
  signal.onended = () => { button.disabled = false; };
  signal.start(start);
  signal.stop(start + 1.95);
});
</script></body></html>`);
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
async function waitForStatus(page, source, status) {
  await page.waitForFunction(({ source, status }) => globalThis.__meetingSmokeEvents.some((event) =>
    event.source === source && event.type === "status" && event.status === status), { source, status }, { timeout: 12_000 });
}

try {
  await writeToneFixture();
  await new Promise((resolve, reject) => whisper.once("error", reject).listen(0, "127.0.0.1", resolve));
  const commonEnv = { ...process.env };
  delete commonEnv.ELECTRON_RUN_AS_NODE;
  delete commonEnv.AURAL_DESKTOP_TEST_MIC;
  player = await _electron.launch({ executablePath, args: [playerDirectory], cwd: playerDirectory,
    env: { ...commonEnv, AURAL_MEETING_SMOKE_PLAYER_PROFILE: playerProfile }, timeout: 15_000 });
  const tone = await player.firstWindow();
  await button(tone, "Play synthetic tone").waitFor({ state: "visible" });

  desktopApp = await _electron.launch({ executablePath, args: [desktop], cwd: desktop,
    env: { ...commonEnv, AURAL_DESKTOP_TEST_MODE: "1", AURAL_DESKTOP_TEST_DATA_DIR: interviewProfile, AURAL_DESKTOP_TEST_MIC: "1" }, timeout: 15_000 });
  assert.equal(await desktopApp.evaluate(({ app }) => app.getPath("userData")), interviewProfile);
  assert(await desktopApp.evaluate(({ app }) => app.commandLine.hasSwitch("use-fake-device-for-media-stream")));
  const interview = await desktopApp.firstWindow();
  interview.setDefaultTimeout(12_000);
  await button(interview, "开始面试").waitFor({ state: "visible" });
  await interview.evaluate(() => {
    globalThis.__meetingSmokeMicCalls = 0;
    globalThis.__meetingSmokeEvents = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: (...args) => {
        globalThis.__meetingSmokeMicCalls++;
        return getUserMedia(...args);
      },
    });
    window.auralDesktop.onAsrEvent((event) => globalThis.__meetingSmokeEvents.push(event));
  });

  await button(interview, "模型设置").click();
  const settings = interview.getByRole("dialog", { name: "模型设置" });
  await button(settings, "语音识别").click();
  const speech = settings.locator('form[data-tab="speech"]');
  await speech.locator('select[name="service"]').selectOption("whisper-http");
  await speech.getByRole("switch", { name: "启用语音识别" }).check();
  await speech.getByLabel("服务地址", { exact: true }).fill(`http://127.0.0.1:${whisper.address().port}/v1`);
  await button(speech, "保存").click();
  await speech.getByText("已保存", { exact: true }).waitFor({ state: "visible" });
  await button(settings, "关闭模型设置").click();

  const sources = interview.locator("details.audio-sources");
  if (!(await sources.evaluate((details) => details.open))) {
    await sources.locator("summary").click();
  }
  const mic = interview.getByRole("switch", { name: "开场时开启本机麦克风" });
  assert.equal(await mic.isChecked(), false);
  await interview.getByRole("switch", { name: "开场时连接会议应用" }).check();
  const picker = interview.getByRole("combobox", { name: "选择会议应用" });
  const option = picker.locator("option").filter({ hasText: fixtureTitle });
  await option.waitFor({ state: "attached" });
  await picker.selectOption(await option.getAttribute("value"));
  await button(interview, "开始面试").click();
  await waitForStatus(interview, "meeting", "ready");
  await button(interview, "开启麦克风").waitFor({ state: "visible" });

  await button(tone, "Play synthetic tone").click();
  const row = interview.getByRole("article").filter({ hasText: text });
  await row.locator(".segment-tags").getByText("会议音频", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await row.locator("select").inputValue(), "unknown");
  assert(await button(interview, "评本题").isDisabled());
  assert(await interview.evaluate(() => globalThis.__meetingSmokeEvents.some((event) => event.source === "meeting" && event.type === "final")));
  assert.equal(await interview.evaluate(() => globalThis.__meetingSmokeMicCalls), 0);
  assert.deepEqual(uploads.map(({ source }) => source), ["meeting"]);
  console.log("PASS listed and captured a separate Windows process, heard its synthetic tone at 16 kHz, and rendered a meeting-only final transcript");

  microphoneAllowed = true;
  await button(interview, "开启麦克风").click();
  await waitForStatus(interview, "mic", "ready");
  const waitForMovingMeter = () => interview.waitForFunction(() => document.querySelector("#mic-meter")?.value > 0.03);
  await waitForMovingMeter();
  assert.equal(await interview.evaluate(() => globalThis.__meetingSmokeMicCalls), 1);
  assert(await button(interview, "关闭会议音频").isEnabled());

  await button(interview, "关闭会议音频").click();
  await button(interview, "连接会议音频").waitFor({ state: "visible" });
  await waitForStatus(interview, "meeting", "stopped");
  assert(await button(interview, "关闭麦克风").isEnabled());
  await waitForMovingMeter();
  assert(await interview.evaluate(() => !globalThis.__meetingSmokeEvents.some((event) =>
    event.source === "mic" && event.type === "status" && event.status === "stopped")));

  await button(tone, "Play synthetic tone").click();
  await delay(2_200);
  await button(interview, "关闭麦克风").click();
  await waitForStatus(interview, "mic", "stopped");
  await interview.getByRole("article").filter({ hasText: microphoneText })
    .locator(".segment-tags").getByText("本机麦克风", { exact: true }).waitFor({ state: "visible" });
  assert.deepEqual(requestErrors, []);
  assert.equal(uploads.filter(({ source }) => source === "meeting").length, 1,
    "Stopped meeting capture must not upload subsequent fixture playback.");
  assert(uploads.some(({ source }) => source === "mic"));
  assert.equal(await interview.evaluate(() => globalThis.__meetingSmokeMicCalls), 1);
  console.log("PASS meeting and fake microphone coexist; stopping meeting preserves the mic meter and separately attributed transcript, with no fixture playback leak");
} catch (error) {
  if (requestErrors.length) console.error("Loopback Whisper test rejected a request:", requestErrors.join("; "));
  throw error;
} finally {
  try {
    await Promise.allSettled([desktopApp?.close(), player?.close()]);
  } finally {
    await new Promise((resolve) => {
      whisper.close(resolve);
      whisper.closeAllConnections();
    });
    assert(path.dirname(isolated) === tempRoot && path.basename(isolated).startsWith("aural-meeting-smoke-"));
    await rm(isolated, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}
