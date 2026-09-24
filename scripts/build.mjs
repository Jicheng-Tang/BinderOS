import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const html = await readFile(resolve(root, "public/index.html"), "utf8");
const worker = await readFile(resolve(root, "worker/index.js"), "utf8");
const atlas = await readFile(resolve(root, "worker/atlas.js"), "utf8");
const examplePdb = await readFile(resolve(root, "public/examples/1UBQ.pdb"), "utf8");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await mkdir(resolve(dist, ".openai"), { recursive: true });
await writeFile(resolve(dist, "server/index.js"), `const page = ${JSON.stringify(html)};\nconst examplePdb = ${JSON.stringify(examplePdb)};\n${atlas}\n${worker}`);
await copyFile(resolve(root, ".openai/hosting.json"), resolve(dist, ".openai/hosting.json"));
console.log("Built BinderOS Worker artifact");
