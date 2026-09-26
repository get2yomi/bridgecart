import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, manifestSource] = await Promise.all([
  readFile("dist/server/index.js", "utf8"),
  readFile("dist/.openai/hosting.json", "utf8")
]);

const manifest = JSON.parse(manifestSource);
assert.equal(typeof manifest.project_id, "string");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const worker = await import(moduleUrl);
assert.equal(typeof worker.default?.fetch, "function");

const response = await worker.default.fetch(new Request("https://naijabridge.test/"));
assert.equal(response.status, 200);
assert.match(await response.text(), /NaijaBridge/);

console.log("Artifact is valid and serves the NaijaBridge site.");
