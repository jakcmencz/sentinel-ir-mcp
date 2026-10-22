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

Node 20.20.2, 22.23.4, 24.22.1:

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
  a space and for a path with `'`, `$` and `&`. Checked on every pipeline by
  `scripts/win-quote-probe.js`. Exception: for VS Code, a path containing
  `& | < > ^ % !` was changed by cmd.exe inside the JSON in every shell, so
  for such paths `setup` prints the VS Code install link instead of a command.
- Not tested on Windows: the real VS Code, Claude Code, Cursor, Windsurf and
  Claude Desktop apps.

## macOS

Not tested. GitLab's hosted macOS runners need a paid plan. The macOS config
paths are covered only by tests with a simulated home folder.
