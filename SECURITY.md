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

## Release integrity

Releases are published only from GitLab CI on a protected `v*` tag, through
npm trusted publishing (GitLab OIDC) with
[provenance](https://docs.npmjs.com/generating-provenance-statements); no npm
token is stored. Check a release with `npm audit signatures`. GitHub is a
read-only mirror.
