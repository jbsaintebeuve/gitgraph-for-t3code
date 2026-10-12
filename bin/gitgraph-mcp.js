#!/usr/bin/env node
// MCP server entry (stdio). stdout is reserved for the MCP protocol: log to stderr only.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { repo: { type: "string" }, help: { type: "boolean", short: "h", default: false } },
  strict: false,
});

if (values.help) {
  console.error("Usage: gitgraph-mcp [--repo <dir>]\n\nMCP server (stdio) exposing the commit graph and git actions. Default repo: current directory.");
  process.exit(0);
}

let mod;
try {
  mod = await import("../dist/node/server/mcp.js");
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("dist/node/server/mcp.js")) {
    console.error("gitgraph-mcp: build output not found. Run `npm run build` in the gitgraph-for-t3code directory first.");
  } else {
    console.error("gitgraph-mcp: failed to load:", error);
  }
  process.exit(1);
}

mod.startMcpServer({ defaultRepo: typeof values.repo === "string" ? values.repo : undefined }).catch((error) => {
  console.error("gitgraph-mcp:", error);
  process.exit(1);
});
