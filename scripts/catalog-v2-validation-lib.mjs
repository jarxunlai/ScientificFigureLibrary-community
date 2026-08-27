import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectPngStream } from "./streaming-png-validation-lib.mjs";
import { assertV2Schema } from "./schema-validation-lib.mjs";
import { compareRepositoryTrees, validatePortableRepositoryPath } from "./validate-pr-trees.mjs";
import { canonicalJson, readCanonicalJsonl, scanWithdrawalReason } from "./stream-validation-lib.mjs";

const PROVIDER_ID = "io.github.jarxunlai.scientific-figure-community";
const CATALOG_REPOSITORY = "jarxunlai/ScientificFigureLibrary-community";
const ARCHIVE_REPOSITORY = "jarxunlai/ScientificFigureLibrary-community-archives";
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const TEMPLATE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const SEMVER_IDENTIFIER = "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
  `^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)` +
    `(?:-${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*)?` +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
  "u",
);
const RFC3339 = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/u;
const PRIVATE_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s"'`(=])\/(?:Users|home|mnt\/[A-Za-z]|private|var\/folders|tmp|etc|opt|root|srv|Volumes|workspace|data)\/)/mu;
const CODE_LICENSES = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "GPL-3.0"]);
const CONTENT_LICENSES = new Set(["CC-BY-4.0", "CC0-1.0", "CC-BY-SA-4.0"]);
const ENTRY_KEYS = [
  "archive", "contentDigest", "description", "immutableEntrySha256", "language", "licenses", "preview",
  "provenance", "providerId", "publicAssetKind", "releaseState", "releaseVersion", "schema", "search",
  "status", "templateId", "title", "withdrawal",
];
const RETIRED_FLOOR_IDENTITIES = Object.freeze([
  "ggsankeyfier-layout-color-combo@1.0.0",
  "single-cell-enrichment-bar-pathway-genes@1.0.0",
  "umap-unchull-main-type-circles@1.0.0",
]);

function fail(message) { throw new Error(message); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function identityOf(value) { return `${value.templateId}@${value.releaseVersion}`; }

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, keys, label) {
  assertRecord(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must use fixed keys ${expected.join(", ")}; got ${actual.join(", ")}`);
  }
}

function assertText(value, label, maximum, { empty = false } = {}) {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim())) fail(`${label} is invalid text`);
  if (value.normalize("NFC") !== value || PRIVATE_PATH.test(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    fail(`${label} contains non-public or non-canonical text`);
  }
  return value;
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${label} must be lowercase SHA-256`);
  return value;
}

function assertInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is outside the allowed integer range`);
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) fail(`${label} must be RFC3339 UTC`);
  return value;
}

function assertSortedStrings(value, label, { pathPrefix, required = false } = {}) {
  if (!Array.isArray(value) || value.length > 10_000 || (required && value.length === 0)) fail(`${label} must be a bounded array`);
  const result = value.map((item, index) => {
    const text = assertText(item, `${label}[${index}]`, 1_000);
    if (pathPrefix) {
      validatePortableRepositoryPath(text);
      if (!text.startsWith(pathPrefix)) fail(`${label}[${index}] must remain under ${pathPrefix}`);
    }
    return text;
  });
  const sorted = [...result].sort();
  if (new Set(result).size !== result.length || result.some((item, index) => item !== sorted[index])) {
    fail(`${label} must be unique and canonically sorted`);
  }
  return result;
}

function immutableProjection(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !["immutableEntrySha256", "releaseState", "withdrawal"].includes(key)));
}

function expectedImmutableEntrySha256(entry) {
  return sha256(Buffer.from(canonicalJson(immutableProjection(entry)), "utf8"));
}

export function parseEntryV2(value, label = "public entry v2") {
  assertV2Schema("entry", value, label);
  assertExactKeys(value, ENTRY_KEYS, label);
  if (value.schema !== "figure-library.public-template-entry.v2" || value.providerId !== PROVIDER_ID) fail(`${label} has invalid schema/Provider`);
  const templateId = assertText(value.templateId, `${label}.templateId`, 128);
  const releaseVersion = assertText(value.releaseVersion, `${label}.releaseVersion`, 100);
  if (!TEMPLATE_ID.test(templateId) || !SEMVER.test(releaseVersion)) fail(`${label} has invalid templateId/releaseVersion`);
  assertHash(value.contentDigest, `${label}.contentDigest`);
  assertHash(value.immutableEntrySha256, `${label}.immutableEntrySha256`);
  if (!['plot_template', 'visual_reference'].includes(value.publicAssetKind)) fail(`${label}.publicAssetKind is invalid`);
  if (!['R', 'Python'].includes(value.language)) fail(`${label}.language is invalid`);
  assertText(value.title, `${label}.title`, 300);
  assertText(value.description, `${label}.description`, 4_000);

  assertExactKeys(value.search, ["application", "codeFiles", "dataProfile", "inputFiles", "packages", "plotFamily", "tags"], `${label}.search`);
  assertText(value.search.application, `${label}.search.application`, 4_000, { empty: true });
  assertText(value.search.dataProfile, `${label}.search.dataProfile`, 4_000, { empty: true });
  assertText(value.search.plotFamily, `${label}.search.plotFamily`, 200);
  assertSortedStrings(value.search.tags, `${label}.search.tags`);
  assertSortedStrings(value.search.packages, `${label}.search.packages`);
  const codeFiles = assertSortedStrings(value.search.codeFiles, `${label}.search.codeFiles`, { pathPrefix: "payload/code/", required: true });
  const inputFiles = assertSortedStrings(value.search.inputFiles, `${label}.search.inputFiles`, { pathPrefix: "payload/data/" });
  const entrypoints = codeFiles.filter((file) => file === "payload/code/render.R" || file === "payload/code/render.py");
  if (entrypoints.length !== 1 || (entrypoints[0].endsWith("render.R") ? "R" : "Python") !== value.language) {
    fail(`${label} must bind exactly one language-derived render.R XOR render.py entrypoint`);
  }
  if (value.publicAssetKind === "plot_template" && inputFiles.length === 0) fail(`${label} plot_template requires synthetic data`);

  assertExactKeys(value.archive, ["bytes", "commit", "path", "repository", "sha256"], `${label}.archive`);
  if (value.archive.repository !== ARCHIVE_REPOSITORY || typeof value.archive.commit !== "string" || !COMMIT.test(value.archive.commit)) {
    fail(`${label}.archive must bind the fixed repository and 40-hex commit`);
  }
  const archivePath = `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`;
  if (value.archive.path !== archivePath) fail(`${label}.archive.path must be ${archivePath}`);
  assertInteger(value.archive.bytes, `${label}.archive.bytes`, { minimum: 1 });
  assertHash(value.archive.sha256, `${label}.archive.sha256`);

  assertExactKeys(value.preview, ["bytes", "canonicalRgbaSha256", "height", "mediaType", "path", "sha256", "width"], `${label}.preview`);
  if (value.preview.path !== `catalog/thumbs/${templateId}/${releaseVersion}.png` || value.preview.mediaType !== "image/png") fail(`${label}.preview identity is invalid`);
  assertInteger(value.preview.bytes, `${label}.preview.bytes`, { minimum: 1 });
  assertInteger(value.preview.width, `${label}.preview.width`, { minimum: 1, maximum: 16_384 });
  assertInteger(value.preview.height, `${label}.preview.height`, { minimum: 1, maximum: 16_384 });
  assertHash(value.preview.sha256, `${label}.preview.sha256`);
  assertHash(value.preview.canonicalRgbaSha256, `${label}.preview.canonicalRgbaSha256`);

  assertExactKeys(value.status, ["curationStatus", "localReviewStatus", "plotExecutionByRecipient", "publisherVerified", "renderValidation", "upstreamStatus"], `${label}.status`);
  if (
    value.status.upstreamStatus !== "published" || typeof value.status.publisherVerified !== "boolean" ||
    value.status.curationStatus !== "curated" || value.status.renderValidation !== "ci_rendered" ||
    value.status.localReviewStatus !== "not_reviewed" || value.status.plotExecutionByRecipient !== "not_run"
  ) fail(`${label}.status must preserve central/recipient fact separation`);

  assertExactKeys(value.licenses, ["code", "documentation", "preview", "syntheticData"], `${label}.licenses`);
  if (!CODE_LICENSES.has(value.licenses.code) || !CONTENT_LICENSES.has(value.licenses.preview)) fail(`${label}.licenses contains a non-allowlisted mandatory license`);
  for (const role of ["syntheticData", "documentation"]) {
    if (value.licenses[role] !== null && !CONTENT_LICENSES.has(value.licenses[role])) fail(`${label}.licenses.${role} is invalid`);
  }
  if ((inputFiles.length > 0) !== (value.licenses.syntheticData !== null)) fail(`${label}.licenses.syntheticData presence must match inputFiles`);

  if (!Array.isArray(value.provenance) || value.provenance.length > 1_000) fail(`${label}.provenance must be bounded`);
  for (const [index, item] of value.provenance.entries()) {
    assertExactKeys(item, ["type", "value"], `${label}.provenance[${index}]`);
    if (!["doi", "url", "inspiration", "note"].includes(item.type)) fail(`${label}.provenance[${index}].type is invalid`);
    assertText(item.value, `${label}.provenance[${index}].value`, 4_000);
  }

  if (value.releaseState === "active") {
    if (value.withdrawal !== null) fail(`${label} active release must have withdrawal=null`);
  } else if (value.releaseState === "withdrawn") {
    assertExactKeys(value.withdrawal, ["reason", "withdrawnAt"], `${label}.withdrawal`);
    assertTimestamp(value.withdrawal.withdrawnAt, `${label}.withdrawal.withdrawnAt`);
    assertExactKeys(value.withdrawal.reason, ["bytes", "path", "sha256"], `${label}.withdrawal.reason`);
    const expectedReason = `withdrawals/${templateId}/${releaseVersion}/reason.txt`;
    if (value.withdrawal.reason.path !== expectedReason) fail(`${label}.withdrawal.reason.path must be ${expectedReason}`);
    assertInteger(value.withdrawal.reason.bytes, `${label}.withdrawal.reason.bytes`, { minimum: 1 });
    assertHash(value.withdrawal.reason.sha256, `${label}.withdrawal.reason.sha256`);
  } else fail(`${label}.releaseState is invalid`);

  if (value.immutableEntrySha256 !== expectedImmutableEntrySha256(value)) fail(`${label}.immutableEntrySha256 does not bind immutable entry semantics`);
  return value;
}

function parsePreviewEntry(value, label) {
  assertV2Schema("previewEntry", value, label);
  assertExactKeys(value, ["preview", "providerId", "releaseVersion", "schema", "templateId"], label);
  if (value.schema !== "figure-library.public-preview-entry.v2" || value.providerId !== PROVIDER_ID) fail(`${label} has invalid schema/Provider`);
  const shell = {
    schema: "figure-library.public-template-entry.v2", providerId: PROVIDER_ID,
    templateId: value.templateId, releaseVersion: value.releaseVersion,
  };
  if (!TEMPLATE_ID.test(value.templateId) || !SEMVER.test(value.releaseVersion)) fail(`${label} has invalid identity`);
  assertExactKeys(value.preview, ["bytes", "canonicalRgbaSha256", "height", "mediaType", "path", "sha256", "width"], `${label}.preview`);
  if (value.preview.path !== `catalog/thumbs/${shell.templateId}/${shell.releaseVersion}.png` || value.preview.mediaType !== "image/png") fail(`${label}.preview path/mediaType is invalid`);
  assertInteger(value.preview.bytes, `${label}.preview.bytes`, { minimum: 1 });
  assertInteger(value.preview.width, `${label}.preview.width`, { minimum: 1, maximum: 16_384 });
  assertInteger(value.preview.height, `${label}.preview.height`, { minimum: 1, maximum: 16_384 });
  assertHash(value.preview.sha256, `${label}.preview.sha256`);
  assertHash(value.preview.canonicalRgbaSha256, `${label}.preview.canonicalRgbaSha256`);
  return value;
}

function parseRetired(value, label) {
  assertV2Schema("retiredRelease", value, label);
  assertExactKeys(value, ["providerId", "releaseVersion", "schema", "templateId"], label);
  if (value.schema !== "figure-library.public-retired-release.v2" || value.providerId !== PROVIDER_ID) fail(`${label} has invalid schema/Provider`);
  if (!TEMPLATE_ID.test(value.templateId) || !SEMVER.test(value.releaseVersion)) fail(`${label} has invalid identity`);
  return value;
}

async function readSmallCanonicalJson(filePath, label) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail(`${label} must be a small regular control file`);
  const bytes = await fs.readFile(filePath);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(`${label} is not UTF-8`); }
  let value;
  try { value = JSON.parse(text); } catch { fail(`${label} is not JSON`); }
  if (text !== `${canonicalJson(value)}\n`) fail(`${label} must be canonical JSON with one LF`);
  return { bytes, text, value, sha256: sha256(bytes) };
}

function parseJsonlIdentity(value, label, expectedPath) {
  assertExactKeys(value, ["bytes", "count", "path", "sha256"], label);
  if (value.path !== expectedPath) fail(`${label}.path must be ${expectedPath}`);
  assertInteger(value.count, `${label}.count`);
  assertInteger(value.bytes, `${label}.bytes`);
  assertHash(value.sha256, `${label}.sha256`);
  return value;
}

function parseCatalogEnvelope(value, label) {
  assertV2Schema("catalog", value, label);
  assertExactKeys(value, ["entries", "generatedAt", "previewManifest", "previews", "provider", "retiredReleases", "schema"], label);
  if (value.schema !== "figure-library.public-provider-catalog.v2") fail(`${label}.schema is invalid`);
  assertExactKeys(value.provider, ["archiveRepository", "catalogRepository", "displayName", "providerId"], `${label}.provider`);
  if (
    value.provider.providerId !== PROVIDER_ID || value.provider.displayName !== "Scientific Figure Library Community" ||
    value.provider.catalogRepository !== CATALOG_REPOSITORY || value.provider.archiveRepository !== ARCHIVE_REPOSITORY
  ) fail(`${label}.provider is invalid`);
  assertTimestamp(value.generatedAt, `${label}.generatedAt`);
  parseJsonlIdentity(value.entries, `${label}.entries`, "catalog/entries.jsonl");
  parseJsonlIdentity(value.previews, `${label}.previews`, "catalog/previews.jsonl");
  parseJsonlIdentity(value.retiredReleases, `${label}.retiredReleases`, "catalog/retired-releases.jsonl");
  assertExactKeys(value.previewManifest, ["bytes", "path", "sha256"], `${label}.previewManifest`);
  if (value.previewManifest.path !== "catalog/preview-manifest.json") fail(`${label}.previewManifest.path is invalid`);
  assertInteger(value.previewManifest.bytes, `${label}.previewManifest.bytes`, { minimum: 1 });
  assertHash(value.previewManifest.sha256, `${label}.previewManifest.sha256`);
  return value;
}

function parsePreviewManifest(value, label) {
  assertV2Schema("previewManifest", value, label);
  assertExactKeys(value, ["previews", "providerId", "schema"], label);
  if (value.schema !== "figure-library.public-preview-manifest.v2" || value.providerId !== PROVIDER_ID) fail(`${label} has invalid schema/Provider`);
  parseJsonlIdentity(value.previews, `${label}.previews`, "catalog/previews.jsonl");
  return value;
}

function assertCanonicalIdentityOrder(previous, current, seen, label) {
  if (seen.has(current) || (previous.value && current <= previous.value)) fail(`${label} identities are duplicate or not canonical at ${current}`);
  seen.add(current);
  previous.value = current;
}

export async function readCatalogV2(repositoryRoot, label = "Catalog v2") {
  const root = path.resolve(repositoryRoot);
  const catalogFile = await readSmallCanonicalJson(path.join(root, "catalog", "catalog.json"), `${label} envelope`);
  const catalog = parseCatalogEnvelope(catalogFile.value, `${label} envelope`);
  const previewManifestFile = await readSmallCanonicalJson(path.join(root, "catalog", "preview-manifest.json"), `${label} preview manifest`);
  if (previewManifestFile.bytes.byteLength !== catalog.previewManifest.bytes || previewManifestFile.sha256 !== catalog.previewManifest.sha256) fail(`${label} preview manifest identity mismatch`);
  const previewManifest = parsePreviewManifest(previewManifestFile.value, `${label} preview manifest`);
  if (canonicalJson(previewManifest.previews) !== canonicalJson(catalog.previews)) fail(`${label} preview manifest does not mirror the Catalog preview identity`);

  const entries = new Map();
  const entrySeen = new Set();
  const entryOrder = { value: "" };
  await readCanonicalJsonl(path.join(root, "catalog", "entries.jsonl"), {
    label: `${label} entries`, expected: catalog.entries,
    onRecord: async (value, index) => {
      const entry = parseEntryV2(value, `${label} entries[${index}]`);
      const identity = identityOf(entry);
      assertCanonicalIdentityOrder(entryOrder, identity, entrySeen, `${label} entries`);
      entries.set(identity, entry);
    },
  });

  const previews = new Map();
  const previewSeen = new Set();
  const previewOrder = { value: "" };
  await readCanonicalJsonl(path.join(root, "catalog", "previews.jsonl"), {
    label: `${label} previews`, expected: catalog.previews,
    onRecord: async (value, index) => {
      const preview = parsePreviewEntry(value, `${label} previews[${index}]`);
      const identity = identityOf(preview);
      assertCanonicalIdentityOrder(previewOrder, identity, previewSeen, `${label} previews`);
      previews.set(identity, preview);
    },
  });

  const retired = new Map();
  const retiredSeen = new Set();
  const retiredOrder = { value: "" };
  await readCanonicalJsonl(path.join(root, "catalog", "retired-releases.jsonl"), {
    label: `${label} retired releases`, expected: catalog.retiredReleases,
    onRecord: async (value, index) => {
      const item = parseRetired(value, `${label} retired[${index}]`);
      const identity = identityOf(item);
      assertCanonicalIdentityOrder(retiredOrder, identity, retiredSeen, `${label} retired releases`);
      retired.set(identity, item);
    },
  });

  if (previews.size !== entries.size) fail(`${label} entries/previews counts differ`);
  for (const [identity, entry] of entries) {
    const preview = previews.get(identity);
    if (!preview || canonicalJson(preview.preview) !== canonicalJson(entry.preview)) fail(`${label} preview does not exactly mirror ${identity}`);
    if (retired.has(identity)) fail(`${label} retired identity is also an entry: ${identity}`);
  }
  for (const identity of RETIRED_FLOOR_IDENTITIES) {
    const item = retired.get(identity);
    if (!item) fail(`${label} is missing immutable retired trust-floor identity ${identity}`);
  }
  return { catalog, entries, previews, retired, previewManifest };
}

async function inventoryDirectory(repositoryRoot, relativeDirectory) {
  const root = path.join(repositoryRoot, ...relativeDirectory.split("/"));
  const output = new Set();
  const folded = new Map();
  const walk = async (directory, relative) => {
    const directoryEntries = await fs.readdir(directory, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const item of directoryEntries) {
      const filePath = `${relative}/${item.name}`;
      validatePortableRepositoryPath(filePath);
      const absolute = path.join(directory, item.name);
      if (item.isSymbolicLink()) fail(`release inventory contains a symlink: ${filePath}`);
      if (item.isDirectory()) await walk(absolute, filePath);
      else if (item.isFile()) {
        const key = filePath.normalize("NFC").toLocaleLowerCase("en-US");
        const prior = folded.get(key);
        if (prior && prior !== filePath) fail(`release inventory has a case-fold collision: ${prior} <> ${filePath}`);
        folded.set(key, filePath);
        output.add(filePath);
      } else fail(`release inventory contains a non-file: ${filePath}`);
    }
  };
  await walk(root, relativeDirectory);
  return output;
}

async function verifyPreview(repositoryRoot, entry) {
  const previewPath = path.join(repositoryRoot, ...entry.preview.path.split("/"));
  const decoded = await inspectPngStream(previewPath);
  if (
    decoded.bytes !== entry.preview.bytes || decoded.sha256 !== entry.preview.sha256 || decoded.width !== entry.preview.width ||
    decoded.height !== entry.preview.height || decoded.canonicalRgbaSha256 !== entry.preview.canonicalRgbaSha256
  ) fail(`thumbnail image identity mismatch: ${identityOf(entry)}`);
  return decoded;
}

async function readPublicText(filePath, label) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail(`${label} must be a small regular file`);
  const bytes = await fs.readFile(filePath);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(`${label} is not UTF-8`); }
  if (text.includes("\r") || PRIVATE_PATH.test(text)) fail(`${label} contains non-public/non-canonical text`);
  return text;
}

async function verifyReview(repositoryRoot, entry) {
  const reviewPath = path.join(repositoryRoot, "reviews", entry.templateId, `${entry.releaseVersion}.md`);
  const text = await readPublicText(reviewPath, `review ${identityOf(entry)}`);
  for (const required of [
    `# Community review: ${entry.templateId} ${entry.releaseVersion}\n`,
    `- Archive merge commit: \`${entry.archive.commit}\`\n`,
    `- Archive SHA-256: \`${entry.archive.sha256}\`\n`,
    `- Content digest: \`${entry.contentDigest}\`\n`,
    `- Public asset kind: ${entry.publicAssetKind}\n`,
    `- Language: ${entry.language}\n`,
    "- Code execution by SFL client: false\n",
  ]) if (!text.includes(required)) fail(`review does not bind required v2 identity: ${identityOf(entry)}`);
  if (entry.releaseState === "withdrawn") {
    for (const required of [
      "- Release state: withdrawn\n",
      `- Withdrawn at: ${entry.withdrawal.withdrawnAt}\n`,
      `- Withdrawal reason: \`${entry.withdrawal.reason.path}\` (${entry.withdrawal.reason.bytes} bytes, \`${entry.withdrawal.reason.sha256}\`)\n`,
    ]) if (!text.includes(required)) fail(`withdrawn review does not bind lifecycle metadata: ${identityOf(entry)}`);
  } else if (text.includes("- Release state: withdrawn\n")) fail(`active review claims withdrawn state: ${identityOf(entry)}`);
}

