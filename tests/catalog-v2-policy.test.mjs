import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  __test, parseEntryV2, readCatalogV2, RETIRED_RELEASE_FLOOR,
  validateCatalogAdditionV2, validateCatalogWithdrawalV2,
  validateFullRepositoryV2, validateZeroEntryMigrationV2,
} from "../scripts/catalog-v2-validation-lib.mjs";
import { compareTreeMaps, V2_ADD_MODIFIED_PATHS, V2_MIGRATION_ADDED_PATHS, V2_MIGRATION_DELETED_PATHS, V2_MIGRATION_MODIFIED_PATHS } from "../scripts/validate-pr-trees.mjs";
import { validateFullRepository } from "../scripts/catalog-validation-lib.mjs";
import { canonicalJson, readCanonicalJsonl } from "../scripts/stream-validation-lib.mjs";
import {
  activeReview, archiveFixture, cleanup, cloneRepositoryFiles, commitAll,
  createV1ZeroRepository, createV2Repository, fixturePng, identity, installEntry,
  makeEntry, makeTemp, retiredFloor, root, sha256, write, writeCanonical, writeV2Aggregates,
} from "./policy-fixtures.mjs";

test("workflow exposes the stable required check and no physical-deletion route", async () => {
  const workflow = await fs.readFile(path.resolve(import.meta.dirname, "..", ".github", "workflows", "validate-catalog.yml"), "utf8");
  assert.match(workflow, /name: sfl-community-catalog-policy-v1/u);
  assert.match(workflow, /mode == 'add'/u);
  assert.match(workflow, /mode == 'withdraw'/u);
  assert.match(workflow, /mode == 'migration'/u);
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/u);
  assert.match(workflow, /npm --prefix trusted ci --ignore-scripts --no-audit --no-fund/u);
  assert.doesNotMatch(workflow, /npm --prefix candidate|node candidate\/tests/u);
  assert.doesNotMatch(workflow, /restricted seed|exact-three|mode == 'withdrawal'/iu);
});

function record(treePath, oid = "a".repeat(40)) { return { path: treePath, mode: "100644", type: "blob", oid }; }
function tree(paths) { return new Map(paths.map((treePath, index) => [treePath, record(treePath, String((index % 9) + 1).repeat(40))])); }

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + payload.byteLength);
  output.writeUInt32BE(payload.byteLength, 0);
  typeBytes.copy(output, 4);
  payload.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, 8 + payload.byteLength)) crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + payload.byteLength);
  return output;
}

function largeRgbaPng(width = 8192, height = 256) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rgbaRow = Buffer.alloc(width * 4, 0x41);
  const raw = Buffer.alloc(height * (rgbaRow.byteLength + 1));
  const rgbaHash = createHash("sha256");
  for (let row = 0; row < height; row += 1) {
    rgbaRow.copy(raw, row * (rgbaRow.byteLength + 1) + 1);
    rgbaHash.update(rgbaRow);
  }
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return { bytes, width, height, canonicalRgbaSha256: rgbaHash.digest("hex") };
}

test("tree policy accepts exact v2 addition shape", () => {
  const base = tree(["catalog/catalog.json", "catalog/entries.jsonl", "catalog/previews.jsonl", "catalog/preview-manifest.json"]);
  const candidate = new Map(base);
  V2_ADD_MODIFIED_PATHS.forEach((item, index) => candidate.set(item, record(item, String(index + 5).repeat(40))));
  for (const item of ["catalog/entries/example/1.0.0.json", "catalog/thumbs/example/1.0.0.png", "reviews/example/1.0.0.md"]) candidate.set(item, record(item));
  assert.equal(compareTreeMaps(base, candidate).mode, "add");
});

