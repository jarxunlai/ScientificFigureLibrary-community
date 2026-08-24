import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const ENTRY_PATH = /^catalog\/entries\/([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?)\/([0-9A-Za-z.+-]+)\.json$/u;
const THUMB_PATH = /^thumbs\/([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?)\/([0-9A-Za-z.+-]+)\.png$/u;
const REVIEW_PATH = /^reviews\/([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?)\/([0-9A-Za-z.+-]+)\.md$/u;
const ALLOWED_MODIFIED = ["catalog/catalog.json", "catalog/preview-manifest.json"];

const RESTRICTED_RELEASES = Object.freeze([
  Object.freeze({
    templateId: "ggsankeyfier-layout-color-combo",
    releaseVersion: "1.0.0",
    entryPath: "catalog/entries/ggsankeyfier-layout-color-combo/1.0.0.json",
    thumbPath: "thumbs/ggsankeyfier-layout-color-combo/1.0.0.png",
    reviewPath: "reviews/ggsankeyfier-layout-color-combo/1.0.0.md",
  }),
  Object.freeze({
    templateId: "single-cell-enrichment-bar-pathway-genes",
    releaseVersion: "1.0.0",
    entryPath: "catalog/entries/single-cell-enrichment-bar-pathway-genes/1.0.0.json",
    thumbPath: "thumbs/single-cell-enrichment-bar-pathway-genes/1.0.0.png",
    reviewPath: "reviews/single-cell-enrichment-bar-pathway-genes/1.0.0.md",
  }),
  Object.freeze({
    templateId: "umap-unchull-main-type-circles",
    releaseVersion: "1.0.0",
    entryPath: "catalog/entries/umap-unchull-main-type-circles/1.0.0.json",
    thumbPath: "thumbs/umap-unchull-main-type-circles/1.0.0.png",
    reviewPath: "reviews/umap-unchull-main-type-circles/1.0.0.md",
  }),
]);

export const RESTRICTED_SEED_WITHDRAWAL = Object.freeze({
  releases: RESTRICTED_RELEASES,
  deletedPaths: Object.freeze(RESTRICTED_RELEASES.flatMap((release) => [
    release.entryPath,
    release.reviewPath,
    release.thumbPath,
  ]).sort()),
  modifiedPaths: Object.freeze([...ALLOWED_MODIFIED]),
  baseOids: Object.freeze({
    "catalog/catalog.json": "d8cf0eff8c09b734992d402b6ba81d40a73476ab",
    "catalog/preview-manifest.json": "d40c6e9eb378a0293b0413a30e840e5b7f436bdb",
    "catalog/entries/ggsankeyfier-layout-color-combo/1.0.0.json": "90cbec8f28597de656114531e30bfa70ed01c893",
    "catalog/entries/single-cell-enrichment-bar-pathway-genes/1.0.0.json": "e738295c9ba3af4cbe049a997b385e3802dd5279",
    "catalog/entries/umap-unchull-main-type-circles/1.0.0.json": "215a3cd4be0226fb3f024f43ddd156c5a24c8a74",
    "reviews/ggsankeyfier-layout-color-combo/1.0.0.md": "5aa67cf44c7798320a91cdea5510657baf3ed9d0",
    "reviews/single-cell-enrichment-bar-pathway-genes/1.0.0.md": "48ab70e52ca5f3b375331d83b124066156ab1be5",
    "reviews/umap-unchull-main-type-circles/1.0.0.md": "aa295a448091781cf2f00b3397120a3005e46419",
    "thumbs/ggsankeyfier-layout-color-combo/1.0.0.png": "e1690b0f35f1ad247b74e08d0cf909797bed61ca",
    "thumbs/single-cell-enrichment-bar-pathway-genes/1.0.0.png": "98c33839d8e86c622c2cad78a77f6c085410bb0f",
    "thumbs/umap-unchull-main-type-circles/1.0.0.png": "435b955c3e34267e07258e5af9896642de8807d8",
  }),
});

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
  const exactWithdrawalPaths =
    added.length === 0 &&
    deleted.length === RESTRICTED_SEED_WITHDRAWAL.deletedPaths.length &&
    deleted.every((name, index) => name === RESTRICTED_SEED_WITHDRAWAL.deletedPaths[index]) &&
    modified.length === RESTRICTED_SEED_WITHDRAWAL.modifiedPaths.length &&
    modified.every((name, index) => name === RESTRICTED_SEED_WITHDRAWAL.modifiedPaths[index]);
  const touchesRestrictedWithdrawal = [...added, ...deleted, ...modified].some(
    (name) => RESTRICTED_SEED_WITHDRAWAL.deletedPaths.includes(name),
  );
  if (touchesRestrictedWithdrawal && !exactWithdrawalPaths) {
    fail("restricted seed withdrawal must atomically change only every exact withdrawal path");
  }
  if (exactWithdrawalPaths) {
    const boundPaths = Object.keys(RESTRICTED_SEED_WITHDRAWAL.baseOids).sort();
    const changedPaths = [
      ...RESTRICTED_SEED_WITHDRAWAL.deletedPaths,
      ...RESTRICTED_SEED_WITHDRAWAL.modifiedPaths,
    ].sort();
    if (
      boundPaths.length !== changedPaths.length ||
      boundPaths.some((name, index) => name !== changedPaths[index])
    ) fail("restricted seed withdrawal policy is not bound to every changed path");
    for (const [name, expectedOid] of Object.entries(RESTRICTED_SEED_WITHDRAWAL.baseOids)) {
      const observed = base.get(name);
      if (!observed || observed.mode !== "100644" || observed.type !== "blob" || observed.oid !== expectedOid) {
        fail(`restricted seed withdrawal base identity changed at ${name}`);
      }
    }
    return {
      mode: "withdrawal",
      added,
      deleted,
      modified,
      identities: RESTRICTED_SEED_WITHDRAWAL.releases.map(
        (release) => `${release.templateId}@${release.releaseVersion}`,
      ),
    };
  }

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
    mode: "add",
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
  const [baseArg, candidateArg, ...rest] = process.argv.slice(2);
  if (!baseArg || !candidateArg) {
    fail("usage: validate-pr-trees.mjs <trusted-base-checkout> <candidate-checkout> [--github-output <path>]");
  }
  let githubOutput;
  if (rest.length === 2 && rest[0] === "--github-output" && rest[1]) githubOutput = rest[1];
  else if (rest.length !== 0) fail("invalid validate-pr-trees arguments");
  const result = compareRepositoryTrees(baseArg, candidateArg);
  if (githubOutput) appendFileSync(githubOutput, `mode=${result.mode}\n`, { encoding: "utf8" });
  if (result.mode === "withdrawal") {
    console.log(`validated exact restricted seed withdrawal tree for ${result.identities.join(", ")}`);
  } else {
    console.log(`validated immutable one-release Catalog tree for ${result.templateId}@${result.releaseVersion}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