function runGit(repository, args, { allowFailure = false, encoding = null, maxBuffer = 64 * 1024 } = {}) {
  const safeRoot = path.resolve(repository).replaceAll("\\", "/");
  const result = spawnSync("git", ["-c", `safe.directory=${safeRoot}`, "-C", repository, ...args], { encoding, maxBuffer, windowsHide: true });
  if (!allowFailure && (result.error || result.status !== 0)) fail(`trusted archive git ${args.slice(0, 4).join(" ")} failed`);
  return result;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function hashGitBlobStream(repository, objectId, expectedBytes) {
  const safeRoot = path.resolve(repository).replaceAll("\\", "/");
  const child = spawn(
    "git",
    ["-c", `safe.directory=${safeRoot}`, "-C", repository, "cat-file", "blob", objectId],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const exit = waitForChild(child);
  const hash = createHash("sha256");
  let bytes = 0;
  let peakBufferedBytes = 0;
  const stdout = (async () => {
    for await (const chunk of child.stdout) {
      bytes += chunk.byteLength;
      if (bytes > expectedBytes) throw new Error("Archive bytes/SHA-256 mismatch");
      peakBufferedBytes = Math.max(peakBufferedBytes, chunk.byteLength);
      hash.update(chunk);
    }
  })();
  const stderr = (async () => {
    let observedBytes = 0;
    for await (const chunk of child.stderr) {
      observedBytes += chunk.byteLength;
      if (observedBytes > 64 * 1024) throw new Error("trusted archive git stderr exceeded its control-plane boundary");
    }
  })();
  try {
    const [, , status] = await Promise.all([stdout, stderr, exit]);
    if (status.code !== 0 || status.signal !== null) fail("trusted archive git cat-file blob failed");
  } catch (error) {
    child.kill();
    await exit.catch(() => undefined);
    throw error;
  }
  return { bytes, sha256: hash.digest("hex"), peakBufferedBytes };
}

function readExactRegularBlob(repository, revision, archivePath, label) {
  const result = runGit(repository, ["ls-tree", "-z", revision, "--", archivePath]);
  const output = Buffer.from(result.stdout);
  const record = output.subarray(0, output.byteLength && output[output.byteLength - 1] === 0 ? -1 : undefined).toString("utf8");
  const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/u.exec(record);
  if (!match || match[2] !== archivePath) fail(`${label} is not one exact regular blob`);
  return match[1];
}

async function verifyArchive(archivesRoot, entry) {
  const ancestor = runGit(archivesRoot, ["merge-base", "--is-ancestor", entry.archive.commit, "HEAD"], { allowFailure: true });
  if (ancestor.error || ancestor.status !== 0) fail("entry.archive.commit is not an ancestor of fixed Archives main");
  const immutableBlob = readExactRegularBlob(archivesRoot, entry.archive.commit, entry.archive.path, "entry.archive.path");
  const currentBlob = readExactRegularBlob(archivesRoot, "HEAD", entry.archive.path, "fixed Archives main archive path");
  if (currentBlob !== immutableBlob) fail("fixed Archives main no longer retains the exact immutable Archive blob");
  const sizeResult = runGit(archivesRoot, ["cat-file", "-s", immutableBlob], { encoding: "utf8" });
  if (!/^(?:0|[1-9][0-9]*)\r?\n$/u.test(sizeResult.stdout)) fail("trusted archive git returned an invalid blob size");
  const declaredGitBytes = Number(sizeResult.stdout.trim());
  if (!Number.isSafeInteger(declaredGitBytes) || declaredGitBytes !== entry.archive.bytes) fail("Archive bytes/SHA-256 mismatch");
  const observed = await hashGitBlobStream(archivesRoot, immutableBlob, entry.archive.bytes);
  if (observed.bytes !== entry.archive.bytes || observed.sha256 !== entry.archive.sha256) fail("Archive bytes/SHA-256 mismatch");
  return observed;
}

export async function validateFullRepositoryV2(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const snapshot = await readCatalogV2(root, "repository Catalog v2");
  const expectedEntries = new Set(["catalog/entries/.gitkeep"]);
  const expectedThumbs = new Set(["catalog/thumbs/.gitkeep"]);
  const expectedReviews = new Set(["reviews/.gitkeep"]);
  const expectedWithdrawals = new Set(["withdrawals/.gitkeep"]);
  for (const entry of snapshot.entries.values()) {
    expectedEntries.add(`catalog/entries/${entry.templateId}/${entry.releaseVersion}.json`);
    expectedThumbs.add(entry.preview.path);
    expectedReviews.add(`reviews/${entry.templateId}/${entry.releaseVersion}.md`);
    if (entry.releaseState === "withdrawn") expectedWithdrawals.add(entry.withdrawal.reason.path);
  }
  for (const [directory, expected] of [
    ["catalog/entries", expectedEntries], ["catalog/thumbs", expectedThumbs],
    ["reviews", expectedReviews], ["withdrawals", expectedWithdrawals],
  ]) {
    const observed = await inventoryDirectory(root, directory);
    if (observed.size !== expected.size || [...expected].some((item) => !observed.has(item))) fail(`${directory} contains an orphan or missing file`);
  }
  for (const [identity, entry] of snapshot.entries) {
    const standalone = await readSmallCanonicalJson(path.join(root, "catalog", "entries", entry.templateId, `${entry.releaseVersion}.json`), `standalone ${identity}`);
    if (canonicalJson(standalone.value) !== canonicalJson(entry)) fail(`standalone entry differs from JSONL: ${identity}`);
    await verifyPreview(root, entry);
    await verifyReview(root, entry);
    if (entry.releaseState === "withdrawn") {
      await scanWithdrawalReason(path.join(root, ...entry.withdrawal.reason.path.split("/")), { label: `withdrawal reason ${identity}`, expected: entry.withdrawal.reason });
    }
  }
  for (const [licensePath, requiredText, minimum] of [
    ["LICENSES/MIT.txt", "MIT License", 500],
    ["LICENSES/Apache-2.0.txt", "Apache License", 10_000],
    ["LICENSES/BSD-3-Clause.txt", "Redistribution and use in source and binary forms", 1_000],
    ["LICENSES/GPL-3.0.txt", "GNU GENERAL PUBLIC LICENSE", 30_000],
    ["LICENSES/CC-BY-4.0.txt", "Attribution 4.0 International", 10_000],
    ["LICENSES/CC0-1.0.txt", "CC0 1.0 Universal", 5_000],
    ["LICENSES/CC-BY-SA-4.0.txt", "Attribution-ShareAlike 4.0 International", 10_000],
  ]) {
    const bytes = await fs.readFile(path.join(root, ...licensePath.split("/")));
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(`${licensePath} is not UTF-8`); }
    if (!text.includes(requiredText) || text.length <= minimum) fail(`${licensePath} is not the required complete license text`);
  }
  return {
    schema: "v2", entries: snapshot.entries.size,
    active: [...snapshot.entries.values()].filter((entry) => entry.releaseState === "active").length,
    withdrawn: [...snapshot.entries.values()].filter((entry) => entry.releaseState === "withdrawn").length,
    retired: snapshot.retired.size,
  };
}

function mapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (!right.has(key) || canonicalJson(right.get(key)) !== canonicalJson(value)) return false;
  return true;
}

