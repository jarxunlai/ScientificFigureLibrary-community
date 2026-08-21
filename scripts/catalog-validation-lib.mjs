import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { compareRepositoryTrees, validatePortableRepositoryPath } from "./validate-pr-trees.mjs";

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
const PRIVATE_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s"'`(=])\/(?:Users|home|mnt\/[A-Za-z]|private|var\/folders|tmp|etc|opt|root|srv|Volumes|workspace|data)\/)/mu;
const RFC3339 = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
const MAX_RGBA_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REQUIRED_ENTRY_KEYS = [
  "archive", "contentDigest", "description", "licenses", "preview", "provenance", "providerId",
  "releaseVersion", "schema", "search", "status", "templateId", "title",
];
const REQUIRED_SEARCH_KEYS = ["application", "codeFiles", "dataProfile", "inputFiles", "language", "packages", "plotFamily", "tags"];
const REQUIRED_STATUS_KEYS = [
  "curationStatus", "localReviewStatus", "plotExecutionByRecipient", "publisherVerified", "renderValidation", "upstreamStatus",
];

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, expected, label) {
  assertRecord(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must use the fixed keys ${wanted.join(", ")}; got ${actual.join(", ")}`);
  }
}

function assertString(value, label, maximum, { nonEmpty = true, publicText = true } = {}) {
  if (typeof value !== "string" || value.length > maximum || (nonEmpty && !value.trim())) {
    fail(`${label} must be ${nonEmpty ? "non-empty " : ""}text of at most ${maximum} characters`);
  }
  if (value.normalize("NFC") !== value) fail(`${label} must be NFC-normalized`);
  if (publicText && PRIVATE_PATH.test(value)) fail(`${label} contains an absolute/private machine path`);
  return value;
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${label} must be a lowercase SHA-256`);
  return value;
}

function assertPositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) fail(`${label} is outside the allowed range`);
  return value;
}

function canonical(value, stack = new Set()) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") fail(`canonical JSON contains unsupported type ${typeof value}`);
  if (stack.has(value)) fail("canonical JSON contains a cycle");
  stack.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, stack)).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], stack)}`).join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

async function readUtf8(filePath, maximum, label) {
  const bytes = await fs.readFile(filePath);
  if (bytes.byteLength > maximum) fail(`${label} exceeds ${maximum} bytes`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not UTF-8`);
  }
  return { bytes, text };
}

