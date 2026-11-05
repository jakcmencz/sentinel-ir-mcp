# Sentinel-IR-MCP

MCP server for [`sentinel-ir`](https://www.npmjs.com/package/sentinel-ir):
it lets AI agents in Claude Desktop, Cursor, Windsurf or any other
[Model Context Protocol](https://modelcontextprotocol.io) client read a
compact **structural IR** of JavaScript, TypeScript and Python files instead of the raw source.

- npm: <https://www.npmjs.com/package/sentinel-ir-mcp>
- GitLab: <https://gitlab.com/jakubrojicek11/sentinel-ir-mcp>
- Library behind it: <https://gitlab.com/jakubrojicek11/sentinel-ir>

The IR tells the agent what a file *does* (risk level, dangerous
capabilities such as `eval` or `child_process`, routes, exports, imports,
environment reads, network / filesystem / process / crypto calls) in a few
hundred characters. The agent can triage a folder first and then read the raw
source only of the files that matter.

**Supported:** JavaScript (`.js`, `.mjs`, `.cjs`), TypeScript (`.ts`, `.mts`,
`.cts`, `.tsx`; since 0.2.0) and Python (`.py`, `.pyi`; since 0.3.0). The
language is picked from the file extension; `analyze_code` also takes `target`
or an explicit `language` (`javascript` | `typescript` | `tsx` | `python`). Every result carries `language` and
`analysisStatus`; a file that does not parse cleanly (including JSX in a `.ts`
file) is `"incomplete"`, and a low risk on an incomplete result is not evidence
of safety. Other languages are not supported yet. What is detected in Python
(and what is not) is listed in the
[sentinel-ir README](https://gitlab.com/jakubrojicek11/sentinel-ir#python).

**0.4.1** uses `sentinel-ir` 0.4.3:

- **Faster on large JavaScript:** a valid 1 MiB file takes about 5 s instead
  of about 170 s, so `analyze_directory` no longer runs past the 60 s request
  timeout of MCP SDK clients on one big file.
- **Read-time check:** files are opened first and then checked, so a file
  swapped for a symlink between listing and reading is refused instead of read
  from outside the allowed folders. A file removed during a scan no longer
  fails the whole scan; it is listed in `skipped.unreadable`.
- **Finite limits:** `--max-file-bytes` is capped at 4 MiB. Measured on Linux
  with `sentinel-ir` 0.4.3: 4 MiB of JavaScript takes about 30 s and 3 GB of
  memory, 8 MiB aborts the process.
- **Time budget:** `analyze_directory` starts no new file after 40 s
  (`--time-budget-ms`). Then `timedOut` is `true` and the remaining files are
  listed in `notAnalyzed`. A file already being analyzed is not interrupted.
- **Parser errors:** incomplete files carry `facts.parseError` with the line,
  column and kind of the first parser error (from `sentinel-ir` 0.4.3).

**0.4.0** uses `sentinel-ir` 0.4.2:

- **Native code:** `ctypes` / `cffi`, `process.dlopen`, `*.node` addons and
  FFI packages (`koffi`, `ffi-napi`, `bun:ffi`, ...) are `critical`, with
  `native_code` in `forbidden` and `nativeCode` in `facts.operations`.
- **Long sessions:** older versions never freed the WebAssembly parser
  memory. After roughly 87 MB of analyzed source in one server process every
  later result became `"incomplete"` (text fallback) without an error. With
  `sentinel-ir-mcp` 0.3.0 + `sentinel-ir` 0.3.1 over stdio, `analyze_code` on
  an 18 KB file went `incomplete` from call 4,918 on; 0.4.0 stays `complete`
  (measurement below).

## Tools

| tool | input | returns |
|---|---|---|
| `analyze_code` | `code` (string), optional `target` (file name) | compact IR of the given source |
| `analyze_file` | `path` | compact IR of one file inside the allowed folders |
| `analyze_directory` | optional `path`, `max_files` (default 50, max 500), `recursive` (default `true`) | one IR summary per file, sorted from highest to lowest risk, plus `riskCounts`, `statusCounts` and `incomplete` (paths whose analysis did not finish; check them separately, their low risk is not evidence of safety); files that could not be read are listed in `skipped.unreadable` and are not counted as analyzed, `truncated` and `skipped` |

Every tool returns the result twice: as JSON text (for clients that only read
text) and as `structuredContent`. All three are annotated
`readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`.

Example `analyze_file` result for a three-line file that calls `eval` and
`child_process` (real output, wrapped for reading):

```json
{"analysisStatus":"complete",
 "mission":{"target":"danger.js","objective":"general_optimization"},
 "world":{"pressure":0.5,"confidence":0.75,"budget":0.015,"risk":"critical"},
 "constraints":["preserve_api","avoid_breaking_changes"],
 "forbidden":["eval","child_process","process_spawn"],
 "summary":{"size":93,"lines":3,"hasCrypto":false,"hasFilesystem":false,"hasNetwork":false},
 "facts":{"ast":true,"exports":["default"],"imports":["child_process"],
  "operations":["dynamicEval","processSpawn","childProcess"],
  "calls":{"process":["cp.exec","require(child_process)"],"dynamic":["eval"]},
  "dangerous":["eval","child_process","process_spawn"],
  "riskSignals":["child_process_import:require(child_process)@1","dynamic_code:eval@2","process_spawn:cp.exec@2"]}}
```

Rely on `world.risk`, `forbidden` and `facts`. `mission.objective` is a coarse
hint from `sentinel-ir` and can stay `general_optimization` even for risky
files, as above.

## Setup

Requires Node.js 20 or newer. `npx` downloads and runs the server; there is
nothing to compile (the parser is WebAssembly).

### Quick setup (since 0.2.2)

Run it in your project folder:

```bash
npx -y sentinel-ir-mcp@0.4 setup --client cursor     # or windsurf, claude-desktop, vscode, claude-code
npx -y sentinel-ir-mcp@0.4 doctor --client cursor    # after restarting the client
npx -y sentinel-ir-mcp@0.4 guide                     # optional: text for AGENTS.md / client rules
```

`setup` (without `--client` it asks which client):

- shows the change first and writes only after you confirm (or with `--yes`);
  `--dry-run` shows the change and writes nothing;
- adds or replaces only the `"sentinel-ir"` entry; other servers and other
  fields in the file stay as they are, and running it again changes nothing;
- copies the old file to `<file>.bak-<timestamp>` before writing and writes
  through a temporary file plus rename; a file with invalid JSON is never
  touched;
- gives the agent one folder (`--project`, default: the current folder) and
  refuses your home folder or a whole disk;
- writes `sentinel-ir-mcp@0.4`, so clients get 0.4.x fixes but no unexpected
  new features;
- for VS Code and Claude Code it writes nothing and prints their own install
  command (`code --add-mcp ...`, `claude mcp add ...`) instead.

| `--client` | file written by `setup` |
|---|---|
| `cursor` | `<project>/.cursor/mcp.json` with `${workspaceFolder}`; `--global`: `~/.cursor/mcp.json` with the absolute path |
| `windsurf` | `~/.config/devin/mcp_config.json` (or `$XDG_CONFIG_HOME/devin/`), Windows `%APPDATA%\devin\mcp_config.json`. Servers from an older `~/.codeium/windsurf/mcp_config.json` are copied over; that file stays unchanged |
| `claude-desktop` | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`; elsewhere pass `--config <file>` |
| `vscode`, `claude-code` | nothing; prints the command to run |

On Windows the entry is `"command": "cmd", "args": ["/c", "npx", "-y",
"sentinel-ir-mcp@0.4", "<folder>"]`: there `npx` is `npx.cmd`, and starting it
without a shell failed with `ENOENT` on a real Windows runner. For VS Code and
Claude Code, `setup` prints a PowerShell and a Command Prompt version of the
command. What was measured on which system: [COMPATIBILITY.md](COMPATIBILITY.md).

`doctor` checks Node.js, the package version, the client config (valid JSON, a
`"sentinel-ir"` entry that starts `sentinel-ir-mcp`, existing folders), then
starts **its own** server with the same folders, performs a real MCP
handshake, expects exactly the three tools and calls `analyze_directory` with
`max_files: 1`. It never runs the command stored in the client config. Exit
code 0 when everything passes, 1 otherwise; `--json` gives a machine-readable
report.

Only `setup` writes files, and only the client config. The MCP server itself
stays read-only.

**Cursor:** a server from a project `.cursor/mcp.json` starts switched off.
Open Cursor Settings → Customize → MCPs and turn on the switch next to
`sentinel-ir` (its source is the project's `.cursor/mcp.json`). It then shows
*Connected* and 3 tools. A server installed with the link below (user-level
`~/.cursor/mcp.json`) connected without this step.

### Getting a newer 0.2.x

`npx` keeps the package it downloaded for `sentinel-ir-mcp@0.2` and keeps
starting that copy, even when a newer 0.2.x is on npm (measured with npm
10.8.2, 10.8.3 and 10.9.9: a cached 0.2.2 kept running after 0.2.3 was
released; `--prefer-online` and `npm cache clean --force` did not change it).
To get the newest 0.2.x:

1. Check what runs: `npx -y sentinel-ir-mcp@0.2 doctor` prints
   `sentinel-ir-mcp <version>`.
2. Close the client app and delete the `_npx` folder in npm's cache
   (`npm config get cache` shows where it is; usually `~/.npm/_npx`, on
   Windows `%LocalAppData%\npm-cache\_npx`). This removes all packages cached
   by `npx`, not only this one; they are downloaded again when needed.
3. Start the client again. The next start downloads the newest 0.2.x.

A folder that is literally named `setup`, `doctor` or `guide` must now be
passed as `./setup` (or an absolute path); the bare word is the command.

### Upgrading from 0.3.x or older

Configs written by older versions pin `sentinel-ir-mcp@0.3` (or `@0.2`) and
keep running that line. 0.3.x has no native-code detection, and its parser
stops working in long sessions (see 0.4.0 below); 0.2.x also has no Python
support. Run `setup` again for your client (it replaces only the
`"sentinel-ir"` entry); `doctor` warns about an entry that still pins 0.3 or
older. If the client still starts an old version, see
[Getting a newer version](#getting-a-newer-version).

### One-click install links

These links follow the Cursor and VS Code documentation. They were opened in
VS Code 1.143 and Cursor 3.26 (see [COMPATIBILITY.md](COMPATIBILITY.md)). A link cannot know your
project path, so it uses `${workspaceFolder}`; if your client does not expand
it, use `setup` instead.

- Cursor: [Install in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=sentinel-ir&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNlbnRpbmVsLWlyLW1jcEAwLjMiLCIke3dvcmtzcGFjZUZvbGRlcn0iXX0=)
- VS Code: [Install in VS Code](vscode:mcp/install?%7B%22name%22%3A%22sentinel-ir%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22sentinel-ir-mcp%400.3%22%2C%22%24%7BworkspaceFolder%7D%22%5D%7D)

Some sites (including GitLab and npm) may not open `cursor://` or `vscode:`
links; copy the link into the browser address bar or use `setup`.

### Manual setup

Pass the folder(s) the agent may read as arguments. Use absolute paths.

#### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "sentinel-ir": {
      "command": "npx",
      "args": ["-y", "sentinel-ir-mcp@0.4", "/Users/you/projects/my-app"]
    }
  }
}
```

Restart Claude Desktop afterwards.

#### Cursor

Project `.cursor/mcp.json` (or `~/.cursor/mcp.json` for all projects).
`${workspaceFolder}` is the folder that contains `.cursor/mcp.json`. A
project entry has to be switched on once in Cursor Settings → Customize → MCPs:

```json
{
  "mcpServers": {
    "sentinel-ir": {
      "command": "npx",
      "args": ["-y", "sentinel-ir-mcp@0.4", "${workspaceFolder}"]
    }
  }
}
```

#### Windsurf

Windsurf 3 (Devin Desktop) reads `~/.config/devin/mcp_config.json`
(Windows: `%APPDATA%\devin\mcp_config.json`); older versions read
`~/.codeium/windsurf/mcp_config.json`. Add the same entry as for Claude Desktop
with your project's absolute path.

#### Other clients

Any MCP client that starts stdio servers works with
`command: "npx"`, `args: ["-y", "sentinel-ir-mcp@0.4", "<folder>"]`
(on Windows: `command: "cmd"`, `args: ["/c", "npx", "-y", "sentinel-ir-mcp@0.4", "<folder>"]`).
Without folder arguments the server uses the client's
[MCP roots](https://modelcontextprotocol.io/specification/latest/client/roots)
if the client offers them; if it offers none, only `analyze_code` works.

### Options

```text
sentinel-ir-mcp [--max-file-bytes <n>] [--max-files <n>] [--time-budget-ms <n>] [folder ...]

  --max-file-bytes <n>   largest file to analyze (default 1048576 = 1 MiB, max 4194304 = 4 MiB)
  --time-budget-ms <n>   analyze_directory starts no new file after this (default 40000, max 600000)
  --max-files <n>        default file limit for analyze_directory (default 50, max 500)