export async function validateCatalogAdditionV2({ baseRoot, candidateRoot, archivesRoot }) {
  const tree = compareRepositoryTrees(baseRoot, candidateRoot);
  if (tree.mode !== "add") fail("candidate is not an exact v2 Catalog addition tree");
  const [base, candidate] = await Promise.all([readCatalogV2(baseRoot, "trusted base v2"), readCatalogV2(candidateRoot, "candidate v2")]);
  const identity = `${tree.templateId}@${tree.releaseVersion}`;
  const added = candidate.entries.get(identity);
  if (!added || added.releaseState !== "active" || base.entries.has(identity) || base.retired.has(identity)) fail("Catalog addition attempts to overwrite, retire, or add a non-active identity");
  if (candidate.entries.size !== base.entries.size + 1 || candidate.previews.size !== base.previews.size + 1) fail("Catalog addition must append exactly one entry and preview");
  for (const [key, value] of base.entries) if (!candidate.entries.has(key) || canonicalJson(candidate.entries.get(key)) !== canonicalJson(value)) fail(`Catalog addition changed existing entry ${key}`);
  for (const [key, value] of base.previews) if (!candidate.previews.has(key) || canonicalJson(candidate.previews.get(key)) !== canonicalJson(value)) fail(`Catalog addition changed existing preview ${key}`);
  if (!mapsEqual(base.retired, candidate.retired)) fail("Catalog addition changed the append-only retired ledger");
  if (Date.parse(candidate.catalog.generatedAt) <= Date.parse(base.catalog.generatedAt)) fail("Catalog addition must advance generatedAt");
  await validateFullRepositoryV2(candidateRoot);
  await verifyArchive(archivesRoot, added);
  return { ...tree, archiveCommit: added.archive.commit, contentDigest: added.contentDigest };
}

