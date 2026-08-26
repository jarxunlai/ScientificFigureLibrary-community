import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { canonicalJson } from "../scripts/stream-validation-lib.mjs";
import { __test as v2Test, RETIRED_RELEASE_FLOOR } from "../scripts/catalog-v2-validation-lib.mjs";

export const root = path.resolve(import.meta.dirname, "..");
export const providerId = "io.github.jarxunlai.scientific-figure-community";
export const archiveRepository = "jarxunlai/ScientificFigureLibrary-community-archives";
export const provider = Object.freeze({
  providerId,
  displayName: "Scientific Figure Library Community",
  catalogRepository: "jarxunlai/ScientificFigureLibrary-community",
  archiveRepository,
});

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function git(repository, args, { input, encoding = "utf8", allowFailure = false } = {}) {
  const result = spawnSync("git", ["-c", `safe.directory=${repository.replaceAll("\\", "/")}`, "-C", repository, ...args], {
    input, encoding, maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`test git failed: ${args.join(" ")}\n${String(result.stderr)}`);
  return result;
}

export async function initRepository(directory) {
  await fs.mkdir(directory, { recursive: true });
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.name", "SFL Test"]);
  git(directory, ["config", "user.email", "sfl-test@example.invalid"]);
}

export async function commitAll(directory, message) {
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-q", "-m", message]);
  return git(directory, ["rev-parse", "HEAD"]).stdout.trim();
}

export async function write(directory, relativePath, value) {
  const target = path.join(directory, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

export async function writeCanonical(directory, relativePath, value) {
  await write(directory, relativePath, `${canonicalJson(value)}\n`);
}

export async function copyLicenses(directory) {
  for (const name of ["MIT.txt", "Apache-2.0.txt", "BSD-3-Clause.txt", "GPL-3.0.txt", "CC-BY-4.0.txt", "CC0-1.0.txt", "CC-BY-SA-4.0.txt"]) {
    await write(directory, `LICENSES/${name}`, await fs.readFile(path.join(root, "LICENSES", name)));
  }
}

function crc32(...parts) {
  let crc = 0xffffffff;
  for (const part of parts) for (const byte of part) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + payload.byteLength);
  output.writeUInt32BE(payload.byteLength, 0);
  typeBytes.copy(output, 4);
  payload.copy(output, 8);
  output.writeUInt32BE(crc32(typeBytes, payload), 8 + payload.byteLength);
  return output;
}

export function fixturePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", Buffer.from([220, 20, 60, 30, 144, 255])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 1]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function retiredFloor() {
  return RETIRED_RELEASE_FLOOR.map((identity) => {
    const split = identity.lastIndexOf("@");
    return {
      schema: "figure-library.public-retired-release.v2",
      providerId,
      templateId: identity.slice(0, split),
      releaseVersion: identity.slice(split + 1),
    };
  });
}

function jsonl(records) { return records.map((record) => `${canonicalJson(record)}\n`).join(""); }
function payloadIdentity(relativePath, bytes, count) { return { path: relativePath, count, bytes: bytes.byteLength, sha256: sha256(bytes) }; }

export async function writeV2Aggregates(directory, entries, {
  retired = retiredFloor(), generatedAt = "2026-08-25T00:00:00Z",
} = {}) {
  const orderedEntries = [...entries].sort((a, b) => identity(a).localeCompare(identity(b), "en"));
  const previews = orderedEntries.map((entry) => ({
    schema: "figure-library.public-preview-entry.v2", providerId,
    templateId: entry.templateId, releaseVersion: entry.releaseVersion, preview: entry.preview,
  }));
  const orderedRetired = [...retired].sort((a, b) => identity(a).localeCompare(identity(b), "en"));
  const entryBytes = Buffer.from(jsonl(orderedEntries), "utf8");
  const previewBytes = Buffer.from(jsonl(previews), "utf8");
  const retiredBytes = Buffer.from(jsonl(orderedRetired), "utf8");
  const entryIdentity = payloadIdentity("catalog/entries.jsonl", entryBytes, orderedEntries.length);
  const previewIdentity = payloadIdentity("catalog/previews.jsonl", previewBytes, previews.length);
  const retiredIdentity = payloadIdentity("catalog/retired-releases.jsonl", retiredBytes, orderedRetired.length);
  const previewManifest = { schema: "figure-library.public-preview-manifest.v2", providerId, previews: previewIdentity };
  const previewManifestBytes = Buffer.from(`${canonicalJson(previewManifest)}\n`, "utf8");
  const catalog = {
    schema: "figure-library.public-provider-catalog.v2", provider, generatedAt,
    entries: entryIdentity, previews: previewIdentity, retiredReleases: retiredIdentity,
    previewManifest: { path: "catalog/preview-manifest.json", bytes: previewManifestBytes.byteLength, sha256: sha256(previewManifestBytes) },
  };
  await write(directory, "catalog/entries.jsonl", entryBytes);
  await write(directory, "catalog/previews.jsonl", previewBytes);
  await write(directory, "catalog/retired-releases.jsonl", retiredBytes);
  await write(directory, "catalog/preview-manifest.json", previewManifestBytes);
  await writeCanonical(directory, "catalog/catalog.json", catalog);
  return { catalog, previews };
}

export async function createV2Repository(directory, { entries = [], retired = retiredFloor(), generatedAt } = {}) {
  await initRepository(directory);
  await write(directory, "catalog/entries/.gitkeep", "");
  await write(directory, "catalog/thumbs/.gitkeep", "");
  await write(directory, "reviews/.gitkeep", "");
  await write(directory, "withdrawals/.gitkeep", "");
  await copyLicenses(directory);
  await writeV2Aggregates(directory, entries, { retired, generatedAt });
  return commitAll(directory, "v2 base");
}

export async function createV1ZeroRepository(directory) {
  await initRepository(directory);
  await writeCanonical(directory, "catalog/catalog.json", {
    schema: "figure-library.public-provider-catalog.v1", provider,
    generatedAt: "2026-08-24T09:33:28Z", entries: [],
  });
  await writeCanonical(directory, "catalog/preview-manifest.json", {
    schema: "figure-library.public-preview-manifest.v1", providerId, entries: [],
  });
  await write(directory, "catalog/entries/.gitkeep", "");
  await write(directory, "thumbs/.gitkeep", "");
  await write(directory, "reviews/.gitkeep", "");
  await copyLicenses(directory);
  return commitAll(directory, "v1 zero base");
}

export async function cloneRepositoryFiles(source, destination) {
  await fs.cp(source, destination, { recursive: true, filter: (item) => path.basename(item) !== ".git" });
  await initRepository(destination);
  await commitAll(destination, "candidate base");
}

export function identity(value) { return `${value.templateId}@${value.releaseVersion}`; }

export function makeEntry({
  templateId = "example-template", releaseVersion = "1.0.0", archive,
  previewBytes = fixturePng(), language = "R", publicAssetKind = "plot_template",
  inputFiles = ["payload/data/data.csv"], releaseState = "active", withdrawal = null,
} = {}) {
  const preview = {
    path: `catalog/thumbs/${templateId}/${releaseVersion}.png`, bytes: previewBytes.byteLength,
    sha256: sha256(previewBytes), mediaType: "image/png", width: 2, height: 1,
    canonicalRgbaSha256: "a367b8fdec8d168420309e8c4a325f82a58aaa55d183b81fa4062ec5aab93c42",
  };
  const entry = {
    schema: "figure-library.public-template-entry.v2", providerId,
    templateId, releaseVersion, contentDigest: sha256(Buffer.from(`content:${templateId}:${releaseVersion}`)),
    immutableEntrySha256: "0".repeat(64), publicAssetKind, language,
    title: `Example ${templateId}`, description: "Product-neutral synthetic validation fixture.",
    search: {
      application: "Policy validation", dataProfile: inputFiles.length ? "Synthetic data" : "No data required",
      plotFamily: "example", tags: ["example"], packages: [],
      codeFiles: [language === "R" ? "payload/code/render.R" : "payload/code/render.py"], inputFiles,
    },
    archive,
    preview,
    status: {
      upstreamStatus: "published", publisherVerified: true, curationStatus: "curated",
      renderValidation: "ci_rendered", localReviewStatus: "not_reviewed", plotExecutionByRecipient: "not_run",
    },
    licenses: {
      code: "MIT", syntheticData: inputFiles.length ? "CC0-1.0" : null,
      preview: "CC-BY-4.0", documentation: null,
    },
    provenance: [{ type: "note", value: "Synthetic policy fixture." }],
    releaseState, withdrawal,
  };
  entry.immutableEntrySha256 = v2Test.expectedImmutableEntrySha256(entry);
  return { entry, previewBytes };
}

export function activeReview(entry) {
  return [
    `# Community review: ${entry.templateId} ${entry.releaseVersion}`,
    "",
    `- Archive merge commit: \`${entry.archive.commit}\``,
    `- Archive SHA-256: \`${entry.archive.sha256}\``,
    `- Content digest: \`${entry.contentDigest}\``,
    `- Public asset kind: ${entry.publicAssetKind}`,
    `- Language: ${entry.language}`,
    "- Code execution by SFL client: false",
    "",
  ].join("\n");
}

export async function archiveFixture(directory, templateId = "example-template", releaseVersion = "1.0.0") {
  const bytes = Buffer.from(`immutable archive ${templateId}@${releaseVersion}\n`, "utf8");
  const relativePath = `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`;
  if (!await fs.stat(directory).then(() => true, () => false)) await initRepository(directory);
  await write(directory, relativePath, bytes);
  const commit = await commitAll(directory, `archive ${templateId}`);
  return { repository: archiveRepository, commit, path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

export async function installEntry(directory, entry, previewBytes) {
  await writeCanonical(directory, `catalog/entries/${entry.templateId}/${entry.releaseVersion}.json`, entry);
  await write(directory, entry.preview.path, previewBytes);
  await write(directory, `reviews/${entry.templateId}/${entry.releaseVersion}.md`, activeReview(entry));
}

export async function makeTemp(prefix) { return fs.mkdtemp(path.join(os.tmpdir(), prefix)); }
export async function cleanup(directory) { await fs.rm(directory, { recursive: true, force: true }); }
