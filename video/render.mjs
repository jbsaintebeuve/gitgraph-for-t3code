#!/usr/bin/env node
// Renders promo.html frame by frame with headless Chromium, then encodes with ffmpeg.
// Usage: node video/render.mjs [--fps 30] [--out video/gitgraph-promo.mp4] [--still 12.5]
//        node video/render.mjs --webp assets/demo.webp [--fps 20] [--width 1280]   (looping README demo)
// Requires `playwright-core` (resolved from PLAYWRIGHT_CORE or node_modules), plus ffmpeg (MP4) or img2webp (WebP) on PATH.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const fps = Number(args.fps ?? (args.webp ? 20 : 30));
const scale = Number(args.width ?? 1920) / 1920;
const out = resolve(args.out ?? join(here, "gitgraph-promo.mp4"));

const require = createRequire(process.env.PLAYWRIGHT_CORE ? join(process.env.PLAYWRIGHT_CORE, "x.js") : import.meta.url);
const { chromium } = require("playwright-core");

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
await page.goto(pathToFileURL(join(here, "promo.html")).href);
await page.evaluate(() => window.ready);
const duration = await page.evaluate(() => window.DURATION);
const stage = page.locator("#stage");

if (args.still !== undefined) {
  await page.evaluate((t) => window.seek(t), Number(args.still));
  await stage.screenshot({ path: out });
  await browser.close();
  console.log(`still ${args.still}s → ${out}`);
  process.exit(0);
}

if (args.webp !== undefined) {
  // Frames come straight from the browser (no video codec noise), so unchanged areas stay byte-identical
  // and are skipped between frames. Lossy q85 keeps text sharp at about 3 MB for 30 s.
  const dir = await mkdtemp(join(tmpdir(), "gitgraph-frames-"));
  const total = Math.round(duration * fps);
  for (let f = 0; f < total; f++) {
    await page.evaluate((t) => window.seek(t), f / fps);
    await writeFile(join(dir, `${String(f).padStart(5, "0")}.png`), await stage.screenshot({ type: "png" }));
  }
  await browser.close();
  const frames = (await readdir(dir)).sort().map((name) => join(dir, name));
  const webp = resolve(args.webp);
  execFileSync("img2webp", ["-loop", "0", "-d", String(Math.round(1000 / fps)), "-lossy", "-q", "85", "-m", "4", ...frames, "-o", webp], { stdio: "inherit" });
  await rm(dir, { recursive: true });
  console.log(`${total} frames → ${webp}`);
  process.exit(0);
}

const ffmpeg = spawn("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
], { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((ok, fail) => ffmpeg.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`)))));

const total = Math.round(duration * fps);
for (let f = 0; f < total; f++) {
  await page.evaluate((t) => window.seek(t), f / fps);
  const png = await stage.screenshot({ type: "png" });
  if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
  if (f % fps === 0) process.stdout.write(`\r${Math.round((f / total) * 100)}%`);
}
ffmpeg.stdin.end();
await done;
await browser.close();
console.log(`\r${total} frames → ${out}`);