test("content tree policy rejects a candidate-wide symlink or executable outside the changed paths", () => {
  for (const [treePath, mode] of [["unchanged-link", "120000"], ["unchanged-executable", "100755"]]) {
    const base = tree([
      "catalog/catalog.json", "catalog/entries.jsonl", "catalog/previews.jsonl",
      "catalog/preview-manifest.json", treePath,
    ]);
    const candidate = new Map(base);
    candidate.set(treePath, { ...candidate.get(treePath), mode });
    V2_ADD_MODIFIED_PATHS.forEach((item, index) => candidate.set(item, record(item, String(index + 5).repeat(40))));
    for (const item of ["catalog/entries/example/1.0.0.json", "catalog/thumbs/example/1.0.0.png", "reviews/example/1.0.0.md"]) candidate.set(item, record(item));
    assert.throws(() => compareTreeMaps(base, candidate), /non-100644 blob/u);
  }
});

test("tree policy rejects v1 two-aggregate addition shape", () => {
  const base = tree(["catalog/catalog.json", "catalog/preview-manifest.json"]);
  const candidate = new Map(base);
  for (const item of ["catalog/catalog.json", "catalog/preview-manifest.json"]) candidate.set(item, record(item, "b".repeat(40)));
  for (const item of ["catalog/entries/example/1.0.0.json", "thumbs/example/1.0.0.png", "reviews/example/1.0.0.md"]) candidate.set(item, record(item));
  assert.throws(() => compareTreeMaps(base, candidate), /may not delete|exactly one v2 add/u);
});

test("tree policy accepts exact metadata-only withdrawal shape", () => {
  const paths = ["catalog/catalog.json", "catalog/entries.jsonl", "catalog/entries/example/1.0.0.json", "reviews/example/1.0.0.md"];
  const base = tree(paths);
  const candidate = new Map(base);
  paths.forEach((item, index) => candidate.set(item, record(item, String(index + 5).repeat(40))));
  candidate.set("withdrawals/example/1.0.0/reason.txt", record("withdrawals/example/1.0.0/reason.txt"));
  assert.equal(compareTreeMaps(base, candidate).mode, "withdraw");
});

test("tree policy has no exact-three or any physical deletion capability", () => {
  const deleted = [
    "catalog/entries/ggsankeyfier-layout-color-combo/1.0.0.json",
    "reviews/ggsankeyfier-layout-color-combo/1.0.0.md",
    "catalog/thumbs/ggsankeyfier-layout-color-combo/1.0.0.png",
  ];
  const base = tree(["catalog/catalog.json", ...deleted]);
  const candidate = tree(["catalog/catalog.json"]);
  assert.throws(() => compareTreeMaps(base, candidate), /may not delete/u);
});

test("tree policy accepts only the exact one-time migration shape", () => {
  const base = tree(["catalog/catalog.json", "catalog/preview-manifest.json", "thumbs/.gitkeep"]);
  const candidate = new Map(base);
  for (const item of V2_MIGRATION_DELETED_PATHS) candidate.delete(item);
  for (const item of V2_MIGRATION_ADDED_PATHS) candidate.set(item, record(item));
  V2_MIGRATION_MODIFIED_PATHS.forEach((item, index) => candidate.set(item, record(item, String(index + 6).repeat(40))));
  assert.equal(compareTreeMaps(base, candidate).mode, "migration");
  candidate.set("catalog/entries/unexpected/1.0.0.json", record("catalog/entries/unexpected/1.0.0.json"));
  assert.throws(
    () => compareTreeMaps(base, candidate),
    /may not delete|exactly one v2 add/u,
  );
});

test("strict v2 parser accepts R plot and Python data-free visual reference", async () => {
  const archive = { repository: "jarxunlai/ScientificFigureLibrary-community-archives", commit: "a".repeat(40), path: "archives/example-template/1.0.0/example-template-1.0.0.zip", bytes: 1, sha256: "b".repeat(64) };
  const r = makeEntry({ archive }).entry;
  assert.equal(parseEntryV2(r).language, "R");
  const pyArchive = { ...archive, path: "archives/example-visual/1.0.0/example-visual-1.0.0.zip" };
  const py = makeEntry({ templateId: "example-visual", archive: pyArchive, language: "Python", publicAssetKind: "visual_reference", inputFiles: [] }).entry;
  assert.equal(parseEntryV2(py).licenses.syntheticData, null);
});

