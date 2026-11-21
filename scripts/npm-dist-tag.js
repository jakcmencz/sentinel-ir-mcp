// npm runs the OIDC exchange itself only for `npm publish`. For the dist-tag,
// exchange GitLab's NPM_ID_TOKEN for a short-lived token of this package (the
// trusted publisher allows dist-tag) and set the tag through the registry API,
// as `npm dist-tag add` does. The token is kept in memory: never printed, never
// written to a file.
// Usage: node scripts/npm-dist-tag.js <version> <tag>
const name = require("../package.json").name;
const REGISTRY = "https://registry.npmjs.org";

(async () => {
    const [version, tag] = process.argv.slice(2);
    if (!version || !tag) throw new Error("usage: node scripts/npm-dist-tag.js <version> <tag>");
    if (!process.env.NPM_ID_TOKEN) throw new Error("NPM_ID_TOKEN is not set (id_tokens in .gitlab-ci.yml)");
    const res = await fetch(`${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`,
        { method: "POST", headers: { authorization: `Bearer ${process.env.NPM_ID_TOKEN}` }, signal: AbortSignal.timeout(30000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.token !== "string") {
        throw new Error(`npm OIDC token exchange failed: HTTP ${res.status} ${body.message || body.error || ""}`.trim());
    }
    const put = await fetch(`${REGISTRY}/-/package/${encodeURIComponent(name)}/dist-tags/${encodeURIComponent(tag)}`,
        { method: "PUT", headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
            body: JSON.stringify(version), signal: AbortSignal.timeout(30000) });
    if (!put.ok) throw new Error(`npm dist-tag ${tag} -> ${version} failed: HTTP ${put.status} ${(await put.text().catch(() => "")).slice(0, 200)}`.trim());
    console.log(`+${tag}: ${name}@${version}`);
})().catch(e => { console.error(e.message); process.exit(1); });
