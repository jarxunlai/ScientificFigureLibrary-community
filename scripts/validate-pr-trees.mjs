import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const ID = "([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?)";
const VERSION = "([0-9A-Za-z.+-]+)";
const ENTRY_PATH = new RegExp(`^catalog/entries/${ID}/${VERSION}\\.json$`, "u");
const THUMB_PATH = new RegExp(`^catalog/thumbs/${ID}/${VERSION}\\.png$`, "u");
const REVIEW_PATH = new RegExp(`^reviews/${ID}/${VERSION}\\.md$`, "u");
const REASON_PATH = new RegExp(`^withdrawals/${ID}/${VERSION}/reason\\.txt$`, "u");

export const V2_ADD_MODIFIED_PATHS = Object.freeze([
  "catalog/catalog.json",
  "catalog/entries.jsonl",
  "catalog/preview-manifest.json",
  "catalog/previews.jsonl",
]);
export const V2_MIGRATION_ADDED_PATHS = Object.freeze([
  "catalog/entries.jsonl",
  "catalog/previews.jsonl",
  "catalog/retired-releases.jsonl",
  "catalog/thumbs/.gitkeep",
  "withdrawals/.gitkeep",
]);
export const V2_MIGRATION_DELETED_PATHS = Object.freeze(["thumbs/.gitkeep"]);
export const V2_MIGRATION_MODIFIED_PATHS = Object.freeze([
  "catalog/catalog.json",
  "catalog/preview-manifest.json",
]);

function fail(message) {
  throw new Error(message);
}

function same(actual, expected) {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function runGit(repository, args, options = {}) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: options.encoding ?? null,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) fail(`git ${args.slice(0, 3).join(" ")} failed for trusted tree inspection`);
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
    if (nul === offset) { offset += 1; continue; }
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

function outerIdentity(matches, label) {
  if (matches.some((match) => !match)) fail(`${label} path is malformed`);
  const identity = `${matches[0][1]}@${matches[0][2]}`;
  if (matches.some((match) => `${match[1]}@${match[2]}` !== identity)) fail(`${label} paths do not share one exact identity`);
  return { templateId: matches[0][1], releaseVersion: matches[0][2] };
}

function assertCandidateTree(candidate) {
  assertPortableTreeRecords([...candidate.values()], "candidate repository tree");
}

export function compareTreeMaps(base, candidate) {
  assertCandidateTree(candidate);
  const added = [...candidate.keys()].filter((name) => !base.has(name)).sort();
  const deleted = [...base.keys()].filter((name) => !candidate.has(name)).sort();
  const modified = [...base.keys()].filter((name) => {
    const next = candidate.get(name);
    if (!next) return false;
    const prior = base.get(name);
    return prior.mode !== next.mode || prior.type !== next.type || prior.oid !== next.oid;
  }).sort();

  if (
    same(added, V2_MIGRATION_ADDED_PATHS) &&
    same(deleted, V2_MIGRATION_DELETED_PATHS) &&
    same(modified, V2_MIGRATION_MODIFIED_PATHS)
  ) return { mode: "migration", added, deleted, modified };

  if (deleted.length) fail(`Community content PR may not delete files: ${deleted.join(", ")}`);

  const addEntries = added.filter((name) => ENTRY_PATH.test(name));
  const addThumbs = added.filter((name) => THUMB_PATH.test(name));
  const addReviews = added.filter((name) => REVIEW_PATH.test(name));
  if (
    added.length === 3 && addEntries.length === 1 && addThumbs.length === 1 && addReviews.length === 1 &&
    same(modified, V2_ADD_MODIFIED_PATHS)
  ) {
    const identity = outerIdentity(
      [ENTRY_PATH.exec(addEntries[0]), THUMB_PATH.exec(addThumbs[0]), REVIEW_PATH.exec(addReviews[0])],
      "Catalog addition",
    );
    return {
      mode: "add", added, deleted, modified, ...identity,
      entryPath: addEntries[0], thumbPath: addThumbs[0], reviewPath: addReviews[0],
    };
  }

  const reasons = added.filter((name) => REASON_PATH.test(name));
  if (added.length === 1 && reasons.length === 1) {
    const match = REASON_PATH.exec(reasons[0]);
    const identity = { templateId: match[1], releaseVersion: match[2] };
    const expectedModified = [
      "catalog/catalog.json",
      `catalog/entries/${identity.templateId}/${identity.releaseVersion}.json`,
      "catalog/entries.jsonl",
      `reviews/${identity.templateId}/${identity.releaseVersion}.md`,
    ].sort();
    if (same(modified, expectedModified)) {
      return { mode: "withdraw", added, deleted, modified, ...identity, reasonPath: reasons[0], entryPath: expectedModified.find((name) => ENTRY_PATH.test(name)), reviewPath: expectedModified.find((name) => REVIEW_PATH.test(name)) };
    }
  }

  fail(
    "Community PR must be exactly one v2 add (3 add + 4 modify), one v2 withdrawal " +
    "(1 add + 4 modify), or the one-time zero-entry v1-to-v2 migration",
  );
}

export function compareRepositoryTrees(baseRoot, candidateRoot) {
  return compareTreeMaps(readGitTree(baseRoot), readGitTree(candidateRoot));
}

async function main() {
  const [baseArg, candidateArg, ...rest] = process.argv.slice(2);
  if (!baseArg || !candidateArg) fail("usage: validate-pr-trees.mjs <trusted-base-checkout> <candidate-checkout> [--github-output <path>]");
  let githubOutput;
  if (rest.length === 2 && rest[0] === "--github-output" && rest[1]) githubOutput = rest[1];
  else if (rest.length !== 0) fail("invalid validate-pr-trees arguments");
  const result = compareRepositoryTrees(baseArg, candidateArg);
  if (githubOutput) appendFileSync(githubOutput, `mode=${result.mode}\n`, { encoding: "utf8" });
  const identity = result.templateId ? ` for ${result.templateId}@${result.releaseVersion}` : "";
  console.log(`validated exact Community ${result.mode} tree${identity}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