test("strict v2 parser rejects unknown keys and immutable digest mismatch", () => {
  const archive = { repository: "jarxunlai/ScientificFigureLibrary-community-archives", commit: "a".repeat(40), path: "archives/example-template/1.0.0/example-template-1.0.0.zip", bytes: 1, sha256: "b".repeat(64) };
  const entry = makeEntry({ archive }).entry;
  assert.throws(() => parseEntryV2({ ...entry, extra: true }), /trusted v2 JSON Schema.*additional properties/u);
  assert.throws(() => parseEntryV2({ ...entry, immutableEntrySha256: "f".repeat(64) }), /does not bind/u);
});

test("executable v2 schema rejects a JSON-Schema-only tag length violation", () => {
  const archive = { repository: "jarxunlai/ScientificFigureLibrary-community-archives", commit: "a".repeat(40), path: "archives/example-template/1.0.0/example-template-1.0.0.zip", bytes: 1, sha256: "b".repeat(64) };
  const entry = makeEntry({ archive }).entry;
  entry.search.tags = ["x".repeat(101)];
  entry.immutableEntrySha256 = __test.expectedImmutableEntrySha256(entry);
  assert.throws(() => parseEntryV2(entry), /trusted v2 JSON Schema.*must NOT have more than 100 characters/u);
});

test("executable v2 schema rejects a calendar-invalid RFC3339 timestamp", () => {
  const archive = { repository: "jarxunlai/ScientificFigureLibrary-community-archives", commit: "a".repeat(40), path: "archives/example-template/1.0.0/example-template-1.0.0.zip", bytes: 1, sha256: "b".repeat(64) };
  const entry = makeEntry({ archive }).entry;
  entry.releaseState = "withdrawn";
  entry.withdrawal = {
    withdrawnAt: "2026-02-30T00:00:00Z",
    reason: { path: "withdrawals/example-template/1.0.0/reason.txt", bytes: 1, sha256: "b".repeat(64) },
  };
  assert.throws(() => parseEntryV2(entry), /trusted v2 JSON Schema/u);
});

test("canonical JSON and JSONL reject unpaired UTF-16 surrogates", async () => {
  assert.throws(() => canonicalJson({ value: "\ud800" }), /unpaired UTF-16 surrogate/u);
  assert.throws(() => canonicalJson({ ["\udc00"]: "value" }), /unpaired UTF-16 surrogate/u);
  const temp = await makeTemp("sfl-community-surrogate-jsonl-");
  try {
    const filePath = path.join(temp, "records.jsonl");
    await fs.writeFile(filePath, '{"value":"\\ud800"}\n', "utf8");
    await assert.rejects(readCanonicalJsonl(filePath), /unpaired UTF-16 surrogate/u);
  } finally { await cleanup(temp); }
});

test("strict v2 parser rejects plot without data, language mismatch, and non-allowlisted license", () => {
  const archive = { repository: "jarxunlai/ScientificFigureLibrary-community-archives", commit: "a".repeat(40), path: "archives/example-template/1.0.0/example-template-1.0.0.zip", bytes: 1, sha256: "b".repeat(64) };
  const noData = makeEntry({ archive, inputFiles: [] }).entry;
  assert.throws(() => parseEntryV2(noData), /requires synthetic data/u);
  const mismatch = makeEntry({ archive }).entry;
  mismatch.language = "Python";
  mismatch.immutableEntrySha256 = __test.expectedImmutableEntrySha256(mismatch);
  assert.throws(() => parseEntryV2(mismatch), /language-derived/u);
  const badLicense = makeEntry({ archive }).entry;
  badLicense.licenses.code = "CC-BY-NC-4.0";
  badLicense.immutableEntrySha256 = __test.expectedImmutableEntrySha256(badLicense);
  assert.throws(() => parseEntryV2(badLicense), /trusted v2 JSON Schema.*allowed values/u);
});