export async function validateCatalogWithdrawalV2({ baseRoot, candidateRoot }) {
  const tree = compareRepositoryTrees(baseRoot, candidateRoot);
  if (tree.mode !== "withdraw") fail("candidate is not an exact v2 Catalog withdrawal tree");
  const [base, candidate] = await Promise.all([readCatalogV2(baseRoot, "trusted base v2"), readCatalogV2(candidateRoot, "withdrawal candidate v2")]);
  const identity = `${tree.templateId}@${tree.releaseVersion}`;
  const prior = base.entries.get(identity);
  const next = candidate.entries.get(identity);
  if (!prior || !next || prior.releaseState !== "active" || next.releaseState !== "withdrawn") fail("withdrawal must transition one existing active release to withdrawn");
  if (prior.immutableEntrySha256 !== next.immutableEntrySha256 || canonicalJson(immutableProjection(prior)) !== canonicalJson(immutableProjection(next))) {
    fail("withdrawal changed immutable release semantics");
  }
  if (Date.parse(candidate.catalog.generatedAt) <= Date.parse(base.catalog.generatedAt)) fail("withdrawal must advance generatedAt");
  for (const [key, value] of base.entries) {
    const observed = candidate.entries.get(key);
    if (!observed) fail(`withdrawal removed entry ${key}`);
    if (key !== identity && canonicalJson(observed) !== canonicalJson(value)) fail(`withdrawal changed unrelated entry ${key}`);
  }
  if (candidate.entries.size !== base.entries.size || !mapsEqual(base.previews, candidate.previews) || !mapsEqual(base.retired, candidate.retired)) {
    fail("withdrawal changed previews, retired ledger, or release cardinality");
  }
  const reasonPath = path.join(candidateRoot, ...next.withdrawal.reason.path.split("/"));
  await scanWithdrawalReason(reasonPath, { label: `withdrawal reason ${identity}`, expected: next.withdrawal.reason });
  const baseReview = await readPublicText(path.join(baseRoot, "reviews", tree.templateId, `${tree.releaseVersion}.md`), `trusted review ${identity}`);
  const candidateReview = await readPublicText(path.join(candidateRoot, "reviews", tree.templateId, `${tree.releaseVersion}.md`), `withdrawn review ${identity}`);
  const appendix = [
    "",
    "## Withdrawal",
    "",
    "- Release state: withdrawn",
    `- Withdrawn at: ${next.withdrawal.withdrawnAt}`,
    `- Withdrawal reason: \`${next.withdrawal.reason.path}\` (${next.withdrawal.reason.bytes} bytes, \`${next.withdrawal.reason.sha256}\`)`,
    "",
  ].join("\n");
  if (candidateReview !== `${baseReview}${appendix}`) fail("withdrawal review must append only the exact immutable lifecycle block");
  await validateFullRepositoryV2(candidateRoot);
  return { ...tree, withdrawnAt: next.withdrawal.withdrawnAt, reason: next.withdrawal.reason };
}

