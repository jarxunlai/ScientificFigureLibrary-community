import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  __test as v1Test,
  decodeCanonicalPng,
  validateFullRepository,
} from "../scripts/catalog-validation-lib.mjs";
import {
  assertPortableTreeRecords,
  compareTreeMaps,
} from "../scripts/validate-pr-trees.mjs";
import {
  cleanup,
  commitAll,
  fixturePng,
  initRepository,
  makeTemp,
  provider,
  providerId,
  sha256,
  write,
  writeCanonical,
} from "./policy-fixtures.mjs";

const archiveRepository = "jarxunlai/ScientificFigureLibrary-community-archives";

function makeV1Entry(templateId = "legacy-example") {
  const previewBytes = fixturePng();
  const releaseVersion = "1.0.0";
  const contentDigest = sha256(Buffer.from(`legacy-content:${templateId}`, "utf8"));
  const entry = {
    schema: "figure-library.public-template-entry.v1",
    providerId,
    templateId,
    releaseVersion,
    contentDigest,
    title: `Legacy ${templateId}`,
    description: "Synthetic v1 compatibility fixture.",
    search: {
      application: "Compatibility validation",
      dataProfile: "Synthetic data",
      plotFamily: "example",
      language: "R",
      tags: ["example"],
      packages: [],
      codeFiles: ["payload/code/render.R"],
      inputFiles: ["payload/data/data.csv"],
    },
    archive: {
      repository: archiveRepository,
      commit: "a".repeat(40),
      path: `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`,
      bytes: 1,
      sha256: "b".repeat(64),
    },
    preview: {
      path: `thumbs/${templateId}/${releaseVersion}.png`,
      bytes: previewBytes.byteLength,
      sha256: sha256(previewBytes),
      mediaType: "image/png",
      width: 2,
      height: 1,
      canonicalRgbaSha256: "a367b8fdec8d168420309e8c4a325f82a58aaa55d183b81fa4062ec5aab93c42",
    },
    status: {
      upstreamStatus: "published",
      publisherVerified: true,
      curationStatus: "curated",
      renderValidation: "ci_rendered",
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
    },
    licenses: {
      code: "MIT",
      content: "CC-BY-4.0",
      documentation: "CC-BY-4.0",
    },
    provenance: [{ type: "note", value: "Product-neutral v1 compatibility fixture." }],
  };
  return { entry, previewBytes };
}

function v1Catalog(entries, generatedAt = "2026-08-25T00:00:00Z") {
  return {
    schema: "figure-library.public-provider-catalog.v1",
    provider,
    generatedAt,
    entries,
  };
}

function v1Manifest(entries) {
  return {
    schema: "figure-library.public-preview-manifest.v1",
    providerId,
    entries: entries.map((entry) => ({
      templateId: entry.templateId,
      releaseVersion: entry.releaseVersion,
      ...entry.preview,
    })),
  };
}

function v1Review(entry) {
  return [
    `# Community review: ${entry.templateId} ${entry.releaseVersion}`,
    "",
    `- Archive PR: https://github.com/${archiveRepository}/pull/2`,
    `- Archive merge commit: \`${entry.archive.commit}\``,
    `- Archive path: \`${entry.archive.path}\``,
    `- Archive bytes: ${entry.archive.bytes}`,
    `- Archive SHA-256: \`${entry.archive.sha256}\``,
    `- Content digest: \`${entry.contentDigest}\``,
    `- Fixed-render CI run: https://github.com/${archiveRepository}/actions/runs/10`,
    "- Publisher identity matched GitHub author: yes",
    "- Archive render gate: passed before manual Archive merge",
    "- Catalog curation gate: pending manual review of this PR",
    "- Recipient local review: not reviewed",
    "- Code execution by SFL client: false",
    "",
  ].join("\n");
}

async function createV1Repository(directory, templateId = "legacy-example") {
  await initRepository(directory);
  const { entry, previewBytes } = makeV1Entry(templateId);
  await writeCanonical(directory, "catalog/catalog.json", v1Catalog([entry]));
  await writeCanonical(directory, "catalog/preview-manifest.json", v1Manifest([entry]));
  await write(directory, "catalog/entries/.gitkeep", "");
  await writeCanonical(directory, `catalog/entries/${templateId}/1.0.0.json`, entry);
  await write(directory, "thumbs/.gitkeep", "");
  await write(directory, entry.preview.path, previewBytes);
  await write(directory, "reviews/.gitkeep", "");
  await write(directory, `reviews/${templateId}/1.0.0.md`, v1Review(entry));
  for (const name of ["MIT.txt", "CC-BY-4.0.txt"]) {
    await write(directory, `LICENSES/${name}`, await fs.readFile(path.resolve(import.meta.dirname, "..", "LICENSES", name)));
  }
  await commitAll(directory, "synthetic v1 compatibility repository");
  return { entry, previewBytes };
}

async function withV1Repository(callback) {
  const temp = await makeTemp("sfl-community-v1-regression-");
  const repository = path.join(temp, "repository");
  try {
    const fixture = await createV1Repository(repository);
    return await callback({ temp, repository, ...fixture });
  } finally {
    await cleanup(temp);
  }
}

test("legacy v1 non-empty Catalog remains fully readable", async () => {
  await withV1Repository(async ({ repository }) => {
    assert.deepEqual(await validateFullRepository(repository), { entries: 1 });
  });
});

