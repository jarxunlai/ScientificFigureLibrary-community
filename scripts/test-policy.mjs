import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

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
const mitLicense = await fs.readFile(path.join(root, "LICENSES", "MIT.txt"), "utf8");
const ccByLicense = await fs.readFile(path.join(root, "LICENSES", "CC-BY-4.0.txt"), "utf8");
assert.match(mitLicense, /^MIT License/u);
assert.match(ccByLicense, /Creative Commons Attribution 4\.0 International Public License/u);
assert.ok(ccByLicense.length > 10_000);
console.log("validated six-field public status and strict SemVer policy");