async function readJson(filePath, label, canonicalBytes = false) {
  const { bytes, text } = await readUtf8(filePath, MAX_JSON_BYTES, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
  if (canonicalBytes && text !== `${canonical(value)}\n`) fail(`${label} is not canonical JSON with one LF terminator`);
  return { bytes, text, value };
}

function assertPortablePayloadPath(value, label, requiredPrefix) {
  const text = assertString(value, label, 1_000);
  validatePortableRepositoryPath(text);
  if (!text.startsWith(requiredPrefix)) fail(`${label} must stay under ${requiredPrefix}`);
  return text;
}

function assertSortedUniqueStringArray(value, label, maximumEntries, maximumString, pathPrefix) {
  if (!Array.isArray(value) || value.length > maximumEntries) fail(`${label} must be a bounded array`);
  const result = value.map((item, index) => pathPrefix
    ? assertPortablePayloadPath(item, `${label}[${index}]`, pathPrefix)
    : assertString(item, `${label}[${index}]`, maximumString));
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  const sorted = [...result].sort();
  if (sorted.some((item, index) => item !== result[index])) fail(`${label} must be canonically sorted`);
  return result;
}

function parseEntry(value, label) {
  assertExactKeys(value, REQUIRED_ENTRY_KEYS, label);
  if (value.schema !== "figure-library.public-template-entry.v1") fail(`${label}.schema is invalid`);
  if (value.providerId !== PROVIDER_ID) fail(`${label}.providerId is invalid`);
  const templateId = assertString(value.templateId, `${label}.templateId`, 128);
  const releaseVersion = assertString(value.releaseVersion, `${label}.releaseVersion`, 100);
  if (!TEMPLATE_ID.test(templateId)) fail(`${label}.templateId is invalid`);
  if (!SEMVER.test(releaseVersion)) fail(`${label}.releaseVersion is not strict SemVer`);
  assertHash(value.contentDigest, `${label}.contentDigest`);
  assertString(value.title, `${label}.title`, 300);
  assertString(value.description, `${label}.description`, 4_000);

  assertExactKeys(value.search, REQUIRED_SEARCH_KEYS, `${label}.search`);
  assertString(value.search.application, `${label}.search.application`, 4_000, { nonEmpty: false });
  assertString(value.search.dataProfile, `${label}.search.dataProfile`, 4_000, { nonEmpty: false });
  assertString(value.search.plotFamily, `${label}.search.plotFamily`, 200);
  assertString(value.search.language, `${label}.search.language`, 100);
  assertSortedUniqueStringArray(value.search.tags, `${label}.search.tags`, 10_000, 100);
  assertSortedUniqueStringArray(value.search.packages, `${label}.search.packages`, 10_000, 200);
  const codeFiles = assertSortedUniqueStringArray(value.search.codeFiles, `${label}.search.codeFiles`, 10_000, 1_000, "payload/code/");
  const inputFiles = assertSortedUniqueStringArray(value.search.inputFiles, `${label}.search.inputFiles`, 10_000, 1_000, "payload/data/");
  if (!codeFiles.length || !codeFiles.includes("payload/code/render.R")) fail(`${label}.search.codeFiles must bind payload/code/render.R`);
  if (!inputFiles.length) fail(`${label}.search.inputFiles must bind synthetic data`);

  assertExactKeys(value.archive, ["bytes", "commit", "path", "repository", "sha256"], `${label}.archive`);
  if (value.archive.repository !== ARCHIVE_REPOSITORY) fail(`${label}.archive.repository is not the fixed central Archives repository`);
  if (typeof value.archive.commit !== "string" || !COMMIT.test(value.archive.commit)) fail(`${label}.archive.commit must be 40-hex`);
  const expectedArchivePath = `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`;
  if (value.archive.path !== expectedArchivePath) fail(`${label}.archive.path must be ${expectedArchivePath}`);
  assertPositiveInteger(value.archive.bytes, `${label}.archive.bytes`, MAX_ARCHIVE_BYTES);
  assertHash(value.archive.sha256, `${label}.archive.sha256`);

  assertExactKeys(value.preview, ["bytes", "canonicalRgbaSha256", "height", "mediaType", "path", "sha256", "width"], `${label}.preview`);
  const expectedPreviewPath = `thumbs/${templateId}/${releaseVersion}.png`;
  if (value.preview.path !== expectedPreviewPath) fail(`${label}.preview.path must be ${expectedPreviewPath}`);
  if (value.preview.mediaType !== "image/png") fail(`${label}.preview.mediaType must be image/png`);
  assertPositiveInteger(value.preview.bytes, `${label}.preview.bytes`, MAX_PREVIEW_BYTES);
  assertPositiveInteger(value.preview.width, `${label}.preview.width`, 16_384);
  assertPositiveInteger(value.preview.height, `${label}.preview.height`, 16_384);
  if (value.preview.width * value.preview.height * 4 > MAX_RGBA_BYTES) fail(`${label}.preview canonical RGBA is too large`);
  assertHash(value.preview.sha256, `${label}.preview.sha256`);
  assertHash(value.preview.canonicalRgbaSha256, `${label}.preview.canonicalRgbaSha256`);

  assertExactKeys(value.status, REQUIRED_STATUS_KEYS, `${label}.status`);
  if (
    value.status.upstreamStatus !== "published" || typeof value.status.publisherVerified !== "boolean" ||
    value.status.curationStatus !== "curated" || value.status.renderValidation !== "ci_rendered" ||
    value.status.localReviewStatus !== "not_reviewed" || value.status.plotExecutionByRecipient !== "not_run"
  ) fail(`${label}.status must be the fixed six-field central curated/CI-rendered status`);

  assertExactKeys(value.licenses, ["code", "content", "documentation"], `${label}.licenses`);
  if (
    value.licenses.code !== "MIT" || value.licenses.content !== "CC-BY-4.0" ||
    value.licenses.documentation !== "CC-BY-4.0"
  ) fail(`${label}.licenses must be MIT / CC-BY-4.0 / CC-BY-4.0`);

  if (!Array.isArray(value.provenance) || value.provenance.length > 1_000) fail(`${label}.provenance must be a bounded array`);
  for (const [index, item] of value.provenance.entries()) {
    assertExactKeys(item, ["type", "value"], `${label}.provenance[${index}]`);
    if (!["doi", "url", "inspiration", "note"].includes(item.type)) fail(`${label}.provenance[${index}].type is invalid`);
    assertString(item.value, `${label}.provenance[${index}].value`, 4_000);
  }
  return value;
}

function parseCatalog(value, label) {
  assertExactKeys(value, ["entries", "generatedAt", "provider", "schema"], label);
  if (value.schema !== "figure-library.public-provider-catalog.v1") fail(`${label}.schema is invalid`);
  assertExactKeys(value.provider, ["archiveRepository", "catalogRepository", "displayName", "providerId"], `${label}.provider`);
  if (
    value.provider.providerId !== PROVIDER_ID || value.provider.displayName !== "Scientific Figure Library Community" ||
    value.provider.catalogRepository !== CATALOG_REPOSITORY || value.provider.archiveRepository !== ARCHIVE_REPOSITORY
  ) fail(`${label}.provider is not the fixed central Provider`);
  if (typeof value.generatedAt !== "string" || !RFC3339.test(value.generatedAt) || Number.isNaN(Date.parse(value.generatedAt))) {
    fail(`${label}.generatedAt must be a UTC RFC 3339 timestamp`);
  }
  if (!Array.isArray(value.entries) || value.entries.length > 100_000) fail(`${label}.entries must be a bounded array`);
  const entries = value.entries.map((entry, index) => parseEntry(entry, `${label}.entries[${index}]`));
  let prior = "";
  const identities = new Set();
  for (const entry of entries) {
    const identity = `${entry.templateId}@${entry.releaseVersion}`;
    if (identities.has(identity) || (prior && identity <= prior)) fail(`${label}.entries are duplicated or not canonically ordered at ${identity}`);
    identities.add(identity);
    prior = identity;
  }
  return value;
}

function previewManifestEntry(entry) {
  return { templateId: entry.templateId, releaseVersion: entry.releaseVersion, ...entry.preview };
}

function parseManifest(value, catalog, label) {
  assertExactKeys(value, ["entries", "providerId", "schema"], label);
  if (value.schema !== "figure-library.public-preview-manifest.v1" || value.providerId !== PROVIDER_ID || !Array.isArray(value.entries)) {
    fail(`${label} has the wrong fixed identity`);
  }
  const expected = catalog.entries.map(previewManifestEntry);
  if (canonical(value.entries) !== canonical(expected)) fail(`${label}.entries must exactly mirror Catalog previews in canonical order`);
  return value;
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
}
const CRC_TABLE = crcTable();

function crc32(...parts) {
  let crc = 0xffffffff;
  for (const part of parts) for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const p = left + above - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - above);
  const pc = Math.abs(p - upperLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
}

export function decodeCanonicalPng(bytes, label = "thumbnail") {
  const input = Buffer.from(bytes);
  if (input.byteLength > MAX_PREVIEW_BYTES || input.byteLength < 57 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`${label} is not a bounded PNG`);
  }
  let offset = 8;
  let ihdr;
  let palette;
  let transparency;
  const idat = [];
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  while (offset < input.byteLength) {
    if (offset + 12 > input.byteLength) fail(`${label} has a truncated PNG chunk`);
    const length = input.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > input.byteLength) fail(`${label} has a truncated PNG chunk payload`);
    const typeBytes = input.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) fail(`${label} has a non-letter PNG chunk type`);
    const data = input.subarray(offset + 8, offset + 8 + length);
    if (input.readUInt32BE(offset + 8 + length) !== crc32(typeBytes, data)) fail(`${label} has a PNG CRC mismatch in ${type}`);
    if (!["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type)) fail(`${label} has forbidden text/EXIF/ancillary/unknown PNG chunk ${type}`);
    if (type === "IHDR") {
      if (offset !== 8 || ihdr || length !== 13) fail(`${label} has a non-canonical IHDR`);
      ihdr = Buffer.from(data);
    } else if (type === "PLTE") {
      if (!ihdr || palette || sawIdat || length < 3 || length > 768 || length % 3 !== 0) fail(`${label} has a non-canonical PLTE`);
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      if (!ihdr || !palette || transparency || sawIdat || length === 0 || length > palette.byteLength / 3) {
        fail(`${label} has a non-canonical indexed tRNS`);
      }
      transparency = Buffer.from(data);
    } else if (type === "IDAT") {
      if (!ihdr || sawIdat || endedIdat || sawIend || length === 0) fail(`${label} must have exactly one non-empty IDAT chunk`);
      sawIdat = true;
      idat.push(Buffer.from(data));
    } else {
      if (!ihdr || !sawIdat || sawIend || length !== 0) fail(`${label} has a non-canonical IEND`);
      sawIend = true;
    }
    if (sawIdat && type !== "IDAT" && type !== "IEND") endedIdat = true;
    offset = end;
    if (sawIend && offset !== input.byteLength) fail(`${label} has bytes or chunks after IEND`);
  }
  if (!ihdr || !sawIdat || !sawIend) fail(`${label} is missing required PNG chunks`);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (
    !width || !height || width > 16_384 || height > 16_384 || width * height * 4 > MAX_RGBA_BYTES ||
    bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(colorType) || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] !== 0
  ) fail(`${label} uses an unsupported/non-canonical PNG IHDR`);
  if ((colorType === 3) !== Boolean(palette) || (transparency && colorType !== 3)) fail(`${label} palette/transparency presence does not match indexed color type`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  const rowBytes = width * channels;
  const expectedInflated = height * (rowBytes + 1);
  let inflated;
  let consumed;
  try {
    const result = inflateSync(Buffer.concat(idat), { info: true, maxOutputLength: expectedInflated });
    inflated = result.buffer;
    consumed = result.engine.bytesWritten;
  } catch {
    fail(`${label} has invalid or oversized PNG compressed data`);
  }
  const compressedBytes = idat.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (inflated.byteLength !== expectedInflated || consumed !== compressedBytes) fail(`${label} PNG compressed stream has trailing or missing data`);
  const rgba = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset++];
    if (filter > 4) fail(`${label} has an invalid PNG filter`);
    const raw = inflated.subarray(sourceOffset, sourceOffset + rowBytes);
    sourceOffset += rowBytes;
    const row = Buffer.alloc(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= channels ? row[index - channels] : 0;
      const above = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3
        ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      row[index] = (raw[index] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      if (colorType === 0) rgba.fill(row[source], target, target + 3);
      else if (colorType === 2) row.copy(rgba, target, source, source + 3);
      else if (colorType === 3) {
        const index = row[source];
        if (index * 3 + 2 >= palette.byteLength) fail(`${label} references a missing palette entry`);
        palette.copy(rgba, target, index * 3, index * 3 + 3);
      } else if (colorType === 4) rgba.fill(row[source], target, target + 3);
      else row.copy(rgba, target, source, source + 4);
      rgba[target + 3] = colorType === 3 && transparency && row[source] < transparency.byteLength
        ? transparency[row[source]]
        : colorType === 4 ? row[source + 1] : colorType === 6 ? row[source + 3] : 255;
    }
    previous = row;
  }
  return { width, height, rgba, sha256: sha256(input), canonicalRgbaSha256: sha256(rgba), bytes: input.byteLength };
}

