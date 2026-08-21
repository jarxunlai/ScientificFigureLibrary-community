import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { validateFullRepository, validatePublicationCandidate, decodeCanonicalPng } from "../scripts/catalog-validation-lib.mjs";
import { assertPortableTreeRecords, compareTreeMaps } from "../scripts/validate-pr-trees.mjs";

const root = path.resolve(import.meta.dirname, "..");
const providerId = "io.github.jarxunlai.scientific-figure-community";
const archiveRepository = "jarxunlai/ScientificFigureLibrary-community-archives";
const seedIds = [
  "single-cell-enrichment-bar-pathway-genes",
  "ggsankeyfier-layout-color-combo",
  "umap-unchull-main-type-circles",
];
const seedRoot = path.join(root, "seed-staging");

function crc32(...parts) {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
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

function createFixturePng({ transparency = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", Buffer.from([220, 20, 60, 30, 144, 255])),
    ...(transparency ? [pngChunk("tRNS", Buffer.from([255, 64]))] : []),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 1]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(repository, args, { input, encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-c", `safe.directory=${repository.replaceAll("\\", "/")}`, "-C", repository, ...args], {
    input,
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`test git failed: ${args.join(" ")}\n${String(result.stderr)}`);
  return result.stdout;
}

async function initRepository(directory) {
  await fs.mkdir(directory, { recursive: true });
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.name", "SFL Test"]);
  git(directory, ["config", "user.email", "sfl-test@example.invalid"]);
}

async function commitAll(directory, message) {
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-q", "-m", message]);
  return git(directory, ["rev-parse", "HEAD"]).trim();
}

async function write(directory, relativePath, bytes) {
  const target = path.join(directory, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
}

function canonicalize(value) {
  return Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
}

async function writeCanonical(directory, relativePath, value) {
  await write(directory, relativePath, `${JSON.stringify(canonicalize(value))}\n`);
}

function catalog(entries, generatedAt) {
  return {
    schema: "figure-library.public-provider-catalog.v1",
    provider: {
      providerId,
      displayName: "Scientific Figure Library Community",
      catalogRepository: "jarxunlai/ScientificFigureLibrary-community",
      archiveRepository,
    },
    generatedAt,
    entries: [...entries].sort((left, right) => `${left.templateId}@${left.releaseVersion}` < `${right.templateId}@${right.releaseVersion}` ? -1 : 1),
  };
}

function manifest(entries) {
  return {
    schema: "figure-library.public-preview-manifest.v1",
    providerId,
    entries: [...entries]
      .sort((left, right) => `${left.templateId}@${left.releaseVersion}` < `${right.templateId}@${right.releaseVersion}` ? -1 : 1)
      .map((entry) => ({ templateId: entry.templateId, releaseVersion: entry.releaseVersion, ...entry.preview })),
  };
}

function review(entry, archivePr = 2, run = 10) {
  return [
    `# Community review: ${entry.templateId} ${entry.releaseVersion}`,
    "",
    `- Archive PR: https://github.com/${archiveRepository}/pull/${archivePr}`,
    `- Archive merge commit: \`${entry.archive.commit}\``,
    `- Archive path: \`${entry.archive.path}\``,
    `- Archive bytes: ${entry.archive.bytes}`,
    `- Archive SHA-256: \`${entry.archive.sha256}\``,
    `- Content digest: \`${entry.contentDigest}\``,
    `- Fixed-render CI run: https://github.com/${archiveRepository}/actions/runs/${run}`,
    `- Publisher identity matched GitHub author: ${entry.status.publisherVerified ? "yes" : "no"}`,
    "- Archive render gate: passed before manual Archive merge",
    "- Catalog curation gate: pending manual review of this PR",
    "- Recipient local review: not reviewed",
    "- Code execution by SFL client: false",
    "",
  ].join("\n");
}

async function archiveFixture(archivesRoot, templateId, releaseVersion) {
  const bytes = Buffer.from(`reviewed immutable archive fixture for ${templateId}@${releaseVersion}\n`, "utf8");
  const relativePath = `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`;
  await write(archivesRoot, relativePath, bytes);
  const commit = await commitAll(archivesRoot, `archive ${templateId}`);
  return { repository: archiveRepository, commit, path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function entryFixture(templateId, archive, previewBytes, seedDirectory) {
  const hasSeed = seedDirectory && existsSync(path.join(seedDirectory, "payload", "template.json"));
  const template = hasSeed
    ? JSON.parse(await fs.readFile(path.join(seedDirectory, "payload", "template.json"), "utf8"))
    : {
        templateId,
        releaseVersion: "1.0.0",
        contentDigest: sha256(Buffer.from(`content:${templateId}`, "utf8")),
        metadata: {
          title: `Clean-room ${templateId}`,
          summary: `Neutral synthetic candidate for ${templateId}.`,
          keywords: ["scientific figure", "synthetic"],
          provenance: "Clean-room authored code, neutral synthetic data, and code-generated preview.",
        },
      };
  const receipt = hasSeed
    ? JSON.parse(await fs.readFile(path.join(seedDirectory, "render-receipt.json"), "utf8"))
    : { inputFiles: [{ path: "payload/data/data.csv" }] };
  const decoded = decodeCanonicalPng(previewBytes);
  const keywords = [...new Set(template.metadata.keywords)].sort();
  const plotFamily = keywords.includes("sankey") || keywords.includes("alluvial") ? "sankey"
    : keywords.includes("bar") || keywords.includes("bar chart") ? "bar"
      : keywords.includes("scatter") ? "scatter" : "scientific-figure-template";
  return {
    schema: "figure-library.public-template-entry.v1",
    providerId,
    templateId: template.templateId,
    releaseVersion: template.releaseVersion,
    contentDigest: template.contentDigest,
    title: template.metadata.title,
    description: template.metadata.summary,
    search: {
      application: template.metadata.summary,
      dataProfile: `Synthetic data: ${receipt.inputFiles.map((item) => path.posix.basename(item.path)).sort().join(", ")}`,
      plotFamily,
      language: "R",
      tags: keywords,
      packages: [],
      codeFiles: ["payload/code/render.R"],
      inputFiles: receipt.inputFiles.map((item) => item.path).sort(),
    },
    archive,
    preview: {
      path: `thumbs/${template.templateId}/${template.releaseVersion}.png`,
      bytes: previewBytes.byteLength,
      sha256: sha256(previewBytes),
      mediaType: "image/png",
      width: decoded.width,
      height: decoded.height,
      canonicalRgbaSha256: decoded.canonicalRgbaSha256,
    },
    status: {
      upstreamStatus: "published",
      publisherVerified: false,
      curationStatus: "curated",
      renderValidation: "ci_rendered",
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
    },
    licenses: { code: "MIT", content: "CC-BY-4.0", documentation: "CC-BY-4.0" },
    provenance: [{ type: "note", value: template.metadata.provenance }],
  };
}

async function createFixture(seedId = seedIds[0]) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-catalog-policy-test-"));
  const base = path.join(temp, "base");
  const candidate = path.join(temp, "candidate");
  const archives = path.join(temp, "archives");
  await initRepository(base);
  await initRepository(archives);
  await writeCanonical(base, "catalog/catalog.json", catalog([], "2026-08-21T00:00:00.000Z"));
  await writeCanonical(base, "catalog/preview-manifest.json", manifest([]));
  await write(base, "catalog/entries/.gitkeep", "");
  await write(base, "thumbs/.gitkeep", "");
  await write(base, "reviews/.gitkeep", "");
  await write(base, "LICENSES/MIT.txt", await fs.readFile(path.join(root, "LICENSES", "MIT.txt")));
  await write(base, "LICENSES/CC-BY-4.0.txt", await fs.readFile(path.join(root, "LICENSES", "CC-BY-4.0.txt")));
  await commitAll(base, "base");
  await fs.cp(base, candidate, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
  await initRepository(candidate);
  await commitAll(candidate, "base candidate");
  await write(archives, "archives/.gitkeep", "");
  await commitAll(archives, "archives base");

  const seedDirectory = path.join(seedRoot, seedId);
  const preview = existsSync(path.join(seedDirectory, "payload", "preview", "preview.png"))
    ? await fs.readFile(path.join(seedDirectory, "payload", "preview", "preview.png"))
    : createFixturePng();
  const archive = await archiveFixture(archives, seedId, "1.0.0");
  const entry = await entryFixture(seedId, archive, preview, seedDirectory);
  await writeCanonical(candidate, `catalog/entries/${seedId}/1.0.0.json`, entry);
  await write(candidate, `thumbs/${seedId}/1.0.0.png`, preview);
  await write(candidate, `reviews/${seedId}/1.0.0.md`, review(entry));
  await writeCanonical(candidate, "catalog/catalog.json", catalog([entry], "2026-08-21T01:00:00.000Z"));
  await writeCanonical(candidate, "catalog/preview-manifest.json", manifest([entry]));
  await commitAll(candidate, "candidate");
  return { temp, baseRoot: base, candidateRoot: candidate, archivesRoot: archives, candidate, entry, preview };
}

async function mutateAndCommit(fixture, mutate) {
  await mutate(fixture);
  await commitAll(fixture.candidate, "negative mutation");
}

test("all three approved clean-room seed identities form valid trusted Catalog candidates", async () => {
  for (const seedId of seedIds) {
    const fixture = await createFixture(seedId);
    try {
      const result = await validatePublicationCandidate(fixture);
      assert.equal(result.templateId, seedId);
      assert.equal(result.releaseVersion, "1.0.0");
      assert.equal(
        result.archiveRawUrl,
        `https://raw.githubusercontent.com/${archiveRepository}/${fixture.entry.archive.commit}/${fixture.entry.archive.path}`,
      );
      assert.deepEqual(await validateFullRepository(fixture.candidate), { entries: 1 });
    } finally {
      await fs.rm(fixture.temp, { recursive: true, force: true });
    }
  }
});

const negativeCases = [
  ["aggregate replacement/withdrawal", async (f) => {
    await writeCanonical(f.candidate, "catalog/catalog.json", catalog([], "2026-08-21T02:00:00.000Z"));
    await writeCanonical(f.candidate, "catalog/preview-manifest.json", manifest([]));
  }],
  ["outer path and inner entry identity drift", async (f) => {
    const bad = structuredClone(f.entry); bad.templateId = "different-template";
    await writeCanonical(f.candidate, `catalog/entries/${f.entry.templateId}/1.0.0.json`, bad);
  }],
  ["archive path identity drift", async (f) => {
    const bad = structuredClone(f.entry); bad.archive.path = "archives/wrong/9.9.9/wrong-9.9.9.zip";
    await writeCanonical(f.candidate, `catalog/entries/${f.entry.templateId}/1.0.0.json`, bad);
    await writeCanonical(f.candidate, "catalog/catalog.json", catalog([bad], "2026-08-21T02:00:00.000Z"));
    await writeCanonical(f.candidate, "catalog/preview-manifest.json", manifest([bad]));
  }],
  ["archive bytes/SHA drift", async (f) => {
    const bad = structuredClone(f.entry); bad.archive.sha256 = "0".repeat(64);
    await writeCanonical(f.candidate, `catalog/entries/${f.entry.templateId}/1.0.0.json`, bad);
    await writeCanonical(f.candidate, "catalog/catalog.json", catalog([bad], "2026-08-21T02:00:00.000Z"));
    await writeCanonical(f.candidate, "catalog/preview-manifest.json", manifest([bad]));
  }],
  ["PNG trailing bytes after IEND", async (f) => {
    const badPreview = Buffer.concat([f.preview, Buffer.from("C:\\Users\\private\\tail")]);
    const bad = structuredClone(f.entry); bad.preview.bytes = badPreview.byteLength; bad.preview.sha256 = sha256(badPreview);
    await write(f.candidate, bad.preview.path, badPreview);
    await writeCanonical(f.candidate, `catalog/entries/${bad.templateId}/1.0.0.json`, bad);
    await writeCanonical(f.candidate, "catalog/catalog.json", catalog([bad], "2026-08-21T02:00:00.000Z"));
    await writeCanonical(f.candidate, "catalog/preview-manifest.json", manifest([bad]));
  }],
  ["review identity/private path drift", async (f) => {
    await write(f.candidate, `reviews/${f.entry.templateId}/1.0.0.md`, "# Community review: wrong 9.9.9\nC:\\Users\\private\\review.md\n");
  }],
  ["status extra claim", async (f) => {
    const bad = structuredClone(f.entry); bad.status.recipientApproved = true;
    await writeCanonical(f.candidate, `catalog/entries/${bad.templateId}/1.0.0.json`, bad);
    await writeCanonical(f.candidate, "catalog/catalog.json", catalog([bad], "2026-08-21T02:00:00.000Z"));
  }],
  ["license extra private path", async (f) => {
    const bad = structuredClone(f.entry); bad.licenses.source = "C:\\Users\\private\\license.txt";
    await writeCanonical(f.candidate, `catalog/entries/${bad.templateId}/1.0.0.json`, bad);
    await writeCanonical(f.candidate, "catalog/catalog.json", catalog([bad], "2026-08-21T02:00:00.000Z"));
  }],
  ["provenance non-array", async (f) => {
    const bad = structuredClone(f.entry); bad.provenance = "not-an-array";
    await writeCanonical(f.candidate, `catalog/entries/${bad.templateId}/1.0.0.json`, bad);
    await writeCanonical(f.candidate, "catalog/catalog.json", catalog([bad], "2026-08-21T02:00:00.000Z"));
  }],
  ["search absolute private path", async (f) => {
    const bad = structuredClone(f.entry); bad.search.codeFiles = ["E:\\private\\render.R"];
    await writeCanonical(f.candidate, `catalog/entries/${bad.templateId}/1.0.0.json`, bad);
    await writeCanonical(f.candidate, "catalog/catalog.json", catalog([bad], "2026-08-21T02:00:00.000Z"));
  }],
];

for (const [name, mutate] of negativeCases) {
  test(`trusted validator rejects ${name}`, async () => {
    const fixture = await createFixture();
    try {
      await mutateAndCommit(fixture, mutate);
      await assert.rejects(() => validatePublicationCandidate(fixture));
    } finally {
      await fs.rm(fixture.temp, { recursive: true, force: true });
    }
  });
}

test("tree gate rejects gitlinks, symlinks/executables, Windows casefold/NFC/reserved paths, and mode-only drift", () => {
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

test("complete repository validator rejects orphan release files", async () => {
  const fixture = await createFixture();
  try {
    await write(fixture.candidate, "thumbs/orphan/1.0.0.png", fixture.preview);
    await assert.rejects(() => validateFullRepository(fixture.candidate), /orphan/u);
  } finally {
    await fs.rm(fixture.temp, { recursive: true, force: true });
  }
});

test("PNG decoder rejects forbidden text/unknown chunks and trailing bytes", () => {
  const bytes = createFixturePng();
  assert.throws(() => decodeCanonicalPng(Buffer.concat([bytes, Buffer.from([0])])), /after IEND/u);
  const idatOffset = bytes.indexOf(Buffer.from("IDAT")) - 4;
  for (const type of ["tEXt", "eXIf", "vpAg"]) {
    const tampered = Buffer.concat([bytes.subarray(0, idatOffset), pngChunk(type, Buffer.from("hidden")), bytes.subarray(idatOffset)]);
    assert.throws(() => decodeCanonicalPng(tampered), /forbidden/u);
  }
  const transparent = decodeCanonicalPng(createFixturePng({ transparency: true }));
  assert.equal(transparent.rgba[3], 255);
  assert.equal(transparent.rgba[7], 64);
});