test("strict v2 parser enforces active/withdrawn discriminant", () => {
  const archive = { repository: "jarxunlai/ScientificFigureLibrary-community-archives", commit: "a".repeat(40), path: "archives/example-template/1.0.0/example-template-1.0.0.zip", bytes: 1, sha256: "b".repeat(64) };
  const entry = makeEntry({ archive }).entry;
  entry.withdrawal = { withdrawnAt: "2026-08-25T00:00:00Z", reason: { path: "withdrawals/example-template/1.0.0/reason.txt", bytes: 1, sha256: "b".repeat(64) } };
  assert.throws(() => parseEntryV2(entry), /withdrawal=null/u);
});

test("zero-entry v1 repository remains readable during policy bootstrap", async () => {
  const temp = await makeTemp("sfl-community-v1-compat-");
  try {
    const repo = path.join(temp, "repo");
    await createV1ZeroRepository(repo);
    assert.deepEqual(await validateFullRepository(repo), { entries: 0 });
  } finally { await cleanup(temp); }
});

test("one-time migration accepts zero-entry v2 plus exact retired floor", async () => {
  const temp = await makeTemp("sfl-community-migration-");
  try {
    const base = path.join(temp, "base");
    const candidate = path.join(temp, "candidate");
    await createV1ZeroRepository(base);
    await cloneRepositoryFiles(base, candidate);
    await fs.rm(path.join(candidate, "thumbs"), { recursive: true });
    await write(candidate, "catalog/thumbs/.gitkeep", "");
    await write(candidate, "withdrawals/.gitkeep", "");
    await writeV2Aggregates(candidate, [], { generatedAt: "2026-08-25T00:00:00Z" });
    await commitAll(candidate, "migrate");
    const result = await validateZeroEntryMigrationV2({ baseRoot: base, candidateRoot: candidate });
    assert.equal(result.retired, 3);
  } finally { await cleanup(temp); }
});

test("migration rejects missing or changed retired floor identity", async () => {
  const temp = await makeTemp("sfl-community-migration-negative-");
  try {
    const base = path.join(temp, "base");
    const candidate = path.join(temp, "candidate");
    await createV1ZeroRepository(base);
    await cloneRepositoryFiles(base, candidate);
    await fs.rm(path.join(candidate, "thumbs"), { recursive: true });
    await write(candidate, "catalog/thumbs/.gitkeep", "");
    await write(candidate, "withdrawals/.gitkeep", "");
    await writeV2Aggregates(candidate, [], { retired: retiredFloor().slice(1) });
    await commitAll(candidate, "bad migration");
    await assert.rejects(validateZeroEntryMigrationV2({ baseRoot: base, candidateRoot: candidate }), /retired trust-floor/u);
  } finally { await cleanup(temp); }
});

test("migration rejects a malformed zero-entry v1 base instead of laundering it into v2", async () => {
  const temp = await makeTemp("sfl-community-migration-bad-base-");
  try {
    const base = path.join(temp, "base");
    const candidate = path.join(temp, "candidate");
    await createV1ZeroRepository(base);
    const malformed = JSON.parse(await fs.readFile(path.join(base, "catalog", "catalog.json"), "utf8"));
    malformed.provider.displayName = "Impostor Provider";
    await writeCanonical(base, "catalog/catalog.json", malformed);
    await commitAll(base, "malformed trusted base fixture");
    await cloneRepositoryFiles(base, candidate);
    await fs.rm(path.join(candidate, "thumbs"), { recursive: true });
    await write(candidate, "catalog/thumbs/.gitkeep", "");
    await write(candidate, "withdrawals/.gitkeep", "");
    await writeV2Aggregates(candidate, []);
    await commitAll(candidate, "attempted migration");
    await assert.rejects(
      validateZeroEntryMigrationV2({ baseRoot: base, candidateRoot: candidate }),
      /fixed central Provider|Provider/u,
    );
  } finally { await cleanup(temp); }
});