```

## What the server can and cannot do

- **Reads only.** The MCP server never writes files, runs commands or opens
  network connections (only the separate `setup` command writes, and only the
  client config file you confirm; `doctor` starts this package's own server). The only files it opens are `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts`/`.tsx`/`.py`/`.pyi` files up to
  `--max-file-bytes`.
- **Only inside the allowed folders.** Every path is resolved to its real path
  (symlinks followed) and must lie inside a folder given on the command line,
  or, without folder arguments, inside one of the client's MCP roots. `../`,
  absolute paths elsewhere and symlinks pointing outside are refused.
- **`analyze_directory`** skips `node_modules`, `.git`, hidden folders and
  every symlink, and stops after `max_files` files (`truncated: true`) or
  when the time budget is spent (`timedOut: true`, rest in `notAnalyzed`).
  Each file is checked again when it is opened: it must still be a regular
  file inside the allowed folders.
- **The IR is still untrusted text.** Comments, string bodies and function
  bodies are not copied into it, so instructions hidden there do not reach the
  agent through the IR. It does contain identifiers and some literals from the
  code (route paths, module names, export names, env variable names). That
  *reduces* the prompt-injection surface; it does not remove it.
- **It is not a security scanner.** The risk level comes from a fixed set of
  AST patterns in `sentinel-ir`; code that hides its behaviour (e.g. building
  a module name at runtime) can look harmless.

## Measurements

The library's own published sources (`sentinel-ir@0.1.3`), read through
`analyze_file` / `analyze_directory` over stdio. Tokens counted with
`gpt-tokenizer@4.0.4` (`o200k_base` encoding); other models' tokenizers give
different numbers.

| file | raw chars | raw tokens | IR chars | IR tokens |
|---|---:|---:|---:|---:|
| `src/ast-facts.js` | 39,877 | 8,439 | 450 | 120 |
| `src/sentinel-ir.js` | 9,123 | 2,084 | 515 | 133 |
| `src/tree-parser.js` | 4,393 | 891 | 465 | 121 |
| `examples/basic.js` | 600 | 150 | 461 | 120 |
| all 4 via `analyze_directory` | | 11,564 | | 317 |

The IR has a floor of roughly 120 tokens per file, so it does not pay off for
very small files. `analyze_file` on `src/ast-facts.js` took about 160 ms per
call (average of 10, Node 24, Linux cloud VM); the first call also loads the
WebAssembly parser.

Long session (one server process over stdio, 6,000 `analyze_code` calls on
the same 17.8 KB JavaScript file, about 107 MB in total, Node 24):

| version | calls with a different `analysisStatus` than the first | first such call |
|---|---:|---:|
| 0.3.0 + `sentinel-ir` 0.3.1 | 1,083 | 4,918 |
| 0.4.0 + `sentinel-ir` 0.4.2 | 0 | — |

## Dependencies

Three runtime dependencies: the official
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk),
`zod` (its schema peer dependency) and `sentinel-ir`. With their own
dependencies that is about 100 packages in `node_modules`; `npm audit`
reported 0 vulnerabilities at release time (0.4.0: after updating
`body-parser` to 2.4.0 in the lock file). Unlike `sentinel-ir` itself,
this package is not dependency-free.

## Development

```sh
npm ci
npm test        # starts the real server over stdio and talks to it with the MCP SDK client
```

Tests cover the tool list and annotations, all three tools, refusals for
`../`, absolute paths, symlinks out of the folder, unsupported file types and
size limits, MCP roots from the client, and the command-line options.
`setup`/`doctor` tests run against temporary `HOME`/`APPDATA` folders: new
file, keeping other servers and fields, backup, idempotent second run, invalid
JSON left untouched, `--dry-run`, refused home/root folders, symlinked config,
Claude Desktop/Windsurf macOS/Windows paths (simulated), a real MCP
handshake, failing configs and old Node.js.

A second CI job runs on a real Windows runner (Node 20/22/24): the full test
suite, the packed package with `setup`/`doctor` against the real `%APPDATA%`,
starting the published package through `npx`, and the printed VS Code/Claude
Code commands pasted into PowerShell 5.1, PowerShell 7 and cmd.exe. See
[COMPATIBILITY.md](COMPATIBILITY.md).

Release: bump `version` in `package.json`, push a protected tag `vX.Y.Z`;
GitLab CI tests and publishes to npm with provenance.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
