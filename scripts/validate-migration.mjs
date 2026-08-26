import path from "node:path";
import { validateZeroEntryMigrationV2 } from "./catalog-v2-validation-lib.mjs";

const [baseArg, candidateArg] = process.argv.slice(2);
if (!baseArg || !candidateArg) throw new Error("usage: validate-migration.mjs <trusted-base-checkout> <candidate-checkout>");

const result = await validateZeroEntryMigrationV2({
  baseRoot: path.resolve(baseArg),
  candidateRoot: path.resolve(candidateArg),
});
console.log(`validated one-time zero-entry v1-to-v2 migration with ${result.retired} retired identities`);
