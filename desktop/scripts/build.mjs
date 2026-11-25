import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const fromDesktop = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url));
const renderer = "src/renderer";

async function copyDependencyLicenses() {
  const licenses = await Promise.all(["ws", "zod"].map(async (name) => {
    const license = await readFile(fromDesktop(`node_modules/${name}/LICENSE`), "utf8");
    return `${name}\n\n${license}`;
  }));
  await writeFile(fromDesktop("build/THIRD-PARTY-LICENSES.txt"), licenses.join("\n\n"));
}

await mkdir(fromDesktop("build/renderer"), { recursive: true });
await Promise.all([
  process.platform === "win32" ? import("../native/build.mjs") : undefined,
  build({
    absWorkingDir: desktop,
    entryPoints: { main: "src/main/index.ts", preload: "src/main/preload.ts" },
    outdir: "build",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    alias: { zod: fromDesktop("node_modules/zod/index.js") },
    external: ["electron"],
    tsconfigRaw: { compilerOptions: { paths: { "@/*": ["../src/*"] }, baseUrl: "." } },
    nodePaths: [fromDesktop("node_modules")],
  }),
  build({
    absWorkingDir: desktop,
    entryPoints: [`${renderer}/app.ts`],
    outfile: "build/renderer/app.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    tsconfigRaw: { compilerOptions: { paths: { "@/*": ["../src/*"] }, baseUrl: "." } },
    nodePaths: [fromDesktop("node_modules")],
  }),
  copyFile(fromDesktop("../LICENSE"), fromDesktop("build/LICENSE")),
  copyFile(fromDesktop("../src/app/favicon.ico"), fromDesktop("build/icon.ico")),
  copyDependencyLicenses(),
  ...["index.html", "style.css", "mic-worklet.js"].map((name) =>
    copyFile(fromDesktop(`${renderer}/${name}`), fromDesktop(`build/renderer/${name}`)),
  ),
]);