function runGit(repository, args, { allowFailure = false, encoding = null, maxBuffer = 128 * 1024 * 1024 } = {}) {
  const safeRoot = path.resolve(repository).replaceAll("\\", "/");
  const result = spawnSync("git", ["-c", `safe.directory=${safeRoot}`, "-C", repository, ...args], { encoding, maxBuffer, windowsHide: true });
  if (!allowFailure && (result.error || result.status !== 0)) fail(`trusted archive git ${args.slice(0, 4).join(" ")} failed`);
  return result;
}

function verifyArchive(archivesRoot, entry) {
  const ancestor = runGit(archivesRoot, ["merge-base", "--is-ancestor", entry.archive.commit, "HEAD"], { allowFailure: true });
  if (ancestor.error || ancestor.status !== 0) fail("entry.archive.commit is not an ancestor of fixed Archives main");
  const result = runGit(archivesRoot, ["ls-tree", "-z", entry.archive.commit, "--", entry.archive.path]);
  const output = Buffer.from(result.stdout);
  const records = output.subarray(0, output.byteLength && output[output.byteLength - 1] === 0 ? -1 : undefined).toString("utf8");
  const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/u.exec(records);
  if (!match || match[2] !== entry.archive.path) fail("entry.archive.path is not one exact 100644 blob at the fixed commit");
  const blob = runGit(archivesRoot, ["cat-file", "blob", match[1]]).stdout;
  if (blob.byteLength !== entry.archive.bytes || sha256(blob) !== entry.archive.sha256) {
    fail("entry.archive bytes/SHA-256 do not match the fixed Archives commit/path blob");
  }
  return `https://raw.githubusercontent.com/${ARCHIVE_REPOSITORY}/${entry.archive.commit}/${entry.archive.path}`;
}

