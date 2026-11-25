import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("The process audio helper is built on Windows.");

const source = fileURLToPath(new URL(".", import.meta.url));
const output = resolve(source, "../build/native");
const compiler = join(process.env.WINDIR || "C:/Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
await mkdir(output, { recursive: true });
const result = spawnSync(compiler, [
  "/nologo", "/target:exe", "/platform:x64", "/optimize+", "/warnaserror+",
  "/reference:System.Web.Extensions.dll",
  `/out:${join(output, "aural-meeting-audio.exe")}`,
  join(source, "Program.cs"),
  join(source, "Wasapi.cs"),
], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await copyFile(join(source, "LICENSE-Microsoft.txt"), join(output, "LICENSE-Microsoft.txt"));
await copyFile(join(source, "NOTICE.txt"), join(output, "NOTICE.txt"));
