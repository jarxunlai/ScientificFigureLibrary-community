import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const ENTRY_PATH = /^catalog\/entries\/([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?)\/([0-9A-Za-z.+-]+)\.json$/u;
const THUMB_PATH = /^thumbs\/([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?)\/([0-9A-Za-z.+-]+)\.png$/u;
const REVIEW_PATH = /^reviews\/([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?)\/([0-9A-Za-z.+-]+)\.md$/u;
const ALLOWED_MODIFIED = ["catalog/catalog.json", "catalog/preview-manifest.json"];

function fail(message) {
  throw new Error(message);
}

function runGit(repository, args, options = {}) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: options.encoding ?? null,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail(`git ${args.slice(0, 3).join(" ")} failed for trusted tree inspection`);
  }
  return result.stdout;
}

export function validatePortableRepositoryPath(value) {
  if (
    typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") ||
    value.startsWith("/") || /^[A-Za-z]:/u.test(value) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    value.normalize("NFC") !== value || path.posix.normalize(value) !== value
  ) fail(`repository path is not canonical and portable: ${JSON.stringify(value)}`);
  for (const segment of value.split("/")) {
    if (
      !segment || segment === "." || segment === ".." || segment.endsWith(".") ||
      segment.endsWith(" ") || /[<>:"|?*]/u.test(segment) || WINDOWS_RESERVED.test(segment)
    ) fail(`repository path has a non-portable segment: ${value}`);
  }
  return value;
}

export function assertPortableTreeRecords(records, label = "repository tree") {
  const folded = new Map();
  for (const record of records) {
    const treePath = validatePortableRepositoryPath(record.path);
    if (record.mode !== "100644" || record.type !== "blob" || !/^[a-f0-9]{40,64}$/u.test(record.oid)) {
      fail(`${label} contains a non-100644 blob (symlink, gitlink, executable, or special mode): ${treePath}`);
    }
    const key = treePath.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = folded.get(key);
    if (prior && prior !== treePath) fail(`${label} contains a Windows case-fold collision: ${prior} <> ${treePath}`);
    folded.set(key, treePath);
  }
}

function parseLsTree(output, label) {
  const records = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  const buffer = Buffer.from(output);
  while (offset < buffer.byteLength) {
    const nul = buffer.indexOf(0, offset);
    if (nul < 0) fail(`${label} returned an unterminated git tree record`);
    if (nul === offset) {
      offset += 1;
      continue;
    }
    const bytes = buffer.subarray(offset, nul);
    offset = nul + 1;
    const tab = bytes.indexOf(0x09);
    if (tab < 0) fail(`${label} returned a malformed git tree record`);
    let metadata;
    let treePath;
    try {
      metadata = decoder.decode(bytes.subarray(0, tab));
      treePath = decoder.decode(bytes.subarray(tab + 1));
    } catch {
      fail(`${label} contains a non-UTF-8 path`);
    }
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64})$/u.exec(metadata);
    if (!match) fail(`${label} returned malformed mode/type/object metadata`);
    records.push({ mode: match[1], type: match[2], oid: match[3], path: treePath });
  }
  assertPortableTreeRecords(records, label);
  const result = new Map();
  for (const record of records) {
    if (result.has(record.path)) fail(`${label} contains a duplicate path: ${record.path}`);
    result.set(record.path, record);
  }
  return result;
}

export function readGitTree(repository, revision = "HEAD") {
  const root = path.resolve(repository);
  const output = runGit(root, ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "ls-tree", "-r", "-z", "--full-tree", revision]);
  return parseLsTree(output, `${root}@${revision}`);
}

export function compareTreeMaps(base, candidate) {
  const added = [...candidate.keys()].filter((name) => !base.has(name)).sort();
  const deleted = [...base.keys()].filter((name) => !candidate.has(name)).sort();
  const modified = [...base.keys()].filter((name) => {
    const next = candidate.get(name);
    if (!next) return false;
    const prior = base.get(name);
    return prior.mode !== next.mode || prior.type !== next.type || prior.oid !== next.oid;
  }).sort();
  if (deleted.length) fail(`Catalog PR may not delete files: ${deleted.join(", ")}`);

  const entry = added.filter((name) => ENTRY_PATH.test(name));
  const thumb = added.filter((name) => THUMB_PATH.test(name));
  const review = added.filter((name) => REVIEW_PATH.test(name));
  if (entry.length !== 1 || thumb.length !== 1 || review.length !== 1 || added.length !== 3) {
    fail(`Catalog PR must add exactly one entry, one thumbnail, and one review; added=${added.join(", ")}`);
  }
  const entryMatch = ENTRY_PATH.exec(entry[0]);
  const thumbMatch = THUMB_PATH.exec(thumb[0]);
  const reviewMatch = REVIEW_PATH.exec(review[0]);
  if (
    !entryMatch || !thumbMatch || !reviewMatch ||
    entryMatch[1] !== thumbMatch[1] || entryMatch[2] !== thumbMatch[2] ||
    entryMatch[1] !== reviewMatch[1] || entryMatch[2] !== reviewMatch[2]
  ) fail("Catalog entry, thumbnail, and review outer identities do not match exactly");
  if (
    modified.length !== ALLOWED_MODIFIED.length ||
    modified.some((name, index) => name !== ALLOWED_MODIFIED[index])
  ) fail(`Catalog PR may modify only both aggregate files; modified=${modified.join(", ")}`);

  return {
    added,
    deleted,
    modified,
    templateId: entryMatch[1],
    releaseVersion: entryMatch[2],
    entryPath: entry[0],
    thumbPath: thumb[0],
    reviewPath: review[0],
  };
}

export function compareRepositoryTrees(baseRoot, candidateRoot) {
  return compareTreeMaps(readGitTree(baseRoot), readGitTree(candidateRoot));
}

async function main() {
  const [baseArg, candidateArg] = process.argv.slice(2);
  if (!baseArg || !candidateArg) fail("usage: validate-pr-trees.mjs <trusted-base-checkout> <candidate-checkout>");
  const result = compareRepositoryTrees(baseArg, candidateArg);
  console.log(`validated immutable one-release Catalog tree for ${result.templateId}@${result.releaseVersion}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
