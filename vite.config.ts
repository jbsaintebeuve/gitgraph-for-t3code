import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the page is served by Vite, so the server cannot inject its token:
// read it from the instance file and let the proxy attach it to API calls.
function devToken(): string {
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gitgraph-t3");
  try {
    return (JSON.parse(readFileSync(join(dir, "instance.json"), "utf8")) as { token: string }).token;
  } catch {
    return "";
  }
}

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4777",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            req.setHeader("x-gitgraph-token", devToken());
            req.removeHeader("origin");
          });
        },
      },
    },
  },
});
