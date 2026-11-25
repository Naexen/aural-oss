import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  app, BrowserWindow, clipboard, ipcMain, Menu, protocol, screen, session,
  type IpcMainEvent, type IpcMainInvokeEvent, type Session,
} from "electron";
import { z } from "zod";
import { openAsr, testAsr } from "./asr";
import type { AsrEvent, OverlayState } from "./bridge-types";
import { channels } from "./channels";
import { createSettings, SettingError, textTask } from "./settings";
import { listTextModels, runText, testText, TextModelError } from "./text";

const home = "aural://app/index.html";
const contents = new Map([
  ["/index.html", "text/html; charset=utf-8"],
  ["/style.css", "text/css; charset=utf-8"],
  ["/app.js", "text/javascript; charset=utf-8"],
  ["/mic-worklet.js", "text/javascript; charset=utf-8"],
]);
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const expanded = { width: 356, height: 550 };
const compact = { width: 340, height: 78 };
const overlayStateSchema = z.object({
  status: z.string().max(200),
  phase: z.enum(["idle", "live", "ended"]),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  transcript: z.array(z.object({
    label: z.string().max(100),
    text: z.string().max(1800),
    partial: z.boolean().optional(),
  })).max(12).optional(),
  question: z.string().max(1800).nullish(),
  followUp: z.string().max(1800).nullish(),
  nextQuestion: z.string().max(1800).nullish(),
  feedback: z.string().max(1800).nullish(),
  score: z.number().int().min(1).max(5).nullish(),
  listening: z.boolean().optional(),
  busy: z.boolean().optional(),
  canScore: z.boolean().optional(),
  canSuggest: z.boolean().optional(),
});
const overlayActions = z.enum(["mic", "suggest", "score", "next", "show-main"]);
const asrOptions = z.strictObject({ language: z.string().max(30).optional() });
const draftText = z.string().min(1).max(32_768).refine((text) => text.trim().length > 0);
type View = "main" | "overlay";
type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;
type Capture = {
  client?: Awaited<ReturnType<typeof openAsr>>;
  stopping: boolean;
  id: string;
};

process.umask(0o077);
protocol.registerSchemesAsPrivileged([{ scheme: "aural", privileges: { secure: true, standard: true, supportFetchAPI: true } }]);
app.setName("Aural Interview");
app.setAppUserModelId("org.aural.interview");
app.commandLine.appendSwitch("disable-background-networking");

const testMode = !app.isPackaged && process.env.AURAL_DESKTOP_TEST_MODE === "1";
const testDirectory = testMode && process.env.AURAL_DESKTOP_TEST_DATA_DIR;
if (testDirectory && path.isAbsolute(testDirectory)) app.setPath("userData", testDirectory);
if (testMode && process.env.AURAL_DESKTOP_TEST_MIC === "1") {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let desktopSession: Session;
let overlayState: OverlayState | null = null;
let capture: Capture | null = null;

function appUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "aural:" && url.hostname === "app" && !url.username && !url.password && !url.port) return url;
  } catch {
    return null;
  }
  return null;
}

function validView(value: string, view: View) {
  const url = appUrl(value);
  return url?.pathname === "/index.html" && url.search === (view === "main" ? "" : "?view=overlay");
}

function ownsView(event: IpcEvent, view: View) {
  const window = view === "main" ? mainWindow : overlayWindow;
  const frame = event.senderFrame;
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    frame && !frame.parent && validView(frame.url, view));
}

function handle(channel: string, view: View, handler: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!ownsView(event, view)) throw new Error("此窗口无法执行该操作。");
    return handler(...args);
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("请求格式无效。");
  return result.data;
}

function configureSession(current: Session) {
  current.protocol.handle("aural", async (request) => {
    const url = appUrl(request.url);
    const mime = url && contents.get(url.pathname);
    if (!mime || !url || request.method !== "GET") return new Response(null, { status: 404 });
    try {
      const body = await readFile(path.join(__dirname, "renderer", url.pathname.slice(1)));
      return new Response(new Uint8Array(body), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Security-Policy": csp,
          "Content-Type": mime,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  current.webRequest.onBeforeRequest(({ url }, callback) => callback({ cancel: !appUrl(url) && !url.startsWith("data:") }));
  current.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    return permission === "media" && webContents === mainWindow?.webContents && details.isMainFrame &&
      validView(details.requestingUrl ?? webContents.getURL(), "main") && details.mediaType !== "video";
  });
  current.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    callback(permission === "media" && webContents === mainWindow?.webContents && details.isMainFrame &&
      validView(details.requestingUrl, "main") && mediaTypes?.length === 1 && mediaTypes[0] === "audio");
  });
}

function createWindow(view: View, options: Electron.BrowserWindowConstructorOptions) {
  const window = new BrowserWindow({
    ...options,
    icon: path.join(__dirname, "icon.ico"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      session: desktopSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: testMode,
      spellcheck: false,
    },
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const url = view === "main" ? home : `${home}?view=overlay`;
  return { window, load: () => window.loadURL(url) };
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return;
  }
  if (!mainWindow) return;
  const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const { window, load } = createWindow("overlay", {
    ...expanded,
    x: Math.max(area.x, area.x + area.width - expanded.width - 24),
    y: area.y + 32,
    title: "面试助手悬浮窗",
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#f8fafc",
  });
  overlayWindow = window;
  window.on("closed", () => {
    if (overlayWindow === window) overlayWindow = null;
  });
  try {
    await load();
    if (!window.isDestroyed()) window.showInactive();
  } catch {
    if (!window.isDestroyed()) window.close();
    throw new Error("无法打开面试悬浮窗。");
  }
}

function closeOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
}

