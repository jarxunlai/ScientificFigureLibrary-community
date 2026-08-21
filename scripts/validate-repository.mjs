import path from "node:path";
import { validatePublicationCandidate } from "./catalog-validation-lib.mjs";

const [baseArg, candidateArg, archivesArg] = process.argv.slice(2);
if (!baseArg || !candidateArg || !archivesArg) {
  throw new Error(
    "usage: validate-repository.mjs <trusted-base-checkout> <candidate-checkout> <fixed-archives-main-checkout>",
  );
}

const result = await validatePublicationCandidate({
  baseRoot: path.resolve(baseArg),
  candidateRoot: path.resolve(candidateArg),
  archivesRoot: path.resolve(archivesArg),
});
console.log(
  `validated trusted Catalog release ${result.templateId}@${result.releaseVersion} against Archives ${result.archiveCommit}`,
);
