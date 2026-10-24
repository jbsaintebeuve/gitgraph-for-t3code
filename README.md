<img src="assets/icon.svg" width="64" height="64" alt="">

# gitGraph for T3Code

[![CI](https://github.com/jbsaintebeuve/gitgraph-for-t3code/actions/workflows/ci.yml/badge.svg)](https://github.com/jbsaintebeuve/gitgraph-for-t3code/actions/workflows/ci.yml)
[![T3 Code compatibility](https://github.com/jbsaintebeuve/gitgraph-for-t3code/actions/workflows/t3-compat.yml/badge.svg)](https://github.com/jbsaintebeuve/gitgraph-for-t3code/actions/workflows/t3-compat.yml)
[![Secret scan](https://github.com/jbsaintebeuve/gitgraph-for-t3code/actions/workflows/secrets.yml/badge.svg)](https://github.com/jbsaintebeuve/gitgraph-for-t3code/actions/workflows/secrets.yml)

Browse your branches, inspect diffs and compare two commits in the Preview panel of [T3 Code](https://t3.codes).

<img src="assets/demo.webp" width="100%" alt="Animated demo: the commit graph draws itself; clicking a commit opens its changed files and diff; Cmd-click compares two commits; a new merge commit appears live; the Git Graph action opens the graph in T3 Code's Preview; gitgraph init and gitgraph run in a terminal.">

`gitgraph` is a companion app. Its Node.js server runs on your machine and does not depend on T3 Code updates. It works on macOS and Ubuntu, with **Node.js ≥ 20** and **Git**. Git ≥ 2.34 is recommended.

## Installation

With Node.js and Git installed:

```sh
git clone https://github.com/jbsaintebeuve/gitgraph-for-t3code.git ~/code/gitgraph-for-t3code
cd ~/code/gitgraph-for-t3code
npm install
npm link
```

`npm install` builds the app. `npm link` puts the `gitgraph` and `gitgraph-mcp` commands on your `PATH`.

<details>
<summary>Install Node.js and Git on macOS or Ubuntu</summary>

### Prerequisites on macOS

```sh
brew install node git            # or nvm
```

### Prerequisites on Ubuntu

Node ≥ 20 is not in the Ubuntu 22.04 repositories. You can install Node.js with **nvm**, without `sudo`.

```sh
sudo apt install -y git curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash   # check the version on the nvm website
# reopen the terminal
nvm install 22
```

With nvm, the global npm prefix is in your `$HOME`, so `npm link` works without `sudo`. With a system Node, do
**not** run `sudo npm link`. Set a user prefix instead:

```sh
npm config set prefix ~/.local
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
npm link
```

Check with `gitgraph --version`, then `gitgraph doctor`.

</details>

## Getting started

In the repository you want to explore:

```sh
cd /path/to/repo
gitgraph init
gitgraph
```

`gitgraph init` adds the **Git Graph** action to `t3.json`. `gitgraph` starts the server. Open [http://127.0.0.1:4777](http://127.0.0.1:4777) in a browser to see the graph, or import the action into T3 Code with the steps below. Keep the process running while you use it.

## Open the graph in T3 Code

1. Run `gitgraph init` in the project (or add the script by hand, see below).
2. Import the script into T3, once per project (T3 does not enable `t3.json` automatically). In the current version, scripts are called **actions**:
   - **Settings → Projects →** the project → **Import scripts** button → **"Import from t3.json"** menu → **Git Graph**;
   - or, at the top of a thread in the project, the **+ (Add action)** button menu → **"From t3.json"** section → **Git Graph**.

   These entries only appear if `t3.json` is at the root of the project folder open in T3, is valid, and contains scripts that are not imported yet.
3. Run **Git Graph**: the graph opens in the Preview panel (`autoOpenPreview`).

A **single shared server** listens on `127.0.0.1:4777` for all projects. A second `gitgraph` started from another
project registers its repository with the running server, then waits to take over if that server stops. The
repository picker in the toolbar switches between projects.

<details>
<summary>t3.json script written by gitgraph init</summary>

```json
{
  "name": "Git Graph",
  "command": "gitgraph --repo .",
  "icon": "debug",
  "previewUrl": "http://127.0.0.1:4777",
  "autoOpenPreview": true
}
```

</details>

### Global configuration (all projects)

`gitgraph init --global-snippet` prints the entry to paste under `defaultProjectScripts` in T3's settings
(exact schema, precedence and limits: [docs/t3-settings.md](docs/t3-settings.md), in French). Notes:

- Only the T3 **desktop build** honours `previewUrl`.
- A project that already has its own scripts does not inherit the default scripts.
- This repository never modifies T3's settings: you edit them by hand. The file is `~/.t3/userdata/settings.json` on this Mac (nightly). On Ubuntu, it depends on the installation; check it.
- The schema changes between T3 nightlies: check again if it stops working.

## Features

- Commit graph (branches, merges, tags, stashes, remote branches), with configurable order and "first parent" mode.
- Commit details: changed files, diff.
- Comparison of two commits (Cmd/Ctrl + click).
- Commit search.
- Git actions on commits, branches, tags, stashes and uncommitted changes (context menu), and fetch.
- Live refresh (server-sent events) when the repository changes.
- T3's internal checkpoints (`refs/t3/**`) are excluded from the graph.

## Commands

- `gitgraph` starts the server for the current repository on `http://127.0.0.1:4777`.
- `gitgraph --repo /path/to/repo` opens another repository.
- `gitgraph --port 4888` picks another port. The `GITGRAPH_PORT` variable also sets the default port.
- `gitgraph init` adds the **Git Graph** script to `t3.json`, or merges it into the existing file. You can run it again safely.
- `gitgraph init --global-snippet` prints the configuration to copy into T3's default scripts.
- `gitgraph doctor` checks the local installation and exits with code 1 if a check fails.
- `gitgraph compat --online` checks the installed T3 bundle and its public schema. Add `--json` for structured output.
- `gitgraph --version` prints the version. `gitgraph help` prints the help.

## Keyboard shortcuts

- **Cmd/Ctrl + F** opens search.
- **Enter**, then **Shift + Enter**, moves to the next or previous search result.
- **Up / Down arrow** selects the previous or next commit.
- **Enter** opens the selected commit.
- **Cmd/Ctrl + click** compares a commit with the selected one.
- **Escape** closes the menu, the dialog or the search.

## Security

- Listens on the loopback interface only (`127.0.0.1`).
- Checks the `Host` and `Origin` headers (protection against DNS rebinding and CSRF).
- A session token is injected into the page and stored in `~/.config/gitgraph-t3/instance.json` (mode `0600`, folder `0700`; `$XDG_CONFIG_HOME` is respected).
- git runs without a shell (arguments passed as an array).

## MCP integration

The optional `gitgraph-mcp` server gives agents access to the graph, diffs and Git actions over stdio. It works without starting the web server. See the [MCP setup guide](docs/mcp.md) (in French) to add it to your agent.

## Troubleshooting

Start with `gitgraph doctor`.

- **Port in use**: another service uses 4777. Change it with `--port` / `GITGRAPH_PORT` (and use the same port in `previewUrl`). If it is another `gitgraph`, this is expected: the repository is registered with it.
- **The Preview does not open**: check that the script was imported, that `previewUrl` and `autoOpenPreview` are present, that T3 is the **desktop** build, and that `gitgraph` is on the `PATH` of T3's terminal (`which gitgraph`).
- **`gitgraph: command not found` on Ubuntu**: the npm prefix is not on the `PATH` (see installation), or open a new terminal.
- **Linux, slow refresh or inotify error**: the working tree is polled every 2 s (by design on Linux). If `ENOSPC` appears, raise the limit: `sudo sysctl fs.inotify.max_user_watches=524288` (persistent through `/etc/sysctl.d/`).
- **Missing `dist`**: run `npm install` or `npm run build`.
- **T3 nightly changed**: run `gitgraph compat --online`. This command reads the installed T3 Code bundle (`app.asar`, read-only) and the public `t3.json` schema, then checks that `previewUrl` and `autoOpenPreview` are still supported. On startup, `gitgraph` also prints a warning if it detects an incompatibility. Until a fix lands, open `http://127.0.0.1:4777` by hand in the Preview or a browser. To adapt the tool, follow [AGENTS.md](AGENTS.md). See also [docs/t3-settings.md](docs/t3-settings.md).
- **T3 bundle not found** (common on Ubuntu with the AppImage, which is only mounted while T3 runs): run the check with T3 open, or give the path with `GITGRAPH_T3_ASAR=/path/to/app.asar`.

## Development

```sh
npm run dev:server   # API on :4777, restarts on every change
npm run dev:web      # UI on :5173 (hot reload), proxied to the API
npm run typecheck
npm test
npm run build
npm run pack:check   # package contents: bin + dist only
scripts/test-linux.sh   # Ubuntu 22.04 and 24.04 in Docker
```

The README demo (`assets/demo.webp`) and the promo video are generated from [`video/promo.html`](video/promo.html): `node video/render.mjs --webp assets/demo.webp` or `node video/render.mjs` for the MP4. Rendering needs `playwright-core`, plus `img2webp` or `ffmpeg`.

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build and a smoke test on Ubuntu 22.04/24.04 and macOS, with Node 20 and 22.

The T3 compatibility workflow (`.github/workflows/t3-compat.yml`) runs daily and fails if T3 Code's public schema no longer declares `previewUrl` or `autoOpenPreview`. The update procedure, for humans and agents alike, is described in [AGENTS.md](AGENTS.md).

The [Secret scan](.github/workflows/secrets.yml) workflow runs Gitleaks on every push and pull request. `.gitignore` excludes `.env` files, `.npmrc` and common private key formats.

## License and credits

[MIT](LICENSE) © 2026 Jean-Baptiste Sainte-Beuve. The graph layout algorithm is an original implementation,
inspired by Pierre Vigier's article on drawing git graphs. No code from mhutchie's vscode-git-graph extension is
used (its license forbids redistributing derivative works).