test("legacy v1 entry parser preserves the strict 0.6 contract", () => {
  const { entry } = makeV1Entry();
  assert.equal(v1Test.parseEntry(entry, "entry"), entry);

  assert.throws(() => v1Test.parseEntry({ ...entry, extra: true }, "entry"), /fixed keys/u);

  const statusDrift = structuredClone(entry);
  statusDrift.status.recipientApproved = true;
  assert.throws(() => v1Test.parseEntry(statusDrift, "entry"), /fixed keys/u);

  const licenseDrift = structuredClone(entry);
  licenseDrift.licenses.code = "Apache-2.0";
  assert.throws(() => v1Test.parseEntry(licenseDrift, "entry"), /MIT/u);

  const privatePath = structuredClone(entry);
  privatePath.search.codeFiles = ["E:\\private\\render.R"];
  assert.throws(() => v1Test.parseEntry(privatePath, "entry"), /private|payload\/code/u);
});

test("legacy v1 Catalog and preview manifest remain strict and ordered", () => {
  const z = makeV1Entry("legacy-z").entry;
  const a = makeV1Entry("legacy-a").entry;
  assert.throws(() => v1Test.parseCatalog(v1Catalog([z, a]), "catalog"), /ordered/u);
  const catalog = v1Test.parseCatalog(v1Catalog([a, z]), "catalog");
  const manifest = v1Manifest([a, z]);
  assert.equal(v1Test.parseManifest(manifest, catalog, "manifest"), manifest);
  const drift = structuredClone(manifest);
  drift.entries[0].sha256 = "f".repeat(64);
  assert.throws(() => v1Test.parseManifest(drift, catalog, "manifest"), /mirror/u);
});

const fullRepositoryNegativeCases = [
  ["orphan release file", async ({ repository, previewBytes }) => {
    await write(repository, "thumbs/orphan/1.0.0.png", previewBytes);
  }, /orphan|missing/u],
  ["standalone entry drift", async ({ repository, entry }) => {
    await writeCanonical(repository, `catalog/entries/${entry.templateId}/1.0.0.json`, { ...entry, title: "Changed" });
  }, /differs from aggregate/u],
  ["PNG trailing payload", async ({ repository, entry, previewBytes }) => {
    await write(repository, entry.preview.path, Buffer.concat([previewBytes, Buffer.from([0])]));
  }, /after IEND|identity/u],
  ["review private path", async ({ repository, entry }) => {
    await write(repository, `reviews/${entry.templateId}/1.0.0.md`, `${v1Review(entry)}C:\\Users\\private\\note.txt\n`);
  }, /private path|fixed identity/u],
];

for (const [name, mutate, pattern] of fullRepositoryNegativeCases) {
  test(`legacy v1 repository rejects ${name}`, async () => {
    await withV1Repository(async (fixture) => {
      await mutate(fixture);
      await assert.rejects(() => validateFullRepository(fixture.repository), pattern);
    });
  });
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + payload.byteLength);
  output.writeUInt32BE(payload.byteLength, 0);
  typeBytes.copy(output, 4);
  payload.copy(output, 8);
  output.writeUInt32BE(v1Test.crc32(typeBytes, payload), 8 + payload.byteLength);
  return output;
}

function transparentFixturePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", Buffer.from([220, 20, 60, 30, 144, 255])),
    pngChunk("tRNS", Buffer.from([255, 64])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 1]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("legacy PNG decoder still rejects hidden chunks and trailing payload", () => {
  const bytes = fixturePng();
  assert.throws(() => decodeCanonicalPng(Buffer.concat([bytes, Buffer.from([0])])), /after IEND/u);
  const idatOffset = bytes.indexOf(Buffer.from("IDAT")) - 4;
  for (const type of ["tEXt", "eXIf", "vpAg"]) {
    const tampered = Buffer.concat([
      bytes.subarray(0, idatOffset),
      pngChunk(type, Buffer.from("hidden")),
      bytes.subarray(idatOffset),
    ]);
    assert.throws(() => decodeCanonicalPng(tampered), /forbidden/u);
  }
  const transparent = decodeCanonicalPng(transparentFixturePng());
  assert.equal(transparent.rgba[3], 255);
  assert.equal(transparent.rgba[7], 64);
});

test("repository tree portability gate retains legacy security checks", () => {
  const oid = "a".repeat(40);
  for (const record of [
    { path: "nested", mode: "160000", type: "commit", oid },
    { path: "link", mode: "120000", type: "blob", oid },
    { path: "executable", mode: "100755", type: "blob", oid },
    { path: "Cafe\u0301.txt", mode: "100644", type: "blob", oid },
    { path: "CON", mode: "100644", type: "blob", oid },
  ]) assert.throws(() => assertPortableTreeRecords([record]));
  assert.throws(() => assertPortableTreeRecords([
    { path: "Thumbs/x.png", mode: "100644", type: "blob", oid },
    { path: "thumbs/x.png", mode: "100644", type: "blob", oid: "b".repeat(40) },
  ]));
  const base = new Map([["file", { path: "file", mode: "100644", type: "blob", oid }]]);
  const candidate = new Map([["file", { path: "file", mode: "100755", type: "blob", oid }]]);
  assert.throws(() => compareTreeMaps(base, candidate));
});

test("legacy v1 compatibility fixtures contain no retired production template identity", () => {
  const source = `${makeV1Entry}\n${createV1Repository}`;
  for (const identity of [
    "ggsankeyfier-layout-color-combo",
    "single-cell-enrichment-bar-pathway-genes",
    "umap-unchull-main-type-circles",
  ]) assert.doesNotMatch(source, new RegExp(identity, "u"));
});