function sizeOverlay(small: boolean) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const dimensions = small ? compact : expanded;
  const current = overlayWindow.getBounds();
  const area = screen.getDisplayMatching(current).workArea;
  overlayWindow.setBounds({
    ...dimensions,
    x: Math.max(area.x, Math.min(current.x, area.x + area.width - dimensions.width)),
    y: Math.max(area.y, Math.min(current.y, area.y + area.height - dimensions.height)),
  });
}

function sendAsr(event: AsrEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channels.asrEvent, event);
}

function reportStopped(current: Capture) {
  if (capture !== current) return;
  capture = null;
  sendAsr({ type: "status", status: "stopped" });
}

async function stopCapture() {
  const current = capture;
  if (!current) return;
  current.stopping = true;
  if (current.client) {
    current.client.close();
    await current.client.closed;
  }
  reportStopped(current);
}

function registerIpc() {
  const settings = createSettings(app.getPath("userData"));
  handle(channels.settingsGet, "main", () => settings.get());
  handle(channels.settingsSave, "main", (input) => settings.save(input));
  handle(channels.textRun, "main", async (kind, input) => {
    const task = parse(textTask, kind);
    try {
      return await runText(await settings.text(task), task, input);
    } catch (error) {
      if (error instanceof TextModelError || error instanceof SettingError) throw error;
      throw new Error("文本模型请求失败，请重试。");
    }
  });
  handle(channels.textTest, "main", async (kind) => {
    const task = parse(textTask.optional(), kind);
    try {
      return await testText(await settings.text(task));
    } catch (error) {
      if (error instanceof TextModelError || error instanceof SettingError) throw error;
      throw new Error("文本模型连接测试失败，请重试。");
    }
  });
  handle(channels.textModels, "main", async (input, kind) => {
    const task = parse(textTask.optional(), kind);
    try {
      const profile = await settings.textConnection(input, task);
      const models = await listTextModels(profile);
      return models.filter((model) => model !== profile.apiKey &&
        (profile.apiKey.length < 12 || !model.includes(profile.apiKey)));
    } catch (error) {
      if (error instanceof TextModelError || error instanceof SettingError) throw error;
      throw new Error("读取模型列表失败，请检查接口设置。");
    }
  });
  handle(channels.copyDraft, "main", (text) => clipboard.writeText(parse(draftText, text)));
  handle(channels.asrTest, "main", async () => testAsr(await settings.speech(false)));
  handle(channels.asrStart, "main", async (input) => {
    parse(asrOptions, input);
    if (capture && !capture.stopping) return;
    const current: Capture = { id: randomUUID(), stopping: false };
    capture = current;
    sendAsr({ type: "status", status: "connecting" });
    try {
      const profile = await settings.speech(true);
      if (capture !== current || current.stopping) return;
      const client = await openAsr(profile, (event) => {
        if (capture !== current) return;
        if (event.type === "error") {
          sendAsr({ type: "error", message: event.text.slice(0, 500) });
          void stopCapture();
          return;
        }
        const id = `${current.id}-${createHash("sha256").update(event.id).digest("hex").slice(0, 16)}`;
        sendAsr({ type: event.type === "partial" ? "interim" : "final", id, text: event.text.slice(0, 1800) });
      });
      if (capture !== current || current.stopping) {
        client.close();
        return;
      }
      current.client = client;
      void client.closed.then(() => reportStopped(current));
      sendAsr({ type: "status", status: "ready" });
    } catch (error) {
      if (capture !== current || current.stopping) return;
      await stopCapture();
      throw error;
    }
  });
  handle(channels.asrStop, "main", stopCapture);
  ipcMain.on(channels.asrAudio, (event, value: unknown) => {
    if (!ownsView(event, "main") || !capture?.client || capture.stopping) return;
    if (!(value instanceof ArrayBuffer) || value.byteLength === 0 || value.byteLength > 128 * 1024 || value.byteLength % 2) return;
    capture.client.write(new Uint8Array(value));
  });
  handle(channels.overlayOpen, "main", (open) => parse(z.boolean(), open) ? openOverlay() : closeOverlay());
  handle(channels.overlayCompact, "overlay", (small) => sizeOverlay(parse(z.boolean(), small)));
  handle(channels.overlayClose, "overlay", closeOverlay);
  ipcMain.handle(channels.overlayRead, (event) => {
    if (!ownsView(event, "main") && !ownsView(event, "overlay")) throw new Error("此窗口无法读取面试状态。");
    return overlayState;
  });
  ipcMain.on(channels.overlayState, (event, state: unknown) => {
    if (!ownsView(event, "main")) return;
    const result = overlayStateSchema.safeParse(state);
    if (!result.success) return;
    overlayState = result.data;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channels.overlayState, overlayState);
  });
  ipcMain.on(channels.overlayAction, (event, action: unknown) => {
    if (!ownsView(event, "overlay")) return;
    const result = overlayActions.safeParse(action);
    if (!result.success) return;
    if (result.data === "show-main") showMain();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channels.overlayAction, result.data);
  });
}

async function start() {
  desktopSession = session.fromPartition("aural-interview", { cache: false });
  configureSession(desktopSession);
  Menu.setApplicationMenu(null);
  registerIpc();
  const { window, load } = createWindow("main", {
    title: "面试助手",
    width: 1240,
    height: 820,
    minWidth: 780,
    minHeight: 620,
    backgroundColor: "#f8fafc",
  });
  mainWindow = window;
  window.on("closed", () => {
    mainWindow = null;
    overlayState = null;
    void stopCapture();
    capture = null;
    closeOverlay();
  });
  await load();
  if (!window.isDestroyed()) window.show();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMain);
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(start).catch(() => {
    console.error("无法启动面试助手。");
    app.exit(1);
  });
}