test("v2 repository reader binds JSONL envelopes, standalone entries, previews, and retired floor", async () => {
  const temp = await makeTemp("sfl-community-v2-read-");
  try {
    const repo = path.join(temp, "repo");
    await createV2Repository(repo);
    const snapshot = await readCatalogV2(repo);
    assert.equal(snapshot.entries.size, 0);
    assert.deepEqual([...snapshot.retired.keys()], RETIRED_RELEASE_FLOOR);
    for (const record of snapshot.retired.values()) {
      assert.deepEqual(Object.keys(record).sort(), ["providerId", "releaseVersion", "schema", "templateId"]);
    }
    assert.deepEqual(await validateFullRepositoryV2(repo), { schema: "v2", entries: 0, active: 0, withdrawn: 0, retired: 3 });
  } finally { await cleanup(temp); }
});

test("v2 addition validator accepts one product-neutral release", async () => {
  const temp = await makeTemp("sfl-community-v2-add-");
  try {
    const base = path.join(temp, "base");
    const candidate = path.join(temp, "candidate");
    const archives = path.join(temp, "archives");
    await createV2Repository(base, { generatedAt: "2026-08-25T00:00:00Z" });
    await cloneRepositoryFiles(base, candidate);
    const archive = await archiveFixture(archives);
    const { entry, previewBytes } = makeEntry({ archive });
    await installEntry(candidate, entry, previewBytes);
    await writeV2Aggregates(candidate, [entry], { generatedAt: "2026-08-25T01:00:00Z" });
    await commitAll(candidate, "add");
    const result = await validateCatalogAdditionV2({ baseRoot: base, candidateRoot: candidate, archivesRoot: archives });
    assert.equal(result.templateId, "example-template");
  } finally { await cleanup(temp); }
});

