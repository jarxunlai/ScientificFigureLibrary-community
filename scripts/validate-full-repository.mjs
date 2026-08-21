import path from "node:path";
import { validateFullRepository } from "./catalog-validation-lib.mjs";

const repositoryRoot = path.resolve(process.argv[2] ?? path.resolve(import.meta.dirname, ".."));
const result = await validateFullRepository(repositoryRoot);
console.log(`validated ${result.entries} immutable Community Catalog entries`);
