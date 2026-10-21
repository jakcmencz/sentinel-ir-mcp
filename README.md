# Sentinel-IR-MCP

MCP server for [`sentinel-ir`](https://www.npmjs.com/package/sentinel-ir):
it lets AI agents in Claude Desktop, Cursor, Windsurf or any other
[Model Context Protocol](https://modelcontextprotocol.io) client read a
compact **structural IR** of JavaScript and TypeScript files instead of the raw source.

- npm: <https://www.npmjs.com/package/sentinel-ir-mcp>
- GitLab: <https://gitlab.com/jakubrojicek11/sentinel-ir-mcp>
- Library behind it: <https://gitlab.com/jakubrojicek11/sentinel-ir>

The IR tells the agent what a file *does* (risk level, dangerous
capabilities such as `eval` or `child_process`, routes, exports, imports,
environment reads, network / filesystem / process / crypto calls) in a few
hundred characters. The agent can triage a folder first and then read the raw
source only of the files that matter.

**Supported:** JavaScript (`.js`, `.mjs`, `.cjs`) and TypeScript (`.ts`, `.mts`,
`.cts`, `.tsx`; since 0.2.0). The language is picked from the file extension;
`analyze_code` also takes `target` or an explicit `language`
(`javascript` | `typescript` | `tsx`). Every result carries `language` and
`analysisStatus`; a file that does not parse cleanly (including JSX in a `.ts`
file) is `"incomplete"`, and a low risk on an incomplete result is not evidence
of safety. Python and other languages are not supported yet.

## Tools

| tool | input | returns |
|---|---|---|
| `analyze_code` | `code` (string), optional `target` (file name) | compact IR of the given source |
| `analyze_file` | `path` | compact IR of one file inside the allowed folders |
| `analyze_directory` | optional `path`, `max_files` (default 50, max 500), `recursive` (default `true`) | one IR summary per file, sorted from highest to lowest risk, plus `riskCounts`, `truncated` and `skipped` |

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

Pass the folder(s) the agent may read as arguments. Use absolute paths.

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "sentinel-ir": {
      "command": "npx",
      "args": ["-y", "sentinel-ir-mcp", "/Users/you/projects/my-app"]
    }
  }
}
```

Restart Claude Desktop afterwards.

### Cursor

Project `.cursor/mcp.json` (or `~/.cursor/mcp.json` for all projects).
`${workspaceFolder}` is the folder that contains `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sentinel-ir": {
      "command": "npx",
      "args": ["-y", "sentinel-ir-mcp", "${workspaceFolder}"]
    }
  }
}
```

### Windsurf

Cascade panel → `...` → *Open MCP config file* (`mcp_config.json`), then add
the same entry as for Claude Desktop with your project's absolute path.

### Other clients

Any MCP client that starts stdio servers works with
`command: "npx"`, `args: ["-y", "sentinel-ir-mcp", "<folder>"]`.
Without folder arguments the server uses the client's
[MCP roots](https://modelcontextprotocol.io/specification/latest/client/roots)
if the client offers them; if it offers none, only `analyze_code` works.

### Options

```text
sentinel-ir-mcp [--max-file-bytes <n>] [--max-files <n>] [folder ...]

  --max-file-bytes <n>   largest file to analyze (default 1048576 = 1 MiB)
  --max-files <n>        default file limit for analyze_directory (default 50, max 500)
```

## What the server can and cannot do

- **Reads only.** It never writes files, runs commands or opens network
  connections. The only files it opens are `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts`/`.tsx` files up to
  `--max-file-bytes`.
- **Only inside the allowed folders.** Every path is resolved to its real path
  (symlinks followed) and must lie inside a folder given on the command line,
  or, without folder arguments, inside one of the client's MCP roots. `../`,
  absolute paths elsewhere and symlinks pointing outside are refused.
- **`analyze_directory`** skips `node_modules`, `.git`, hidden folders and
  every symlink, and stops after `max_files` files (`truncated: true`).
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

## Dependencies

Three runtime dependencies: the official
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk),
`zod` (its schema peer dependency) and `sentinel-ir`. With their own
dependencies that is about 100 packages in `node_modules`; `npm audit`
reported 0 vulnerabilities at release time. Unlike `sentinel-ir` itself,
this package is not dependency-free.

## Development

```sh
npm ci
npm test        # starts the real server over stdio and talks to it with the MCP SDK client
```

Tests cover the tool list and annotations, all three tools, refusals for
`../`, absolute paths, symlinks out of the folder, unsupported file types and
size limits, MCP roots from the client, and the command-line options.

Release: bump `version` in `package.json`, push a protected tag `vX.Y.Z`;
GitLab CI tests and publishes to npm with provenance.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