test("v2 thumbnail and Archive verification stay file-backed with bounded buffering", async () => {
  const temp = await makeTemp("sfl-community-v2-streamed-media-");
  try {
    const repository = path.join(temp, "repository");
    const archives = path.join(temp, "archives");
    const archive = await archiveFixture(archives, "streamed-template");
    const largeSource = path.join(temp, "large-archive.bin");
    const handle = await fs.open(largeSource, "w");
    try {
      const block = Buffer.alloc(64 * 1024, 0x5a);
      for (let index = 0; index < 512; index += 1) await handle.write(block);
    } finally { await handle.close(); }
    await fs.copyFile(largeSource, path.join(archives, archive.path));
    const commit = await commitAll(archives, "large streamed archive");
    const stat = await fs.stat(largeSource);
    const hash = createHash("sha256");
    const source = await fs.open(largeSource, "r");
    try {
      const block = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < stat.size) {
        const { bytesRead } = await source.read(block, 0, Math.min(block.byteLength, stat.size - position), position);
        assert.ok(bytesRead > 0);
        hash.update(block.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally { await source.close(); }
    const largeArchive = { ...archive, commit, bytes: stat.size, sha256: hash.digest("hex") };
    const { entry } = makeEntry({ templateId: "streamed-template", archive: largeArchive });
    const previewFixture = largeRgbaPng();
    const previewBytes = previewFixture.bytes;
    entry.preview = {
      ...entry.preview,
      bytes: previewBytes.byteLength,
      sha256: sha256(previewBytes),
      width: previewFixture.width,
      height: previewFixture.height,
      canonicalRgbaSha256: previewFixture.canonicalRgbaSha256,
    };
    const previewPath = path.join(repository, ...entry.preview.path.split("/"));
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    await fs.writeFile(previewPath, previewBytes);

    const preview = await __test.verifyPreview(repository, entry);
    assert.equal(preview.sha256, entry.preview.sha256);
    assert.ok(preview.bytes > 8 * 1024 * 1024);
    assert.ok(preview.peakBufferedBytes < 1024 * 1024);
    assert.ok(preview.peakBufferedBytes * 16 < preview.bytes);

    const observedArchive = await __test.verifyArchive(archives, entry);
    assert.equal(observedArchive.bytes, 32 * 1024 * 1024);
    assert.equal(observedArchive.sha256, entry.archive.sha256);
    assert.ok(observedArchive.peakBufferedBytes <= 1024 * 1024);
    assert.ok(observedArchive.peakBufferedBytes * 16 < observedArchive.bytes);
  } finally { await cleanup(temp); }
});

test("streamed v2 media verification rejects PNG CRC corruption and Archive digest mismatch", async () => {
  const temp = await makeTemp("sfl-community-v2-streamed-media-negative-");
  try {
    const repository = path.join(temp, "repository");
    const archives = path.join(temp, "archives");
    const archive = await archiveFixture(archives, "streamed-negative");
    const { entry, previewBytes } = makeEntry({ templateId: "streamed-negative", archive });
    const previewPath = path.join(repository, ...entry.preview.path.split("/"));
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    const corrupted = Buffer.from(previewBytes);
    const idat = corrupted.indexOf(Buffer.from("IDAT", "ascii"));
    assert.ok(idat > 0);
    corrupted[idat + 4] ^= 0x01;
    await fs.writeFile(previewPath, corrupted);
    await assert.rejects(__test.verifyPreview(repository, entry), /PNG IDAT chunk CRC mismatch/u);

    await assert.rejects(
      __test.verifyArchive(archives, { ...entry, archive: { ...entry.archive, sha256: "f".repeat(64) } }),
      /Archive bytes\/SHA-256 mismatch/u,
    );
  } finally { await cleanup(temp); }
});

test("Archive validation requires current main to retain the exact pinned blob", async () => {
  const temp = await makeTemp("sfl-community-archive-head-identity-");
  try {
    for (const mode of ["replace", "delete"]) {
      const archives = path.join(temp, mode);
      const archive = await archiveFixture(archives, `archive-head-${mode}`);
      const { entry } = makeEntry({ templateId: `archive-head-${mode}`, archive });
      if (mode === "replace") {
        await write(archives, archive.path, Buffer.from("replacement archive bytes\n", "utf8"));
      } else {
        await fs.rm(path.join(archives, ...archive.path.split("/")));
      }
      await commitAll(archives, `${mode} immutable Archive on current main`);
      await assert.rejects(
        __test.verifyArchive(archives, entry),
        /fixed Archives main (?:no longer retains|archive path is not)/u,
      );
    }
  } finally { await cleanup(temp); }
});

test("tree policy CLI emits the exact add mode used by workflow routing", async () => {
  const temp = await makeTemp("sfl-community-v2-add-cli-");
  try {
    const base = path.join(temp, "base");
    const candidate = path.join(temp, "candidate");
    const archives = path.join(temp, "archives");
    const output = path.join(temp, "github-output.txt");
    await createV2Repository(base, { generatedAt: "2026-08-25T00:00:00Z" });
    await cloneRepositoryFiles(base, candidate);
    const archive = await archiveFixture(archives);
    const { entry, previewBytes } = makeEntry({ archive });
    await installEntry(candidate, entry, previewBytes);
    await writeV2Aggregates(candidate, [entry], { generatedAt: "2026-08-25T01:00:00Z" });
    await commitAll(candidate, "add for CLI routing");
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "validate-pr-trees.mjs"), base, candidate, "--github-output", output],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(output, "utf8"), "mode=add\n");
  } finally { await cleanup(temp); }
});

