# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

- email **sentinel.ir.contact@gmail.com** with the subject `SECURITY: sentinel-ir-mcp`, or
- open a [confidential issue](https://gitlab.com/jakubrojicek11/sentinel-ir-mcp/-/issues/new?issue[confidential]=true) on GitLab.

Include the version, your operating system and Node.js version, and the
smallest input or steps that show the problem. I aim to reply within 7 days.
A fix is released as a new patch version; you are credited in the release
notes unless you ask not to be.

## What counts

Anything that lets an MCP client read outside the allowed folders (traversal, symlinks, hardlinks, UNC or `file://` paths), makes the server execute the analyzed code, write inside the project, reach the network, or crash or hang the server.

A finding that the analyzer misses (a false negative) or over-reports is a
normal bug unless it can be used to make an agent trust unsafe code; report it
privately if unsure.

## Supported versions

Only the newest release of the current minor line (the npm `latest` tag)
gets fixes.

## Known limits

sentinel-ir-mcp reads code and never runs it. That makes it safe to point at
untrusted code, and it also sets limits no release can remove. They are normal
behavior, not vulnerabilities:

- **A checked file can change afterwards (TOCTOU).** `analyze_file` and
  `analyze_directory` return the `sha256` of the exact bytes analyzed. The
  hash does not lock the file: compare it right before running or relying on
  the file, and analyze again if it differs.
- **Code that exists only at run time is not visible.** Code that is
  downloaded, decoded or assembled while the program runs is not in the file.
  The answer names the mechanism (`dynamic_code`, `dynamic_import`,
  `dynamic_reference`) and raises the risk, but cannot say what that code does.
- **`low` is not proof of safety.** It means no known risky pattern was found
  in that file. One file at a time: capabilities split across files are not
  combined.
- **Answers contain text chosen by the file's author.** Names of exports,
  imports, env variables and paths are copied as data. Names that look like
  instructions to an agent are flagged `suspicious_text`, but the agent must
  treat every answer as untrusted data, never as instructions.
- **Not every file is analyzed.** Files over `--max-file-bytes` (default
  1 MiB), unreadable files, symlinks, hard links and excluded paths are refused
  or listed under `skipped`, and `incomplete` files may miss facts. A folder
  result covers only the files it lists as analyzed.

## Release integrity

Releases are published only from GitLab CI on a protected `v*` tag, through
npm trusted publishing (GitLab OIDC) with
[provenance](https://docs.npmjs.com/generating-provenance-statements); no npm
token is stored. GitHub is a read-only mirror.

15 minutes after each publish, the `verify_release` job of the tag pipeline
installs the new version in an empty folder and requires `npm audit
signatures` to pass on npm 10 and on npm 11. The result for every release is
on the [tag pipelines](https://gitlab.com/jakubrojicek11/sentinel-ir-mcp/-/pipelines?scope=tags).

Check a version yourself (npm 9.5 or newer):

```sh
mkdir check && cd check && npm init -y
npm install sentinel-ir-mcp@<version>
npm audit signatures
```

Every installed package should have a verified registry signature and
`sentinel-ir-mcp` a verified attestation, with nothing reported missing or invalid. Use 0.5.19 or newer:
on some npm CDN locations an older version lacks npm's publish attestation, so
npm 10 reports it as missing a signature (npm 11 passes).
