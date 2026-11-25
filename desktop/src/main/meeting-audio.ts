import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { release } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import type { MeetingApp } from "./bridge-types";

const execute = promisify(execFile);
const startTimeout = 7_000;
const stopTimeout = 3_000;
// 200 ms at 16 kHz, mono, signed 16-bit little-endian PCM.
const pcmFrameBytes = 6_400;
const nativeEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
};
const nativeApp = z.object({
  pid: z.number().int().positive().max(0xFFFFFFFF),
  startedAt: z.string().regex(/^\d{1,20}$/),
  title: z.string().max(2_048),
  appName: z.string().max(2_048),
});
type NativeApp = z.infer<typeof nativeApp>;
export type MeetingTarget = Pick<NativeApp, "pid" | "startedAt">;

export type MeetingCapture = {
  ready: Promise<void>;
  closed: Promise<{ unexpected: boolean }>;
  stop(): void;
  terminate(): void;
};

class MeetingAudioError extends Error {}

function requireWindows() {
  const build = Number(release().split(".")[2]);
  if (process.platform !== "win32" || (Number.isFinite(build) && build < 20348)) {
    throw new MeetingAudioError("当前系统不支持按应用采集音频。请使用 Windows 11 或支持此功能的 Windows 版本。");
  }
}

function displayLabel(value: string) {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ").trim().slice(0, 200);
}

function openCapture(executable: string, target: MeetingTarget, accept: (chunk: Uint8Array) => void): MeetingCapture {
  const child = spawn(executable, ["capture", String(target.pid), target.startedAt], {
    windowsHide: true,
    env: nativeEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveClosed!: (outcome: { unexpected: boolean }) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<{ unexpected: boolean }>((resolve) => { resolveClosed = resolve; });
  let running = false;
  let stopping = false;
  let ended = false;
  let discard = false;
  let errors = "";
  let bufferedBytes = 0;
  const frame = Buffer.alloc(pcmFrameBytes);
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const startupTimer = setTimeout(fail, startTimeout);
  startupTimer.unref();

  function fail() {
    if (ended || discard) return;
    discard = true;
    clearTimeout(startupTimer);
    if (!running) rejectReady(new MeetingAudioError("无法启动会议音频。请刷新应用列表、确认所选应用仍在运行后再试。"));
    child.stdout.resume();
    child.kill();
  }

  child.stdout.on("data", (chunk: Buffer) => {
    if (!running || discard) return;
    for (let offset = 0; offset < chunk.length;) {
      const length = Math.min(frame.length - bufferedBytes, chunk.length - offset);
      chunk.copy(frame, bufferedBytes, offset, offset + length);
      offset += length;
      bufferedBytes += length;
      if (bufferedBytes === frame.length) {
        accept(Buffer.from(frame));
        bufferedBytes = 0;
      }
    }
  });
  // Stdout and stderr are independent. Hold the first bytes until the helper
  // has acknowledged the selected capture target.
  child.stdout.pause();
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (discard) return;
    errors += chunk;
    if (errors.length > 4_096) {
      fail();
      return;
    }
    for (let newline = errors.indexOf("\n"); newline !== -1; newline = errors.indexOf("\n")) {
      const line = errors.slice(0, newline).replace(/\r$/u, "");
      errors = errors.slice(newline + 1);
      if (line === "READY" && !running && !stopping) {
        running = true;
        clearTimeout(startupTimer);
        child.stdout.resume();
        resolveReady();
      } else if (line.startsWith("ERROR")) {
        fail();
      }
    }
  });
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  child.on("error", fail);
  child.once("close", (code) => {
    ended = true;
    clearTimeout(startupTimer);
    clearTimeout(stopTimer);
    if (!running) {
      rejectReady(new MeetingAudioError("会议音频未能启动。请刷新应用列表后再试。"));
    } else {
      const tail = bufferedBytes - (bufferedBytes % 2);
      if (tail && !discard && code === 0) accept(Buffer.from(frame.subarray(0, tail)));
    }
    resolveClosed({ unexpected: !stopping || code !== 0 });
  });

  return {
    ready,
    closed,
    stop() {
      if (ended || stopping) return;
      stopping = true;
      clearTimeout(startupTimer);
      child.stdin.end();
      if (!running) child.stdout.resume();
      stopTimer = setTimeout(fail, stopTimeout);
      stopTimer.unref();
    },
    terminate() {
      if (ended) return;
      stopping = true;
      fail();
    },
  };
}

export function createMeetingAudio(executable: string) {
  let targets = new Map<string, MeetingTarget>();
  let listing: Promise<MeetingApp[]> | undefined;

  async function refresh() {
    requireWindows();
    let values: unknown;
    try {
      const { stdout } = await execute(executable, ["list"], {
        windowsHide: true,
        env: nativeEnvironment,
        encoding: "utf8",
        timeout: 4_000,
        maxBuffer: 512 * 1024,
      });
      values = JSON.parse(stdout.replace(/^\uFEFF/u, ""));
    } catch {
      throw new MeetingAudioError("无法读取会议应用列表。请确认正在使用包含会议采集组件的 Windows 版本。");
    }
    if (!Array.isArray(values) || values.length > 512) throw new MeetingAudioError("会议应用列表格式无效。");

    const known = new Map(Array.from(targets, ([id, target]) => [`${target.pid}:${target.startedAt}`, id]));
    const seen = new Set<string>();
    const result: MeetingApp[] = [];
    const updated = new Map<string, MeetingTarget>();
    for (const value of values) {
      const parsed = nativeApp.safeParse(value);
      if (!parsed.success || parsed.data.pid === process.pid) continue;
      const { pid, startedAt, title, appName } = parsed.data;
      const identity = `${pid}:${startedAt}`;
      if (seen.has(identity)) continue;
      const label = displayLabel(title);
      const name = displayLabel(appName);
      if (!label || !name) continue;
      seen.add(identity);
      const id = known.get(identity) ?? randomUUID();
      updated.set(id, { pid, startedAt });
      result.push({ id, name, title: label });
    }
    targets = updated;
    return result;
  }

  return {
    list() {
      listing ??= refresh().finally(() => { listing = undefined; });
      return listing;
    },
    target(id: string): MeetingTarget {
      requireWindows();
      const target = targets.get(id);
      if (!target) throw new MeetingAudioError("请刷新会议应用列表，然后选择仍在运行的应用。");
      return target;
    },
    start(target: MeetingTarget, accept: (chunk: Uint8Array) => void) {
      requireWindows();
      try {
        return openCapture(executable, target, accept);
      } catch {
        throw new MeetingAudioError("无法启动会议音频采集。请重新打开面试助手后再试。");
      }
    },
  };
}
