import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const expected = "* text=auto eol=lf\n*.png binary\n*.zip binary\n";

test("repository enforces canonical LF checkouts without rewriting binary assets", async () => {
  const actual = await fs.readFile(path.join(root, ".gitattributes"), "utf8");
  assert.equal(actual, expected);
});