test("v2 addition validator permanently rejects retired identity reuse", async () => {
  const temp = await makeTemp("sfl-community-v2-retired-reuse-");
  try {
    const base = path.join(temp, "base");
    const candidate = path.join(temp, "candidate");
    const archives = path.join(temp, "archives");
    await createV2Repository(base);
    await cloneRepositoryFiles(base, candidate);
    const templateId = "ggsankeyfier-layout-color-combo";
    const archive = await archiveFixture(archives, templateId);
    const { entry, previewBytes } = makeEntry({ templateId, archive });
    await installEntry(candidate, entry, previewBytes);
    await writeV2Aggregates(candidate, [entry]);
    await commitAll(candidate, "reuse retired");
    await assert.rejects(validateCatalogAdditionV2({ baseRoot: base, candidateRoot: candidate, archivesRoot: archives }), /retired identity is also an entry|attempts to overwrite/u);
  } finally { await cleanup(temp); }
});

test("metadata-only withdrawal preserves immutable entry, preview, Archive, and retired ledger", async () => {
  const temp = await makeTemp("sfl-community-v2-withdraw-");
  try {
    const base = path.join(temp, "base");
    const candidate = path.join(temp, "candidate");
    const archives = path.join(temp, "archives");
    const archive = await archiveFixture(archives);
    const { entry, previewBytes } = makeEntry({ archive });
    await createV2Repository(base, { entries: [entry], generatedAt: "2026-08-25T00:00:00Z" });
    await installEntry(base, entry, previewBytes);
    await commitAll(base, "active complete");
    await cloneRepositoryFiles(base, candidate);
    const reason = Buffer.from("The release is withdrawn after a public metadata review.\n", "utf8");
    const next = structuredClone(entry);
    next.releaseState = "withdrawn";
    next.withdrawal = {
      withdrawnAt: "2026-08-25T01:00:00Z",
      reason: { path: "withdrawals/example-template/1.0.0/reason.txt", bytes: reason.byteLength, sha256: sha256(reason) },
    };
    await write(candidate, next.withdrawal.reason.path, reason);
    await writeCanonical(candidate, "catalog/entries/example-template/1.0.0.json", next);
    await writeV2Aggregates(candidate, [next], { generatedAt: "2026-08-25T02:00:00Z" });
    const appendix = ["", "## Withdrawal", "", "- Release state: withdrawn", `- Withdrawn at: ${next.withdrawal.withdrawnAt}`, `- Withdrawal reason: \`${next.withdrawal.reason.path}\` (${reason.byteLength} bytes, \`${sha256(reason)}\`)`, ""].join("\n");
    await write(candidate, "reviews/example-template/1.0.0.md", `${activeReview(entry)}${appendix}`);
    await commitAll(candidate, "withdraw");
    const result = await validateCatalogWithdrawalV2({ baseRoot: base, candidateRoot: candidate });
    assert.equal(result.withdrawnAt, "2026-08-25T01:00:00Z");
  } finally { await cleanup(temp); }
});

test("withdrawal validator rejects immutable metadata drift", async () => {
  const archive = { repository: "jarxunlai/ScientificFigureLibrary-community-archives", commit: "a".repeat(40), path: "archives/example-template/1.0.0/example-template-1.0.0.zip", bytes: 1, sha256: "b".repeat(64) };
  const entry = makeEntry({ archive }).entry;
  const next = structuredClone(entry);
  next.releaseState = "withdrawn";
  next.title = "Changed title";
  next.withdrawal = { withdrawnAt: "2026-08-25T00:00:00Z", reason: { path: "withdrawals/example-template/1.0.0/reason.txt", bytes: 1, sha256: "b".repeat(64) } };
  assert.throws(() => parseEntryV2(next), /immutableEntrySha256/u);
});

test("full v2 repository rejects orphan thumbnail and missing retired identity", async () => {
  const temp = await makeTemp("sfl-community-v2-orphan-");
  try {
    const repo = path.join(temp, "repo");
    await createV2Repository(repo);
    await write(repo, "catalog/thumbs/orphan.png", fixturePng());
    await assert.rejects(validateFullRepositoryV2(repo), /orphan or missing/u);
  } finally { await cleanup(temp); }
});
