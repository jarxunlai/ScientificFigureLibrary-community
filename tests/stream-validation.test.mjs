import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { canonicalJson, readCanonicalJsonl, scanWithdrawalReason } from "../scripts/stream-validation-lib.mjs";
import { cleanup, makeTemp } from "./policy-fixtures.mjs";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function withTemp(name, callback) {
  const directory = await makeTemp(`sfl-community-stream-${name}-`);
  try { return await callback(directory); } finally { await cleanup(directory); }
}

test("canonical JSONL streams an empty collection with the empty digest", async () => withTemp("empty", async (directory) => {
  const file = path.join(directory, "empty.jsonl");
  await fs.writeFile(file, Buffer.alloc(0));
  const result = await readCanonicalJsonl(file);
  assert.deepEqual(result, { bytes: 0, count: 0, sha256: sha256(Buffer.alloc(0)) });
}));

test("canonical JSONL streams multiple exact records", async () => withTemp("records", async (directory) => {
  const records = [{ a: 1, b: "two" }, { a: 3, b: "four" }];
  const bytes = Buffer.from(records.map((item) => `${canonicalJson(item)}\n`).join(""));
  const file = path.join(directory, "records.jsonl");
  await fs.writeFile(file, bytes);
  const observed = [];
  const result = await readCanonicalJsonl(file, { expected: { bytes: bytes.length, count: 2, sha256: sha256(bytes) }, onRecord: async (value) => observed.push(value) });
  assert.equal(result.count, 2);
  assert.deepEqual(observed, records);
}));

test("canonical JSONL handles a multi-megabyte collection without one JSON array", async () => withTemp("large", async (directory) => {
  const file = path.join(directory, "large.jsonl");
  const handle = await fs.open(file, "w");
  const hash = createHash("sha256");
  let bytes = 0;
  const count = 30_000;
  try {
    for (let index = 0; index < count; index += 1) {
      const line = Buffer.from(`${canonicalJson({ index, text: "x".repeat(80) })}\n`);
      await handle.write(line);
      hash.update(line);
      bytes += line.length;
    }
  } finally { await handle.close(); }
  assert.ok(bytes > 2 * 1024 * 1024);
  const result = await readCanonicalJsonl(file, { expected: { bytes, count, sha256: hash.digest("hex") } });
  assert.equal(result.count, count);
}));

test("canonical JSONL rejects non-canonical key order", async () => withTemp("order", async (directory) => {
  const file = path.join(directory, "bad.jsonl");
  await fs.writeFile(file, '{"z":1,"a":2}\n');
  await assert.rejects(readCanonicalJsonl(file), /not canonical JSON/u);
}));

test("canonical JSONL rejects blank records", async () => withTemp("blank", async (directory) => {
  const file = path.join(directory, "bad.jsonl");
  await fs.writeFile(file, '{"a":1}\n\n');
  await assert.rejects(readCanonicalJsonl(file), /blank line/u);
}));

test("canonical JSONL rejects a missing final LF", async () => withTemp("lf", async (directory) => {
  const file = path.join(directory, "bad.jsonl");
  await fs.writeFile(file, '{"a":1}');
  await assert.rejects(readCanonicalJsonl(file), /terminate every record/u);
}));

test("canonical JSONL rejects invalid UTF-8 across stream decoding", async () => withTemp("utf8", async (directory) => {
  const file = path.join(directory, "bad.jsonl");
  await fs.writeFile(file, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d, 0x0a]));
  await assert.rejects(readCanonicalJsonl(file), /not valid UTF-8/u);
}));

test("canonical JSONL rejects envelope byte, count, or digest mismatch", async () => withTemp("identity", async (directory) => {
  const file = path.join(directory, "records.jsonl");
  const bytes = Buffer.from('{"a":1}\n');
  await fs.writeFile(file, bytes);
  await assert.rejects(readCanonicalJsonl(file, { expected: { bytes: bytes.length, count: 2, sha256: sha256(bytes) } }), /bytes\/count\/SHA-256/u);
  await assert.rejects(readCanonicalJsonl(file, { expected: { bytes: bytes.length, count: 1, sha256: "0".repeat(64) } }), /bytes\/count\/SHA-256/u);
}));

test("withdrawal reason streams beyond the old product limits", async () => withTemp("reason-large", async (directory) => {
  const file = path.join(directory, "reason.txt");
  const chunk = Buffer.from("A public metadata issue requires withdrawal.\n".repeat(10_000));
  const handle = await fs.open(file, "w");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (let index = 0; index < 8; index += 1) { await handle.write(chunk); hash.update(chunk); bytes += chunk.length; }
  } finally { await handle.close(); }
  assert.ok(bytes > 2 * 1024 * 1024);
  const expectedDigest = hash.digest("hex");
  assert.deepEqual(await scanWithdrawalReason(file, { expected: { bytes, sha256: expectedDigest } }), { bytes, sha256: expectedDigest });
}));

test("withdrawal reason rejects private Windows path across a chunk boundary", async () => withTemp("reason-path", async (directory) => {
  const file = path.join(directory, "reason.txt");
  const prefix = "a".repeat(65_535);
  await fs.writeFile(file, `${prefix} C:\\Users\\Example\\secret.txt\n`);
  await assert.rejects(scanWithdrawalReason(file), /absolute\/private machine path/u);
}));

test("withdrawal reason rejects secret-like material across chunks", async () => withTemp("reason-secret", async (directory) => {
  const file = path.join(directory, "reason.txt");
  await fs.writeFile(file, `${"a".repeat(65_530)} github_pat_${"A".repeat(40)}\n`);
  await assert.rejects(scanWithdrawalReason(file), /secret-like material/u);
}));

test("withdrawal reason rejects CR, controls, invalid UTF-8, and whitespace-only content", async () => withTemp("reason-invalid", async (directory) => {
  const cr = path.join(directory, "cr.txt");
  await fs.writeFile(cr, "line\r\n");
  await assert.rejects(scanWithdrawalReason(cr), /non-canonical CR/u);
  const control = path.join(directory, "control.txt");
  await fs.writeFile(control, Buffer.from([0x61, 0x01, 0x0a]));
  await assert.rejects(scanWithdrawalReason(control), /control character/u);
  const invalid = path.join(directory, "invalid.txt");
  await fs.writeFile(invalid, Buffer.from([0xc3, 0x28]));
  await assert.rejects(scanWithdrawalReason(invalid), /not valid UTF-8/u);
  const blank = path.join(directory, "blank.txt");
  await fs.writeFile(blank, " \n\t");
  await assert.rejects(scanWithdrawalReason(blank), /non-whitespace/u);
}));

test("withdrawal reason rejects a stale byte or digest identity", async () => withTemp("reason-identity", async (directory) => {
  const file = path.join(directory, "reason.txt");
  const bytes = Buffer.from("Public reason.\n");
  await fs.writeFile(file, bytes);
  await assert.rejects(scanWithdrawalReason(file, { expected: { bytes: bytes.length + 1, sha256: sha256(bytes) } }), /bytes\/count\/SHA-256/u);
}));
