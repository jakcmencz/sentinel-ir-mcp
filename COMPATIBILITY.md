# Compatibility: what was measured

Measured for `sentinel-ir-mcp` 0.2.2/0.2.3 and the published 0.3.0 in
October/November 2026. "Works" means the listed check was observed, nothing
more. An AI agent called the tools in two client apps: Cursor (free Hobby
account) with 0.2.3 and 0.3.0, and VS Code with GitHub Copilot Free with 0.3.0,
see [0.3.0](#030-python) and
[Signed-in clients](#signed-in-clients-linux-desktop-vm).

## 0.3.0 (Python)

0.3.0 changes what is analyzed (`.py`, `.pyi`; skips `__pycache__`, `venv`,
`site-packages`) and the version `setup` writes (`sentinel-ir-mcp@0.3`). How
clients start the server is unchanged.

Before release: the test suite on Linux (60/60) and in the Windows CI jobs
(59 passed, 1 skipped), and a packed-tarball install on Linux (Node 20, 22, 24).

After release, measured once on 2026-11-01 with the published 0.3.0 on the
Linux desktop VM (Ubuntu 22.04, Node 24.19.0, npm 10.8.3), a fresh npx cache
and a project outside any `node_modules`. In every app the server process it
started loaded `sentinel-ir-mcp` 0.3.0 and `sentinel-ir` 0.3.0 (checked in the
spawned process's `package.json`). Project: `py/app.py` (FastAPI route +
`pickle.loads`), `run.py` (`subprocess` via an alias), `a.ts`, later
`py/types.pyi`, and dangerous Python files inside `py/__pycache__`, `venv`,
`.venv` and `site-packages`.

| Client | Version | Account | Configured with | Observed |
|---|---|---|---|---|
| Cursor | 3.26.16 | Hobby (free) | `setup --client cursor --yes` (project `.cursor/mcp.json`, `@0.3`) | first *Disabled* / *Local Disconnected*; after turning on its switch in Cursor Settings → Customize → MCPs: *Connected*, 3 tools |
| Cursor | 3.26.16 | Hobby (free) | same | the Agent called `analyze_directory`: `py/app.py` python `critical` with `unsafe_deserialization` and route `POST /x`, `run.py` python `critical`, `a.ts` typescript `low`; complete 3, incomplete 0; nothing from the skipped folders. A second call on `py` returned `py/types.pyi` as python `low` |
| VS Code + GitHub Copilot Chat 0.71.0 | 1.143.0 | Copilot Free | printed `code --add-mcp` command | *Running*, *Discovered 3 tools*. The Agent (model selection *Auto*) called `analyze_directory` with `{"path":"/home/ubuntu/sir030-proj","recursive":true}`: the same four files and risks as above, `analyzed: 4`, complete 4, incomplete 0, nothing from the skipped folders. No tool confirmation prompt appeared |
| Claude Code | 2.1.308 | none | printed `claude mcp add` command | `claude mcp list` / `get`: `✔ Connected`, args `-y sentinel-ir-mcp@0.3 <folder>` |

`doctor --client cursor` with the new entry: exit 0, handshake with 0.3.0,
three tools. With the same entry changed to `sentinel-ir-mcp@0.2` it warns
*This entry stays on an older version without Python support* (still exit 0).

Not measured for 0.3.0: Windows and macOS apps, Devin Desktop (Windsurf),
Claude Desktop, an agent call in Claude Code.

## Client apps (Linux desktop VM, Ubuntu 22.04, no account signed in)

| Client | Version | Install path tested | Observed |
|---|---|---|---|
| VS Code | 1.143.0 | `setup --client vscode` printed `code --add-mcp ...` | "MCP: List Servers": *Running*, *Discovered 3 tools* (about 0.9 s from start) |
| VS Code | 1.143.0 | `vscode:mcp/install?...` link from this README | install prompt, workspace install, *Running*, *Discovered 3 tools*; `${workspaceFolder}` was expanded to the project path |
| Claude Code | 2.1.308 | printed `claude mcp add ...` | `claude mcp list`: *✔ Connected* |
| Cursor | 3.26.16 | `cursor://...` link from this README | *Install MCP server?* prompt with the expected entry; Cursor log: *Successfully connected to stdio server*; the server received the expanded project path |
| Cursor | 3.26.16 | `setup --client cursor` (project `.cursor/mcp.json`) | file written; the tool list in the app is behind the sign-in screen; checked later with an account, see [Signed-in clients](#signed-in-clients-linux-desktop-vm) |
| Windsurf | 3.10.67 (Devin Desktop) | `setup --client windsurf` (0.2.2, old path) | the app called `~/.codeium/windsurf/mcp_config.json` the *old location* and offered to copy it to `~/.config/devin/mcp_config.json`; 0.2.3 writes the new location. Server list is behind sign-in, **not checked** |
| Claude Desktop | – | – | **not tested**: no Linux build; only its config file was tested on Windows (below) |

`doctor` passed for each client. It starts its own copy of the server, so it
does not prove that the app itself connected.

## Signed-in clients (Linux desktop VM)

Measured once in October 2026 on the same VM with the published 0.2.3,
Node 24.19.0. Project: `src/run.js` (calls `child_process.exec`),
`src/broken.ts` (syntax error), `src/ok.ts`.

| Client | Version | Account | Observed |
|---|---|---|---|
| Cursor | 3.26.16 | Hobby (free) | `setup --client cursor --yes` entry (project `.cursor/mcp.json`, no user-level `~/.cursor/mcp.json`): first *Disabled*, its project source switch off, *Local Disconnected*. After turning the switch on in Cursor Settings → Customize → MCPs: *Connected*, 3 tools (`analyze_code`, `analyze_file`, `analyze_directory`), no other approval prompt. The server got the expanded project path; log: *Successfully connected to stdio server* |
| Cursor | 3.26.16 | Hobby (free) | Agent mode, prompt asking to use `analyze_directory`: the agent called it with `{"path":"/home/ubuntu/mcp-live","max_files":500,"recursive":true}`; the result had `src/run.js` `critical`, `incomplete: ["src/broken.ts"]`, `statusCounts` `{complete: 2, incomplete: 1}`. No plan limit and no tool confirmation prompt appeared |
| VS Code + GitHub Copilot Free | 1.143.0 | – | **not tested**: sign-in by GitHub device code did not finish (VS Code stopped waiting after about 150 s: *Failed to sign in to GitHub*) |

The `disconnected` project entries on Windows and macOS (below) were measured
without an account; their cause was not re-checked there. On Linux the cause
was the switch.

Two things seen while setting up, both outside the package:

- Cursor started from the desktop menu did not have Node from `nvm` on its
  `PATH` and showed *Error · spawn npx ENOENT*; started with Node on `PATH`, it
  worked. Clients need `npx` on the `PATH` they are started with.
- `npx -y sentinel-ir-mcp@0.2` first ran a 0.2.2 that npx had cached earlier,
  although 0.2.3 was published. Reproduced with npm 10.8.2, 10.8.3 and 10.9.9;
  `--prefer-online` and `npm cache clean --force` did not change it, deleting
  npm's `_npx` cache folder did. See README, *Getting a newer 0.2.x*.

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
  PowerShell 5.1, PowerShell 7.4 and cmd.exe, reach the program with exactly
  the intended arguments: `code.cmd` for VS Code; for Claude Code both npm's
  `claude.ps1` + `claude.cmd` pair (PowerShell picks the `.ps1`) and a
  `claude.exe` like the native installer's. This holds for a path with
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
- A path containing `%NAME%` where `NAME` is a set environment variable (for
  example `%OS%`) could be expanded by `cmd /c` when a client starts the
  server. Measured once on the Devin Windows VM with the MCP SDK client
  (`cross-spawn`): folder `a %OS% b` was passed unchanged (`ok:true`,
  `run.js:critical`). How each desktop app spawns the command was not
  measured. `compat-smoke` repeats this in the `INFO cmd /c npx, folder
  argument contains %OS%` line.

### Windows client apps (Devin Windows VM, no account signed in)

Measured once on 2026-10-22 on Windows Server 2022 (build 10.0.20348.5622),
AMD64, Windows PowerShell 5.1, Node 22.23.4 / npm 10.9.9. Folders: A =
`C:\sentinel-test\my project`, B = `C:\sentinel-test\it's $HOME & 100% ^caret! (x)`.

| App | Version | Configured with | Result |
| --- | --- | --- | --- |
| VS Code | 1.143.0 | printed command, PowerShell 5.1 (A, B) and cmd.exe (B) | *Running*, *Discovered 3 tools*; B stored unchanged |
| Claude Code | 2.1.308 | printed cmd.exe command (A, B) | `claude mcp list`: `√ Connected`; B stored unchanged |
| Claude Code | 2.1.308 | printed PowerShell command (A, B), commit `d6119a5` | **failed**: `claude` resolved to `%APPDATA%\npm\claude.ps1`; PowerShell drops an unquoted `--` and ignores `--%` for a script (`unknown option '-y'`, `unknown option '--%'`) |
| Claude Code | 2.1.308 | printed PowerShell command `... '--' cmd /c npx ... '<folder>'`, commit `4e84797`: A and B in PowerShell 5.1, B in PowerShell 7.6.7 | `claude mcp list` / `get`: `√ Connected`; stored path equals the real path (case-sensitive) |
| Claude Code (native `claude.exe`, official `install.ps1`) | 2.1.308 | same PowerShell line, B in PowerShell 5.1, commit `a946a24` | `√ Connected`; stored path equals the real path |
| Cursor | 3.26.16 | README deeplink (user `~/.cursor/mcp.json`) | log: *Successfully connected to stdio server*, `tools=3` |
| Cursor | 3.26.16 | `setup --client cursor --yes` (project `.cursor/mcp.json`) | entry listed but **disconnected**, server not started; cause not visible without signing in (same on macOS) |
| Devin Desktop (Windsurf) | 3.10.67 | `setup --client windsurf --yes` | `%APPDATA%\devin\mcp_config.json` written, legacy copy works; app stops at sign-in, server start not observed |
| Claude Desktop | 3.1623.4 | `setup --client claude-desktop --yes` | config written; app stops at sign-in, no MCP log |

On the same VM at commit `a946a24` (PowerShell 7.6.7 installed):
`scripts/win-quote-probe.js` 45/45 OK (PowerShell 5.1, PowerShell 7.6.7 and
cmd.exe × `code.cmd`, npm `claude.ps1`/`claude.cmd`, `claude.exe` × five
folders); `compat-smoke` 12 PASS, 0 FAIL, real config files byte-identical
afterwards (SHA-256).

Not measured on Windows: tool calls from an app's agent, the native
`claude.exe` with folder A or from cmd.exe, folder A in PowerShell 7, the VS Code deeplink,
arm64. The VS Code, Cursor, Devin and Claude Desktop rows are from commit
`d6119a5`; their config output did not change afterwards.

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
