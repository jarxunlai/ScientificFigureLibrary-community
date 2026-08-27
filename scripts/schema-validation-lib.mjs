import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const SCHEMA_FILES = Object.freeze({
  previewIdentity: "public-preview-identity.v2.schema.json",
  entry: "public-template-entry.v2.schema.json",
  previewEntry: "public-preview-entry.v2.schema.json",
  retiredRelease: "public-retired-release.v2.schema.json",
  previewManifest: "public-preview-manifest.v2.schema.json",
  catalog: "public-provider-catalog.v2.schema.json",
});

const schemasRoot = path.resolve(import.meta.dirname, "..", "schemas");

function loadSchema(fileName) {
  const filePath = path.join(schemasRoot, fileName);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`trusted JSON Schema ${fileName} could not be loaded`, { cause: error });
  }
  return value;
}

const documents = Object.fromEntries(
  Object.entries(SCHEMA_FILES).map(([name, fileName]) => [name, loadSchema(fileName)]),
);

const ajv = new Ajv2020({
  allErrors: false,
  strict: true,
  validateFormats: true,
});
addFormats(ajv);

// Register the shared preview schema first so relative $ref values resolve
// against each trusted schema's immutable $id during compilation.
ajv.addSchema(documents.previewIdentity);

const validators = Object.freeze({
  previewIdentity: ajv.getSchema(documents.previewIdentity.$id),
  entry: ajv.compile(documents.entry),
  previewEntry: ajv.compile(documents.previewEntry),
  retiredRelease: ajv.compile(documents.retiredRelease),
  previewManifest: ajv.compile(documents.previewManifest),
  catalog: ajv.compile(documents.catalog),
});

if (Object.values(validators).some((validator) => typeof validator !== "function")) {
  throw new Error("trusted v2 JSON Schemas did not all compile");
}

function schemaFailure(validator, label) {
  const error = validator.errors?.[0];
  if (!error) return `${label} failed its trusted v2 JSON Schema`;
  const location = error.instancePath || "/";
  return `${label} failed its trusted v2 JSON Schema at ${location}: ${error.message ?? "invalid value"}`;
}

export function assertV2Schema(name, value, label = name) {
  const validator = validators[name];
  if (!validator) throw new Error(`unknown trusted v2 JSON Schema ${name}`);
  if (!validator(value)) throw new Error(schemaFailure(validator, label));
  return value;
}

export const V2_SCHEMA_FILES = SCHEMA_FILES;
