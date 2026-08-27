import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const textualExtensions = new Set([
  ".css", ".go", ".html", ".js", ".json", ".md", ".mjs", ".proto", ".ps1", ".tf", ".ts", ".yaml", ".yml",
]);
const ignoredDirectories = new Set([".git", ".terraform", "dist", "node_modules"]);
const ignoredFiles = new Set(["PLAN.md"]);
const prohibited = [
  "YW5jaG9yY2FzdA==",
  "c3RyZWFtIHR2IG1lZGlhIGdtYmg=",
  "cmVjb3JkZXIgbGFicyBnbWJo",
  "cmVlY29yZGVyIGxhYnMgZ21iaA==",
].map((encoded) => Buffer.from(encoded, "base64").toString("utf8"));

const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!entry.isFile() || ignoredFiles.has(entry.name) || !textualExtensions.has(extname(entry.name))) continue;
    const contents = (await readFile(path, "utf8")).toLowerCase();
    for (const phrase of prohibited) {
      if (contents.includes(phrase)) {
        violations.push(`${relative(root, path)} contains prohibited or retired product wording`);
      }
    }
  }
}

await visit(root);
if (violations.length) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Product-facing branding guard passed.\n");
}
