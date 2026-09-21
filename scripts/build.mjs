import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const html = await readFile(resolve(root, "public/index.html"), "utf8");
const worker = await readFile(resolve(root, "worker/index.js"), "utf8");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await mkdir(resolve(dist, ".openai"), { recursive: true });
await writeFile(resolve(dist, "server/index.js"), `const page = ${JSON.stringify(html)};\n${worker}`);
await copyFile(resolve(root, ".openai/hosting.json"), resolve(dist, ".openai/hosting.json"));
console.log("Built BinderOS Worker artifact");
