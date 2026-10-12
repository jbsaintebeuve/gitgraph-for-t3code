#!/usr/bin/env node
import { existsSync } from "node:fs";

const entry = new URL("../dist/node/server/cli.js", import.meta.url);
if (!existsSync(entry)) {
  console.error("gitgraph: build output not found (dist/).\nRun `npm install` (builds automatically) or `npm run build` in the gitgraph-for-t3code directory.");
  process.exit(1);
}
await import(entry.href);
