import path from "node:path";
import { validateCatalogWithdrawalV2 } from "./catalog-v2-validation-lib.mjs";

const [baseArg, candidateArg] = process.argv.slice(2);
if (!baseArg || !candidateArg) throw new Error("usage: validate-withdrawal.mjs <trusted-base-checkout> <candidate-checkout>");

const result = await validateCatalogWithdrawalV2({
  baseRoot: path.resolve(baseArg),
  candidateRoot: path.resolve(candidateArg),
});
console.log(`validated metadata-only withdrawal ${result.templateId}@${result.releaseVersion}`);