async function readLegacyZeroCatalog(repositoryRoot) {
  const catalog = await readSmallCanonicalJson(path.join(repositoryRoot, "catalog", "catalog.json"), "legacy zero Catalog");
  const manifest = await readSmallCanonicalJson(path.join(repositoryRoot, "catalog", "preview-manifest.json"), "legacy zero preview manifest");
  if (
    catalog.value.schema !== "figure-library.public-provider-catalog.v1" || !Array.isArray(catalog.value.entries) || catalog.value.entries.length !== 0 ||
    manifest.value.schema !== "figure-library.public-preview-manifest.v1" || !Array.isArray(manifest.value.entries) || manifest.value.entries.length !== 0
  ) fail("migration base must be the exact healthy zero-entry v1 snapshot");
  return { catalog: catalog.value, manifest: manifest.value };
}

export async function validateZeroEntryMigrationV2({ baseRoot, candidateRoot }) {
  const tree = compareRepositoryTrees(baseRoot, candidateRoot);
  if (tree.mode !== "migration") fail("candidate is not the exact one-time v1-to-v2 migration tree");
  const { validateFullRepository } = await import("./catalog-validation-lib.mjs");
  const legacy = await validateFullRepository(baseRoot);
  if (legacy.entries !== 0) fail("migration base must be the complete healthy zero-entry v1 snapshot");
  await readLegacyZeroCatalog(baseRoot);
  const candidate = await readCatalogV2(candidateRoot, "migration candidate v2");
  if (candidate.entries.size !== 0 || candidate.previews.size !== 0 || candidate.retired.size !== RETIRED_FLOOR_IDENTITIES.length) {
    fail("migration candidate must have zero entries/previews and exactly the retired trust floor");
  }
  if ([...candidate.retired.keys()].some((identity, index) => identity !== RETIRED_FLOOR_IDENTITIES[index])) fail("migration retired ledger has unexpected identities/order");
  await validateFullRepositoryV2(candidateRoot);
  return { ...tree, active: 0, withdrawn: 0, retired: candidate.retired.size };
}

export const RETIRED_RELEASE_FLOOR = RETIRED_FLOOR_IDENTITIES;
export const __test = Object.freeze({
  parseCatalogEnvelope, parsePreviewManifest, parsePreviewEntry, parseRetired,
  immutableProjection, expectedImmutableEntrySha256, CODE_LICENSES, CONTENT_LICENSES,
  verifyArchive, verifyPreview, hashGitBlobStream,
});
