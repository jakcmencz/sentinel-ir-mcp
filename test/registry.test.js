"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const pkg = require("../package.json");
const server = require("../server.json");

// The MCP Registry rejects a description over 100 characters.
test("server.json matches package.json and the MCP Registry limits", () => {
    assert.equal(server.name, pkg.mcpName);
    assert.equal(server.version, pkg.version);
    assert.equal(server.packages[0].version, pkg.version);
    assert.ok(server.description.length <= 100, `${server.description.length} characters`);
});
