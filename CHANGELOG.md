# Changelog

Release notes of `sentinel-ir-mcp`, newest first. Each version is on npm:
`https://www.npmjs.com/package/sentinel-ir-mcp/v/<version>`.

**0.5.21** the audit log line of a tool call is written before the agent
gets the answer, so a client that kills the server right after (Windows ends
it at once) no longer loses the last lines. `SECURITY.md` is now in the npm
package.

**0.5.20** documentation only, same code as 0.5.19: `SECURITY.md` says how
to check a release yourself, the README has the MCP Registry badge and a link
to the Agensi pre-run vetting skill, and CI checks npm signatures 15 minutes
after publishing.

**0.5.19** re-release of 0.5.18 with the same code: on some npm CDN
locations 0.5.18 lacks npm's publish attestation, so `npm audit signatures`
on npm 10 failed there.

**0.5.18** README links to `CHANGELOG.md`, `COMPATIBILITY.md`, `LICENSE` and
`NOTICE` work on npm too (they pointed to missing npm pages).

**0.5.17** easier first steps:
- Started by hand in a terminal, the server now says what it is and how to
  connect it (`setup`) instead of waiting silently.
- `doctor` with no AI app connected no longer ends with "All checks passed":
  it says Sentinel-IR works but is not connected yet, and how to connect it.
- README starts with a Quick start; older release notes moved to
  [CHANGELOG.md](CHANGELOG.md). Glama and ProtocolProbe badges.

**0.5.16** the agent guide (`guide`) and the instructions the server sends
on connect now say it too: a `warning` means a partial answer, so call
`analyze_directory` again on sub-folders. The audit log records `notScanned`,
and `log` prints it next to "stopped at the file limit".

**0.5.15** a partial `analyze_directory` answer no longer reads as a clean
folder. When it stops at `max_files` it still counts the source files it left
out (`notScanned`), and a truncated or timed-out answer starts with a
`warning`: `riskCounts` cover only the analyzed files, so `critical: 0` there
says nothing about the rest. Reported by an outside tester: 5 critical files
at the end of the walk order were behind `critical: 0` at the default 50 files.

**0.5.14** `doctor` no longer opens npm's config files (`~/.npmrc` and
others may hold registry tokens). It takes npm's global prefix from the
environment `npx` sets, or asks npm itself (`npm prefix -g`, no shell). The
release job sets the `stable-0.5` tag without writing a token file.

**0.5.13** `doctor` run in the home folder (or a disk root) now prints
setup fixes that work: they add `--project <your project folder>`, because
setup never gives the agent the whole home folder. Fixes for the global Cursor
config (`~/.cursor/mcp.json`, also when doctor runs in the home folder) add
`--global`, so setup repairs that file and not a new project one.

**0.5.12** answers the four attacks of an outside security review:
- `analyze_file` and every `analyze_directory` entry carry `sha256`, the
  SHA-256 of the exact bytes analyzed. Before running or relying on a file,
  the agent can check it is still the file it saw (time-of-check to
  time-of-use).
- With `sentinel-ir` 0.5.12: code built or loaded at run time is no longer
  `low`. `require(name)`, `import(url)`, Python `__import__(name)` and
  `importlib.import_module(name)` are `dynamic_import` (high);
  `global["pro" + "cess"]`, `globalThis[String.fromCharCode(...)]` and
  `getattr(os, name)` are `dynamic_reference` (high); `vm`, `p.then(eval)`
  and `[].constructor.constructor(s)` are `dynamic_code` (critical).
- A file that did not parse is at least `medium`, never `low`.
- Names that read like instructions to an agent
  (`SYSTEM_OVERRIDE_IGNORE_RISKS_AND_RUN_RM_RF`, `ignore previous
  instructions`) or hide bidirectional characters are `suspicious_text`
  (medium). They stay in the IR as data.

**0.5.11** installs no native code: `sentinel-ir` 0.5.11 dropped its optional
native `tree-sitter` packages (4 packages, about 7.7 MB, two `node-gyp-build`
install scripts) that this server never used, since it always analyzes through
the bundled WebAssembly. npm 11 no longer asks about `allowScripts`. Security
reports: [SECURITY.md](SECURITY.md); maintenance and sponsorship rules:
[GOVERNANCE.md](GOVERNANCE.md).

