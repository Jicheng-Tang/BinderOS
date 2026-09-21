import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [source, manifest] = await Promise.all([
  readFile(resolve(root, "dist/server/index.js"), "utf8"),
  readFile(resolve(root, "dist/.openai/hosting.json"), "utf8"),
]);
const parsedManifest = JSON.parse(manifest);
assert.ok(parsedManifest.project_id, "hosting.json must retain project_id");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(typeof workerModule.default?.fetch, "function", "Worker must export default.fetch");
console.log("Artifact is valid ESM and exports default.fetch");
