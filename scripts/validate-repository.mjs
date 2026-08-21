import fs from "node:fs/promises";
import path from "node:path";

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(import.meta.dirname, "..");
const providerId = "io.github.jarxunlai.scientific-figure-community";
const hash = /^[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const templateId = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const semverIdentifier = "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const semver = new RegExp(
  `^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)` +
    `(?:-${semverIdentifier}(?:\\.${semverIdentifier})*)?` +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
  "u",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const catalogPath = path.join(root, "catalog", "catalog.json");
const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
assert(catalog.schema === "figure-library.public-provider-catalog.v1", "invalid catalog schema");
assert(catalog.provider?.providerId === providerId, "invalid central providerId");
assert(Array.isArray(catalog.entries), "catalog entries must be an array");

const identities = new Set();
const previews = [];
let priorIdentity = "";
for (const entry of catalog.entries) {
  assert(entry.schema === "figure-library.public-template-entry.v1", "invalid entry schema");
  assert(entry.providerId === providerId, "entry provider mismatch");
  assert(templateId.test(entry.templateId), `invalid templateId: ${entry.templateId}`);
  assert(semver.test(entry.releaseVersion), `invalid releaseVersion: ${entry.releaseVersion}`);
  assert(hash.test(entry.contentDigest), `invalid contentDigest: ${entry.templateId}`);
  assert(entry.archive?.repository === "jarxunlai/ScientificFigureLibrary-community-archives", "archive repository mismatch");
  assert(commit.test(entry.archive.commit), `invalid archive commit: ${entry.templateId}`);
  assert(hash.test(entry.archive.sha256), `invalid archive sha256: ${entry.templateId}`);
  assert(Number.isSafeInteger(entry.archive.bytes) && entry.archive.bytes > 0 && entry.archive.bytes <= 100 * 1024 * 1024, `invalid archive bytes: ${entry.templateId}`);
  assert(entry.preview?.mediaType === "image/png", `preview must be PNG: ${entry.templateId}`);
  assert(hash.test(entry.preview.sha256), `invalid preview sha256: ${entry.templateId}`);
  assert(hash.test(entry.preview.canonicalRgbaSha256), `invalid RGBA digest: ${entry.templateId}`);
  assert(entry.status?.upstreamStatus === "published", `invalid upstream status: ${entry.templateId}`);
  assert(typeof entry.status.publisherVerified === "boolean", `invalid publisher verification status: ${entry.templateId}`);
  assert(["curated", "unreviewed"].includes(entry.status.curationStatus), `invalid curation status: ${entry.templateId}`);
  assert(["ci_rendered", "publisher_attested", "unverified"].includes(entry.status.renderValidation), `invalid render validation status: ${entry.templateId}`);
  assert(entry.status.localReviewStatus === "not_reviewed", `central entry must not claim recipient local review: ${entry.templateId}`);
  assert(entry.status.plotExecutionByRecipient === "not_run", `central entry must not claim recipient plot execution: ${entry.templateId}`);
  const identity = `${entry.templateId}@${entry.releaseVersion}`;
  assert(!identities.has(identity), `duplicate release identity: ${identity}`);
  assert(identity.localeCompare(priorIdentity, "en") > 0, `catalog entries are not canonically ordered at ${identity}`);
  priorIdentity = identity;
  identities.add(identity);
  const entryFile = path.join(root, "catalog", "entries", entry.templateId, `${entry.releaseVersion}.json`);
  const standalone = JSON.parse(await fs.readFile(entryFile, "utf8"));
  assert(canonical(standalone) === canonical(entry), `catalog entry differs from ${path.relative(root, entryFile)}`);
  const previewFile = path.join(root, ...entry.preview.path.split("/"));
  const preview = await fs.readFile(previewFile);
  assert(preview.byteLength === entry.preview.bytes, `preview byte length mismatch: ${identity}`);
  assert((await import("node:crypto")).createHash("sha256").update(preview).digest("hex") === entry.preview.sha256, `preview SHA-256 mismatch: ${identity}`);
  assert(preview.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), `preview is not PNG: ${identity}`);
  assert(preview.readUInt32BE(16) === entry.preview.width && preview.readUInt32BE(20) === entry.preview.height, `preview dimensions mismatch: ${identity}`);
  previews.push({
    templateId: entry.templateId,
    releaseVersion: entry.releaseVersion,
    ...entry.preview,
  });
}

const manifest = JSON.parse(await fs.readFile(path.join(root, "catalog", "preview-manifest.json"), "utf8"));
assert(manifest.schema === "figure-library.public-preview-manifest.v1", "invalid preview manifest schema");
assert(manifest.providerId === providerId, "preview manifest provider mismatch");
assert(Array.isArray(manifest.entries), "preview manifest entries must be an array");
assert(manifest.entries.length === catalog.entries.length, "preview manifest and catalog entry counts differ");
assert(canonical(manifest.entries) === canonical(previews), "preview manifest entries disagree with catalog previews");

console.log(`validated ${catalog.entries.length} public catalog entries`);
