import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { V2_SCHEMA_FILES, assertV2Schema } from "./schema-validation-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const schema = JSON.parse(await fs.readFile(path.join(root, "schemas", "public-template-entry.v1.schema.json"), "utf8"));
const status = schema.properties.status;
assert.deepEqual(status.required, [
  "upstreamStatus",
  "publisherVerified",
  "curationStatus",
  "renderValidation",
  "localReviewStatus",
  "plotExecutionByRecipient",
]);
assert.equal(status.additionalProperties, false);
assert.equal(status.properties.localReviewStatus.const, "not_reviewed");
assert.equal(status.properties.plotExecutionByRecipient.const, "not_run");
const releaseVersion = new RegExp(schema.properties.releaseVersion.pattern, "u");
for (const value of ["1.0.0", "0.0.0-alpha.1", "2.3.4-rc.1+build.9", "1.0.0+build.9"]) {
  assert.equal(releaseVersion.test(value), true, `expected strict SemVer acceptance: ${value}`);
}
for (const value of ["01.0.0", "1.0", "1.0.0-01", "1.0.0-alpha..1", "1.0.0+"]) {
  assert.equal(releaseVersion.test(value), false, `expected strict SemVer rejection: ${value}`);
}
for (const [name, pattern, minimum] of [
  ["MIT.txt", /^MIT License/u, 500],
  ["Apache-2.0.txt", /^Apache License\r?\nVersion 2\.0/u, 10_000],
  ["BSD-3-Clause.txt", /Redistribution and use in source and binary forms/u, 1_000],
  ["GPL-3.0.txt", /^GNU GENERAL PUBLIC LICENSE\r?\nVersion 3/u, 30_000],
  ["CC-BY-4.0.txt", /Attribution 4\.0 International/u, 10_000],
  ["CC0-1.0.txt", /CC0 1\.0 Universal/u, 5_000],
  ["CC-BY-SA-4.0.txt", /Attribution-ShareAlike 4\.0 International/u, 10_000],
]) {
  const text = await fs.readFile(path.join(root, "LICENSES", name), "utf8");
  assert.match(text, pattern);
  assert.ok(text.length > minimum, `${name} must contain the complete license text`);
}

for (const name of [
  "public-preview-identity.v2.schema.json",
  "public-template-entry.v2.schema.json",
  "public-preview-entry.v2.schema.json",
  "public-retired-release.v2.schema.json",
  "public-preview-manifest.v2.schema.json",
  "public-provider-catalog.v2.schema.json",
]) {
  const document = JSON.parse(await fs.readFile(path.join(root, "schemas", name), "utf8"));
  assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(document.additionalProperties, false);
}
assert.deepEqual(Object.values(V2_SCHEMA_FILES), [
  "public-preview-identity.v2.schema.json",
  "public-template-entry.v2.schema.json",
  "public-preview-entry.v2.schema.json",
  "public-retired-release.v2.schema.json",
  "public-preview-manifest.v2.schema.json",
  "public-provider-catalog.v2.schema.json",
]);
assert.throws(
  () => assertV2Schema("retiredRelease", {
    schema: "figure-library.public-retired-release.v2",
    providerId: "io.github.jarxunlai.scientific-figure-community",
    templateId: "schema-execution-canary",
    releaseVersion: "1.0.0",
    unexpected: true,
  }),
  /trusted v2 JSON Schema/u,
);
console.log("validated v1 compatibility, v2 schema, SemVer, status, and complete license policy");
