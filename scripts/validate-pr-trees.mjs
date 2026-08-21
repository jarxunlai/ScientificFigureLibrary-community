import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const [baseArg, candidateArg] = process.argv.slice(2);
if (!baseArg || !candidateArg) throw new Error("usage: validate-pr-trees.mjs <base> <candidate>");
const baseRoot = path.resolve(baseArg);
const candidateRoot = path.resolve(candidateArg);

async function inventory(root) {
  const output = new Map();
  const walk = async (directory, relativeDirectory = "") => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (!relativeDirectory && entry.name === ".git") continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`repository tree contains a symlink: ${relative}`);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(absolute);
        output.set(relative, `${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`);
      } else throw new Error(`repository tree contains a non-file: ${relative}`);
    }
  };
  await walk(root);
  return output;
}

const [base, candidate] = await Promise.all([inventory(baseRoot), inventory(candidateRoot)]);
const added = [...candidate.keys()].filter((name) => !base.has(name)).sort();
const deleted = [...base.keys()].filter((name) => !candidate.has(name)).sort();
const modified = [...base.keys()].filter((name) => candidate.has(name) && base.get(name) !== candidate.get(name)).sort();
if (deleted.length) throw new Error(`Catalog PR may not delete files: ${deleted.join(", ")}`);
const entry = added.filter((name) => /^catalog\/entries\/[a-z0-9._-]+\/[0-9A-Za-z.+-]+\.json$/u.test(name));
const thumb = added.filter((name) => /^thumbs\/[a-z0-9._-]+\/[0-9A-Za-z.+-]+\.png$/u.test(name));
const review = added.filter((name) => /^reviews\/[a-z0-9._-]+\/[0-9A-Za-z.+-]+\.md$/u.test(name));
if (entry.length !== 1 || thumb.length !== 1 || review.length !== 1 || added.length !== 3) {
  throw new Error(`Catalog PR must add one entry, one thumbnail, and one review only; added=${added.join(", ")}`);
}
const entryMatch = /^catalog\/entries\/([^/]+)\/([^/]+)\.json$/u.exec(entry[0]);
const thumbMatch = /^thumbs\/([^/]+)\/([^/]+)\.png$/u.exec(thumb[0]);
const reviewMatch = /^reviews\/([^/]+)\/([^/]+)\.md$/u.exec(review[0]);
if (!entryMatch || !thumbMatch || !reviewMatch || entryMatch[1] !== thumbMatch[1] || entryMatch[2] !== thumbMatch[2] || entryMatch[1] !== reviewMatch[1] || entryMatch[2] !== reviewMatch[2]) {
  throw new Error("Catalog entry, thumbnail, and review identities do not match");
}
const allowedModified = ["catalog/catalog.json", "catalog/preview-manifest.json"];
if (modified.length !== 2 || modified.some((name, index) => name !== allowedModified[index])) {
  throw new Error(`Catalog PR may modify only aggregate catalog and preview manifest; modified=${modified.join(", ")}`);
}
console.log(`validated one-release Catalog PR shape for ${entryMatch[1]}@${entryMatch[2]}`);
