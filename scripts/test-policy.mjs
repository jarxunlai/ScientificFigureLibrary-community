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
console.log("validated six-field public status policy");
