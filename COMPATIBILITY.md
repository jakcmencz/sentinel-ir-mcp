# Compatibility: what was measured

Measured for `sentinel-ir-mcp` 0.2.2/0.2.3 in October 2026. "Works" means the
listed check was observed, nothing more. No AI agent called the tools inside a
client app: that needs a signed-in account, which was not used.

## Client apps (Linux desktop VM, Ubuntu 22.04, no account signed in)

| Client | Version | Install path tested | Observed |
|---|---|---|---|
| VS Code | 1.143.0 | `setup --client vscode` printed `code --add-mcp ...` | "MCP: List Servers": *Running*, *Discovered 3 tools* (about 0.9 s from start) |
| VS Code | 1.143.0 | `vscode:mcp/install?...` link from this README | install prompt, workspace install, *Running*, *Discovered 3 tools*; `${workspaceFolder}` was expanded to the project path |
| Claude Code | 2.1.308 | printed `claude mcp add ...` | `claude mcp list`: *✔ Connected* |
| Cursor | 3.26.16 | `cursor://...` link from this README | *Install MCP server?* prompt with the expected entry; Cursor log: *Successfully connected to stdio server*; the server received the expanded project path |
| Cursor | 3.26.16 | `setup --client cursor` (project `.cursor/mcp.json`) | file written; the tool list in the app is behind the sign-in screen, **not checked** |
| Windsurf | 3.10.67 (Devin Desktop) | `setup --client windsurf` (0.2.2, old path) | the app called `~/.codeium/windsurf/mcp_config.json` the *old location* and offered to copy it to `~/.config/devin/mcp_config.json`; 0.2.3 writes the new location. Server list is behind sign-in, **not checked** |
| Claude Desktop | – | – | **not tested**: no Linux build; only its config file was tested on Windows (below) |

`doctor` passed for each client. It starts its own copy of the server, so it
does not prove that the app itself connected.

## Windows (GitLab hosted runner, Windows Server 2022, no client apps)

Node 20.20.2, 22.23.4, 24.22.1 (job `windows_compat`, e.g. pipeline
https://gitlab.com/jakubrojicek11/sentinel-ir-mcp/-/pipelines/2977052614):

- The full test suite: 55 passed, 1 skipped (the `chmod 000` test; Windows has
  no such permission bits).

- `setup` + `doctor` from the packed package for Claude Desktop
  (`%APPDATA%\Claude\claude_desktop_config.json`), Cursor and Windsurf, with a
  space in the project path: written, second run unchanged, `doctor` passes
  (handshake, three tools, one analysis).
- Starting `npx -y sentinel-ir-mcp@0.2 <folder>`:
  - `spawn("npx")` without a shell, as a simple client would: **failed**
    (`ENOENT`) on all three Node versions;
  - MCP SDK client (uses `cross-spawn`) with `command: "npx"`: connected on
    Node 20 and 22, timed out once on Node 24;
  - MCP SDK client with `command: "cmd"`, `args: ["/c", "npx", ...]`:
    connected on all three. This is what `setup` writes on Windows since 0.2.3.
- The commands `setup` prints for VS Code and Claude Code, pasted into
  PowerShell 5.1, PowerShell 7.4 and cmd.exe, reach a `.cmd` shim (like
  `code.cmd`/`claude.cmd`) with exactly the intended arguments, for a path with
  a space and for paths with `' $ & ^ % ! ( ) ; @` and a backtick (`< > | "`
  cannot be in Windows file names). Checked on every pipeline by
  `scripts/win-quote-probe.js`; for VS Code the received value is compared
  after JSON parsing, as VS Code reads it. Without escaping, `&` in the path
  broke the VS Code command in all three shells and `%OS%` in the path was
  replaced by `Windows_NT` in the Claude Code command (measured during 0.2.3
  development). So `setup` writes `& ^ % !` in the VS Code JSON as `\u0026`
  etc., and for a path with `%` it prints `claude mcp add-json` with the same
  escaping (checked on Linux that Claude Code 2.1.308 stores the decoded path).
- A `%` in the project path has a second, separate limit that quoting cannot
  fix: npm itself exits with `npm error URI malformed` when `npx` is started
  with such a folder as its working directory. Measured on Linux: npm 10.8.2
  (Node 20) and 10.8.3 fail, npm 10.9.9 (Node 22) works; the same folder passed
  as an argument from another working directory works. Measured on the
  Windows runner (pipeline 2977276529, `cmd /c npx`): npm 10.8.2 (Node 20.20.2)
  fails, npm 10.9.9 (Node 22.23.4) and 11.19.1 (Node 24.22.1) work; the
  `INFO npm …` line of each Windows job repeats it. Which working directory each
  client uses for the server was not measured, so `setup` prints a note for
  paths with `%`.
- Not tested on Windows: the real VS Code, Claude Code, Cursor, Windsurf and
  Claude Desktop apps.

## macOS (Devin macOS VM, no account signed in)

Measured once on 2026-10-22 on macOS 26.6.2 (build 25G83), arm64 (Apple M4 Pro,
virtual machine), branch commit `d6119a5`. Not in CI: GitLab's hosted macOS
runners need a paid plan.

- `npm test`: 56/56 on Node 20.20.2, 22.23.4 and 24.22.1.
- `scripts/compat-smoke.js`: all steps pass on all three (real
  `~/Library/Application Support/Claude`, `~/.cursor`, `~/.config/devin`).
  `npx` inside a folder with `%`: fails on npm 10.8.2 (Node 20), works on
  10.9.9 and 11.19.1.
- Apps (the configs start the published server, serverInfo 0.2.2):

| App | Version | Configured by | Result |
|---|---|---|---|
| VS Code | 1.143.0 | printed `code --add-mcp` in zsh, folders `my project` and `it's $HOME & 100% (x)` | Running, log `Discovered 3 tools`, stored path exact for both |
| Claude Code | 2.1.308 | printed `claude mcp add` in zsh, same two folders | `claude mcp list` / `get`: `✔ Connected`, exact path |
| Cursor | 3.27.6 | README deeplink (user `~/.cursor/mcp.json`) | log `tools=3, status=connected`; UI behind login |
| Cursor | 3.27.6 | `setup --yes` (project `.cursor/mcp.json`) | entry detected but stayed `disconnected` (`enabledTotal 0`); cause not verified (settings UI is behind login) |
| Devin Desktop (Windsurf) | 3.10.67 | `setup --yes` → `~/.config/devin/mcp_config.json` | the bundled `devin mcp get sentinel-ir` CLI reads the entry; app stops at sign-in |
| Claude Desktop | 3.6556.1 | `setup --yes` | stops at sign-in; no server started, `mcp.log` empty |

- Legacy Windsurf migration: the new file got both servers, the old file kept
  the same SHA-256; `doctor --client windsurf` ok.
- Not verified on macOS: any tool call by an agent, Cursor / Devin Desktop /
  Claude Desktop MCP state in their UI, Intel Macs, other macOS versions.