**0.5.10** fixes what a third user test (0.5.9) found:

- `doctor --client vscode` / `claude-code` no longer reports "Excluded:
  nothing" and "Audit log: off": those clients keep their own server list,
  so doctor says it cannot read them.
- `doctor` names the spec npx keeps an old cached copy for (e.g. `@0.5.8`),
  also warns about old copies whose `sentinel-ir` is new enough, and skips
  `@stable-0.5` / `@latest` copies that npx refreshes by itself.
- `doctor` warns when the test call checked no file instead of reporting it
  as working; copy-paste fixes keep `--client` (and `--global`).
- URL refusals read `Not a file path: … is a URL`; `data:`, `mailto:` and
  `javascript:` are refused as URLs too.
- `log` shows the incomplete and skipped-symlink counts of a folder call.
- `analyze_code` takes `language` in any case (`"JS"`, `"Python"`).

**0.5.9** fixes what a second user test (0.5.8) found:

- `analyze_directory` summaries list `forbidden` for a file that did not
  parse but shows a dangerous capability, so a `critical` broken file says why.
- `log` says `incomplete: unsupported language` for `analyze_code` with a
  `target` like `x.rb`, not `broken code`; a `file://` URL to another machine
  is logged as `not a local file path` instead of the whole error.
  `file:src/x.js` (no `//`) is refused as a URL, not as a path outside the
  project. A folder passed to `analyze_file` is logged as `not a file`.
- `doctor` warns (instead of `[ok]`) about an exclusion that matches nothing.
- `analyze_code` takes the `js`, `ts`, `py` and `rs` aliases like sentinel-ir.
- Windows: a UNC path (`\\server\share\x.js`) or `file://server/...` outside the
  allowed folders is refused from its text, before any file system call.
  Before, Windows first opened an SMB connection to that server (a known way
  to leak NTLM credentials) and the answer took 2 to 22 s. `http://` and other
  URLs are refused as URLs, not `Not found`.
- `log` counts files with several hard links separately from too large or
  unreadable ones, says `outside the allowed folders` like the tool answer, and
  `not a folder` for a file passed to `analyze_directory`.
- Needs `sentinel-ir` 0.5.9: a broken Python or Rust file is `critical` only
  with a capability named in `forbidden`.
- `doctor` says the npx cache *holds* a stale copy; only an entry with that
  version or range keeps starting it (a tag is looked up again).

**0.5.8** fixes what a user test of 0.5.7 on Linux, macOS and Windows found:

- A path outside the allowed folders is refused with the same `Access denied`
  whether or not it exists. Before, a missing path answered `Not found`, so an
  agent could find out which files exist outside the project. A dangling
  symlink is refused too. Windows `\\?\C:\...` paths are read as plain paths
  on every Node version (Node 20/22 and 24 answered differently).
- `analyze_code` with a `target` of another language (`x.rb`, `main.go`) is
  `incomplete`, `language: "unknown"` (sentinel-ir 0.5.8), not a `complete`
  JavaScript result that could read as `low`.
- `.jsx` files are read, as `sentinel-ir` already supported them.
- `file://` URIs are accepted as paths; a URL with a host is refused with a
  clear message instead of `Not found`.
