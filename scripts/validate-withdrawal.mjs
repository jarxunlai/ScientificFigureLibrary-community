import path from "node:path";
import { validateRestrictedSeedWithdrawal } from "./catalog-validation-lib.mjs";

const [baseArg, candidateArg] = process.argv.slice(2);
if (!baseArg || !candidateArg) {
  throw new Error("usage: validate-withdrawal.mjs <trusted-base-checkout> <candidate-checkout>");
}

const result = await validateRestrictedSeedWithdrawal({
  baseRoot: path.resolve(baseArg),
  candidateRoot: path.resolve(candidateArg),
});
console.log(`validated exact restricted withdrawal of ${result.identities.join(", ")}`);