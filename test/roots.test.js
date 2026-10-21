"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("url");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { ListRootsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { createServer } = require("../src/server");
const { makeFixture, connectStdio, call } = require("./helpers");

async function connectWithRoots(getRoots, serverOptions = {}) {
    const server = createServer(serverOptions);
    const client = new Client({ name: "roots-test", version: "0.0.0" }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: getRoots() }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, close: async () => { await client.close(); await server.close(); } };
}

test("without folder arguments the server uses the client's MCP roots", async () => {
    const fx = makeFixture();
    let roots = [{ uri: pathToFileURL(fx.project).href, name: "project" }];
    const c = await connectWithRoots(() => roots);
    try {
        assert.equal((await call(c.client, "analyze_file", { path: "server.js" })).isError, undefined);
        assert.match((await call(c.client, "analyze_file", { path: "../outside/private.js" })).text, /Access denied/);

        roots = [{ uri: pathToFileURL(fx.outside).href }];
        const r = await call(c.client, "analyze_file", { path: "private.js" });
        assert.equal(r.isError, undefined, "roots are re-read on every call");
        assert.match((await call(c.client, "analyze_file", { path: "../project/server.js" })).text, /Access denied/);
    } finally {
        await c.close();
        fx.cleanup();
    }
});

test("folder arguments take precedence over client roots", async () => {
    const fx = makeFixture();
    const c = await connectWithRoots(() => [{ uri: pathToFileURL(fx.outside).href }], { roots: [fx.project] });
    try {
        assert.equal((await call(c.client, "analyze_file", { path: "server.js" })).isError, undefined);
        assert.match((await call(c.client, "analyze_file", { path: `${fx.outside}/private.js` })).text, /Access denied/);
    } finally {
        await c.close();
        fx.cleanup();
    }
});

test("non-file roots are ignored", async () => {
    const c = await connectWithRoots(() => [{ uri: "https://example.com/repo" }]);
    try {
        assert.match((await call(c.client, "analyze_file", { path: "x.js" })).text, /No allowed folders/);
    } finally {
        await c.close();
    }
});

test("with no folders and no client roots only analyze_code works", async () => {
    const client = await connectStdio([]);
    try {
        const file = await call(client, "analyze_file", { path: "package.json" });
        assert.equal(file.isError, true);
        assert.match(file.text, /No allowed folders/);
        assert.match((await call(client, "analyze_directory", {})).text, /No allowed folders/);
        assert.equal((await call(client, "analyze_code", { code: "module.exports = 1" })).isError, undefined);
    } finally {
        await client.close();
    }
});