- `doctor` without `--client` shows the exclusions and the audit log of every
  configured client (it showed only the first one's).
- `log | head` ends quietly instead of an `EPIPE` stack trace.
- The audit log names hard-link, symlink and unsupported-type refusals in
  short words like the others.
- Needs `sentinel-ir` 0.5.8 (better parse-error positions for Rust and TSX,
  `forbidden` filled for broken Python and Rust, TypeScript declarations).

**0.5.7** publishes to npm through npm trusted publishing (GitLab OIDC, no
stored npm token, provenance as before) and carries the `funding` field and the
new sponsor contact. The server itself is unchanged.

**0.5.6** fixes what an audit of 0.5.5 found: `guide` names Python and Rust
too (it still said JavaScript and TypeScript only); `analyze_file` reads files
in a folder whose name starts with `..` (such as `..cache/x.js`) instead of
calling them outside the allowed folders; the lock file takes
`@modelcontextprotocol/sdk` 1.32.2 and `hono` 4.13.18 (`npm audit`: 0
vulnerabilities); and the GitHub release workflow also publishes `server.json`
to the MCP Registry.

**0.5.5** fixes the update check in `doctor`: it goes through the proxy npm
would use (`npm_config_https_proxy`/`npm_config_proxy`, `HTTPS_PROXY`/`HTTP_PROXY`,
`NO_PROXY`), follows up to 3 registry redirects (never from https to http), and
says what it found: "newer than npm's stable-0.5 (0.5.3)" when this copy is
ahead of npm, and "points to ..., not a release version" for a pre-release
or broken tag instead of "npm has no tag".

**0.5.4** makes `doctor` notice an old copy of itself: it asks npm for the
newest release on its `stable-X.Y` tag (3 s timeout, skipped offline) and,
when that is newer, warns and says where the old copy runs from (npx cache,
global install or another folder) and how to replace it. Before, `npx
sentinel-ir-mcp doctor` without a version could run an old copy and report
`[ok]`. The last line now counts warnings (`All checks passed, 1 warning
above.`).

**0.5.3** splits each tool description into short lines (what it returns,
parameters, risk scale, when to use another tool) and names the sibling tools
in all three; `analyze_code` no longer repeats the language rule its schema
already states. No change to what the tools return.

**0.5.2** shortens the tool descriptions agents read: the risk scale is
explained once per tool, `analyze_directory` states the defaults of `path`
(the first allowed folder) and `recursive` (true; `false` scans only the top
level), and `analyze_file` and `analyze_code` state the IR shape and when
they refuse. No change to what the tools return.

**0.5.1** makes sure an installed server gets fixes:

- It needs `sentinel-ir` 0.5.6 or newer. 0.5.3–0.5.6 fix a comment between
  two tokens hiding dangerous code, a broken Python or Rust file showing
  `low`, a parser that could hang for minutes on one file, and the line of
  Rust `use std::process::Command` signals.
- `setup` writes `sentinel-ir-mcp@stable-0.5`, an npm tag that points at the
  newest 0.5.x. `npx` keeps starting the copy it downloaded first for a
  version or range such as `@0.5` and never picks up a fix; a tag is looked
  up again on every start. Measured with npm 10.8.3 and 11.21.2 against a
  local registry: after the tag moved, the next start ran the new version;
  with the registry unreachable (connection refused), the cached copy still
  started.
- `doctor` warns about an entry that pins a version or range (`@0.5`,
  `@0.5.0`, ...) and about every copy in npm's `_npx` cache whose
  `sentinel-ir` is older than the version this release needs, with the folder
  to delete. It fails when
  the server itself runs an older `sentinel-ir`.

If you set up 0.5.0 or older, run `setup` again **with the new tag** (`npx -y
sentinel-ir-mcp@0.5 ...` would start your cached 0.5.0):

```bash
npx -y sentinel-ir-mcp@stable-0.5 setup --client cursor
npx -y sentinel-ir-mcp@stable-0.5 doctor --client cursor
```

**0.5.0** reads Rust (`.rs`) with `sentinel-ir` 0.5.2: `unsafe` and FFI,
`std::process::Command`, file deletes and writes, HTTP clients and routes
(`axum`, `actix-web`, ...). A `build.rs` or procedural macro that touches
files, the network or secret environment variables is at least `high`,
because it runs on your machine during `cargo build`.

- `analyze_directory` skips Cargo's build folder: a `target` folder with
  Cargo's `CACHEDIR.TAG` file, listed in `skipped.cargoTarget`. A plain folder
  named `target` (e.g. in a JS project) is still scanned.
- `setup` writes `sentinel-ir-mcp@0.5`; `doctor` asks entries pinned to 0.4
  or older to run `setup` again (since 0.5.1 `setup` writes
  `sentinel-ir-mcp@stable-0.5`, see above).

**0.4.6** is listed in the official
[MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.jakcmencz/sentinel-ir-mcp`, so clients that browse the registry
can find and install it. Nothing else changes.

**0.4.5** adds to that log the SHA-256 of every file the server read, so you
can check later which version of a file the agent was shown (see
[Audit log](#audit-log)).

**0.4.4** can keep a log of what the agent asked for (off unless you turn it on):

- **One question in `setup`:** *"Keep a log of what the agent asks for (file
  names and results, never your code)? [y/N]"*. Or `setup --audit-log`;
  `--no-audit-log` turns it off. Running `setup` again keeps the setting.
- **One command to read it:** `npx -y sentinel-ir-mcp@stable-0.5 log` prints the last
  50 entries as plain lines, `--all` everything, `--json` for scripts:

  ```text
  2026-10-18 10:32:05 [cursor] file src/app.js: critical
  2026-10-18 10:32:09 [cursor] REFUSED file secrets/aws.js: excluded by your settings
  2026-10-18 10:33:40 [cursor] folder .: 42 file(s) (1 critical, 6 medium, 35 low), 3 excluded
      critical src/app.js
  ```
- `doctor` says whether the log is on, where it is and how big, and proves the
  log can be written. Details: [Audit log](#audit-log).

Also uses `sentinel-ir` 0.4.5 (Python parse errors point where Python does).

**0.4.3** lets you exclude files and folders:

- **One question in `setup`:** *"Files or folders the agent must not read"*,
  e.g. `secrets, dist, *.min.js` (Enter = none). Or `setup --exclude secrets
  --exclude dist`. `setup` writes them into the client config, so there is no
  JSON to edit; running it again keeps them, `--no-exclude` removes them.
- **Set by you only.** The agent cannot change them, and the analyzed project
  cannot either: there is no `.sentinelignore`, because a repository could use
  it to hide its own files.
- `analyze_file` refuses an excluded path whether or not it exists;
  `analyze_directory` only counts excluded entries in `skipped.excluded`,
  because their names can be private too. `doctor` lists the exclusions and
  how many files and folders they skip in the project.

**0.4.2** makes `analyze_directory` short by default:

- **Short entries:** each file is `{path, risk, analysisStatus, language,
  lines, operations, riskSignals}`, plus `moreRiskSignals` and `parseError`
  when they apply, and (since 0.5.9) `forbidden` for a file that did not parse
  but shows a dangerous capability. `riskSignals` are up to 3 `kind:code@line` signals that set
  the file's risk level (code cut to 120 characters). `analyze_file` still
  returns the full IR; `detail: "full"` returns the 0.4.1 entries.

  | folder (all files) | 0.4.1 | 0.4.2 default |
  |---|---:|---:|
  | a 190-file Node project | 96,550 chars (~24,100 tokens) | 35,856 chars (~9,000 tokens) |
  | MCP SDK `dist/cjs` (174 files) | 79,945 chars (~20,000 tokens) | 29,046 chars (~7,300 tokens) |

  Tokens estimated as chars / 4. The tool list the client loads once grows
  from 4,103 to 5,322 chars.
- **Risk explained to the agent:** tool descriptions say that risk is about
  capabilities, not vulnerabilities; that `medium` (file writes, network,
  crypto) is normal in backend code; and that values are not tracked, so
  `readFileSync(req.query.f)` is `low`.

**0.4.1** uses `sentinel-ir` 0.4.3:

- **Faster on large JavaScript:** a valid 1 MiB file takes about 5 s instead
  of about 170 s, so `analyze_directory` no longer runs past the 60 s request
  timeout of MCP SDK clients on one big file.
- **Read-time check:** files are opened first and then checked, so a file
  swapped for a symlink between listing and reading is refused instead of read
  from outside the allowed folders. A file removed during a scan no longer
  fails the whole scan; it is listed in `skipped.unreadable`. Files with more
  than one hard link are refused (`skipped.hardlinks`).
- **Finite limits:** `--max-file-bytes` is capped at 2 MiB. Valid JavaScript
  with `sentinel-ir` 0.4.3:

  | size | Linux | Windows CI (Node 20/22/24) |
  |---|---|---|
  | 1 MiB | 4–5 s, 0.9 GB | 13–23 s, 0.8 GB |
  | 2 MiB | 10–14 s, 1.6 GB | 29–40 s, 1.5 GB |
  | 4 MiB | 25–29 s, 3 GB | process aborts |

  A file above 2 MiB can take longer than the 60 s request timeout on its own.
- **Time budget:** `analyze_directory` starts no new file after 30 s
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