async function verifyPreview(candidateRoot, entry) {
  const previewPath = path.join(candidateRoot, ...entry.preview.path.split("/"));
  const bytes = await fs.readFile(previewPath);
  const decoded = decodeCanonicalPng(bytes, `thumbnail ${entry.templateId}@${entry.releaseVersion}`);
  if (
    decoded.bytes !== entry.preview.bytes || decoded.sha256 !== entry.preview.sha256 ||
    decoded.width !== entry.preview.width || decoded.height !== entry.preview.height ||
    decoded.canonicalRgbaSha256 !== entry.preview.canonicalRgbaSha256
  ) fail(`thumbnail identity or canonical RGBA digest mismatch: ${entry.templateId}@${entry.releaseVersion}`);
}

async function verifyReview(candidateRoot, entry) {
  const reviewPath = path.join(candidateRoot, "reviews", entry.templateId, `${entry.releaseVersion}.md`);
  const { text } = await readUtf8(reviewPath, 64 * 1024, `review ${entry.templateId}@${entry.releaseVersion}`);
  if (PRIVATE_PATH.test(text) || text.includes("\r")) fail("review contains a private path or non-canonical line endings");
  const archivePr = `https://github\\.com/${escapeRegex(ARCHIVE_REPOSITORY)}/pull/([1-9][0-9]*)`;
  const validationRun = `https://github\\.com/${escapeRegex(ARCHIVE_REPOSITORY)}/actions/runs/([1-9][0-9]*)`;
  const pattern = new RegExp(
    `^# Community review: ${escapeRegex(entry.templateId)} ${escapeRegex(entry.releaseVersion)}\\n\\n` +
    `- Archive PR: (${archivePr})\\n` +
    "- Archive merge commit: `" + entry.archive.commit + "`\\n" +
    "- Archive path: `" + escapeRegex(entry.archive.path) + "`\\n" +
    `- Archive bytes: ${entry.archive.bytes}\\n` +
    "- Archive SHA-256: `" + entry.archive.sha256 + "`\\n" +
    "- Content digest: `" + entry.contentDigest + "`\\n" +
    `- Fixed-render CI run: (${validationRun})\\n` +
    `- Publisher identity matched GitHub author: ${entry.status.publisherVerified ? "yes" : "no"}\\n` +
    "- Archive render gate: passed before manual Archive merge\\n" +
    "- Catalog curation gate: pending manual review of this PR\\n" +
    "- Recipient local review: not reviewed\\n" +
    "- Code execution by SFL client: false\\n$",
    "u",
  );
  if (!pattern.test(text)) fail(`review does not have the fixed identity/digest/URL format: ${entry.templateId}@${entry.releaseVersion}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function mapEntries(catalog) {
  return new Map(catalog.entries.map((entry) => [`${entry.templateId}@${entry.releaseVersion}`, entry]));
}

export async function validatePublicationCandidate({ baseRoot, candidateRoot, archivesRoot }) {
  const tree = compareRepositoryTrees(baseRoot, candidateRoot);
  const [baseCatalogFile, candidateCatalogFile, baseManifestFile, candidateManifestFile, standaloneFile] = await Promise.all([
    readJson(path.join(baseRoot, "catalog", "catalog.json"), "trusted base Catalog"),
    readJson(path.join(candidateRoot, "catalog", "catalog.json"), "candidate Catalog", true),
    readJson(path.join(baseRoot, "catalog", "preview-manifest.json"), "trusted base preview manifest"),
    readJson(path.join(candidateRoot, "catalog", "preview-manifest.json"), "candidate preview manifest", true),
    readJson(path.join(candidateRoot, ...tree.entryPath.split("/")), "candidate standalone entry", true),
  ]);
  const baseCatalog = parseCatalog(baseCatalogFile.value, "trusted base Catalog");
  const candidateCatalog = parseCatalog(candidateCatalogFile.value, "candidate Catalog");
  const baseManifest = parseManifest(baseManifestFile.value, baseCatalog, "trusted base preview manifest");
  const candidateManifest = parseManifest(candidateManifestFile.value, candidateCatalog, "candidate preview manifest");
  const standalone = parseEntry(standaloneFile.value, "candidate standalone entry");
  if (standalone.templateId !== tree.templateId || standalone.releaseVersion !== tree.releaseVersion) {
    fail("outer standalone entry path and inner identity do not match");
  }
  const baseEntries = mapEntries(baseCatalog);
  const candidateEntries = mapEntries(candidateCatalog);
  const newIdentity = `${tree.templateId}@${tree.releaseVersion}`;
  if (
    candidateEntries.size !== baseEntries.size + 1 || baseEntries.has(newIdentity) ||
    !candidateEntries.has(newIdentity) || canonical(candidateEntries.get(newIdentity)) !== canonical(standalone)
  ) fail("candidate Catalog must append exactly the new standalone release identity");
  for (const [identity, prior] of baseEntries) {
    const next = candidateEntries.get(identity);
    if (!next || canonical(next) !== canonical(prior)) fail(`candidate Catalog changed or withdrew immutable release ${identity}`);
  }
  if (canonical(candidateCatalog.provider) !== canonical(baseCatalog.provider)) fail("candidate changed the immutable Provider identity");
  if (
    candidateManifest.entries.length !== baseManifest.entries.length + 1 ||
    canonical(candidateManifest.entries.filter((item) => `${item.templateId}@${item.releaseVersion}` !== newIdentity)) !== canonical(baseManifest.entries)
  ) fail("candidate preview manifest is not an append-only extension of the trusted base");
  const manifestNew = candidateManifest.entries.find((item) => `${item.templateId}@${item.releaseVersion}` === newIdentity);
  if (!manifestNew || canonical(manifestNew) !== canonical(previewManifestEntry(standalone))) {
    fail("outer thumbnail, standalone entry, Catalog, and preview manifest identities are not exactly bound");
  }
  const rawUrl = verifyArchive(archivesRoot, standalone);
  await verifyPreview(candidateRoot, standalone);
  await verifyReview(candidateRoot, standalone);
  return { ...tree, archiveRawUrl: rawUrl, archiveCommit: standalone.archive.commit };
}

export async function validateFullRepository(repositoryRoot) {
  const catalogFile = await readJson(path.join(repositoryRoot, "catalog", "catalog.json"), "repository Catalog");
  const manifestFile = await readJson(path.join(repositoryRoot, "catalog", "preview-manifest.json"), "repository preview manifest");
  const catalogValue = parseCatalog(catalogFile.value, "repository Catalog");
  parseManifest(manifestFile.value, catalogValue, "repository preview manifest");
  const expectedEntryFiles = new Set(["catalog/entries/.gitkeep"]);
  const expectedPreviewFiles = new Set(["thumbs/.gitkeep"]);
  const expectedReviewFiles = new Set(["reviews/.gitkeep"]);
  for (const entry of catalogValue.entries) {
    expectedEntryFiles.add(`catalog/entries/${entry.templateId}/${entry.releaseVersion}.json`);
    expectedPreviewFiles.add(entry.preview.path);
    expectedReviewFiles.add(`reviews/${entry.templateId}/${entry.releaseVersion}.md`);
  }
  for (const [directory, expected] of [
    ["catalog/entries", expectedEntryFiles],
    ["thumbs", expectedPreviewFiles],
    ["reviews", expectedReviewFiles],
  ]) {
    const observed = await inventoryDirectory(repositoryRoot, directory);
    if (observed.size !== expected.size || [...expected].some((filePath) => !observed.has(filePath))) {
      fail(`${directory} contains an orphan, missing, or non-canonical release file`);
    }
  }
  for (const entry of catalogValue.entries) {
    const standaloneFile = await readJson(
      path.join(repositoryRoot, "catalog", "entries", entry.templateId, `${entry.releaseVersion}.json`),
      `standalone entry ${entry.templateId}@${entry.releaseVersion}`,
    );
    if (canonical(standaloneFile.value) !== canonical(entry)) fail(`repository standalone entry differs from aggregate: ${entry.templateId}@${entry.releaseVersion}`);
    await verifyPreview(repositoryRoot, entry);
    await verifyReview(repositoryRoot, entry);
  }
  for (const [licensePath, requiredText] of [
    ["LICENSES/MIT.txt", "MIT License"],
    ["LICENSES/CC-BY-4.0.txt", "Creative Commons Attribution 4.0 International Public License"],
  ]) {
    const { text } = await readUtf8(path.join(repositoryRoot, ...licensePath.split("/")), 128 * 1024, licensePath);
    const minimum = licensePath.endsWith("MIT.txt") ? 500 : 10_000;
    if (!text.includes(requiredText) || text.length <= minimum) fail(`${licensePath} is not the required complete license text`);
  }
  return { entries: catalogValue.entries.length };
}

async function inventoryDirectory(repositoryRoot, relativeDirectory) {
  const root = path.join(repositoryRoot, ...relativeDirectory.split("/"));
  const output = new Set();
  const folded = new Map();
  const walk = async (directory, relative) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const filePath = `${relative}/${entry.name}`;
      validatePortableRepositoryPath(filePath);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`release inventory contains a symlink: ${filePath}`);
      if (entry.isDirectory()) await walk(absolute, filePath);
      else if (entry.isFile()) {
        const key = filePath.normalize("NFC").toLocaleLowerCase("en-US");
        const prior = folded.get(key);
        if (prior && prior !== filePath) fail(`release inventory contains a Windows case-fold collision: ${prior} <> ${filePath}`);
        folded.set(key, filePath);
        output.add(filePath);
      } else fail(`release inventory contains a non-file: ${filePath}`);
    }
  };
  await walk(root, relativeDirectory);
  return output;
}

export const __test = { canonical, crc32, parseEntry, parseCatalog, parseManifest, verifyArchive, PRIVATE_PATH };
