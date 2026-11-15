// npm runs the OIDC exchange itself only for `npm publish`. For `npm dist-tag`
// exchange GitLab's NPM_ID_TOKEN for a short-lived token of this package (the
// trusted publisher allows dist-tag) and write it to .npmrc. The token is
// never printed.
const fs = require("node:fs");
const name = require("../package.json").name;

(async () => {
    if (!process.env.NPM_ID_TOKEN) throw new Error("NPM_ID_TOKEN is not set (id_tokens in .gitlab-ci.yml)");
    const res = await fetch(`https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`,
        { method: "POST", headers: { authorization: `Bearer ${process.env.NPM_ID_TOKEN}` }, signal: AbortSignal.timeout(30000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.token !== "string") {
        throw new Error(`npm OIDC token exchange failed: HTTP ${res.status} ${body.message || body.error || ""}`.trim());
    }
    fs.writeFileSync(".npmrc", `//registry.npmjs.org/:_authToken=${body.token}\n`, { mode: 0o600 });
    console.log(`npm token for ${name} written to .npmrc`);
})().catch(e => { console.error(e.message); process.exit(1); });
