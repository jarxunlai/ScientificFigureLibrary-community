import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";

const PRIVATE_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s"'`(=])\/(?:Users|home|mnt\/[A-Za-z]|private|var\/folders|tmp|etc|opt|root|srv|Volumes|workspace|data)\/)/mu;
const SECRET_TEXT = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[opusr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*[^\s]{12,})/iu;
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const MAX_CONTROL_LINE_CHARS = 1_048_576;

function fail(message) {
  throw new Error(message);
}

function assertWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("canonical JSON contains an unpaired UTF-16 surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("canonical JSON contains an unpaired UTF-16 surrogate");
    }
  }
}

export function canonicalJson(value, stack = new Set()) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") fail(`canonical JSON contains unsupported type ${typeof value}`);
  if (stack.has(value)) fail("canonical JSON contains a cycle");
  stack.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, stack)).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key, stack)}:${canonicalJson(value[key], stack)}`).join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

async function assertRegularFile(filePath, label) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be one regular non-symlink file`);
  return stat;
}

function assertExpectedIdentity(observed, expected, label) {
  if (!expected) return;
  if (
    observed.bytes !== expected.bytes ||
    observed.sha256 !== expected.sha256 ||
    (expected.count !== undefined && observed.count !== expected.count)
  ) fail(`${label} bytes/count/SHA-256 do not match the envelope identity`);
}

export async function readCanonicalJsonl(filePath, {
  label = "canonical JSONL",
  expected,
  onRecord = async () => {},
} = {}) {
  await assertRegularFile(filePath, label);
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  let count = 0;
  let sawAnyBytes = false;

  const processLine = async (line) => {
    if (!line) fail(`${label} contains a blank line`);
    if (line.length > MAX_CONTROL_LINE_CHARS) fail(`${label} contains an oversized control-plane record`);
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      fail(`${label} line ${count + 1} is not valid JSON`);
    }
    if (canonicalJson(value) !== line) fail(`${label} line ${count + 1} is not canonical JSON`);
    count += 1;
    await onRecord(value, count - 1, line);
  };

  try {
    for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
      sawAnyBytes = true;
      bytes += chunk.byteLength;
      hash.update(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await processLine(line);
      }
      if (pending.length > MAX_CONTROL_LINE_CHARS) fail(`${label} contains an oversized or unterminated record`);
    }
    pending += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) fail(`${label} is not valid UTF-8`);
    throw error;
  }
  if (pending.length) fail(`${label} must terminate every record with one LF`);
  const observed = { bytes, count, sha256: hash.digest("hex") };
  assertExpectedIdentity(observed, expected, label);
  if (!sawAnyBytes && count !== 0) fail(`${label} internal count mismatch`);
  return observed;
}

function scanPublicText(text, label) {
  if (text.includes("\r")) fail(`${label} contains a non-canonical CR character`);
  if (DISALLOWED_CONTROL.test(text)) fail(`${label} contains a disallowed control character`);
  if (PRIVATE_PATH.test(text)) fail(`${label} contains an absolute/private machine path`);
  if (SECRET_TEXT.test(text)) fail(`${label} contains secret-like material`);
}

export async function scanWithdrawalReason(filePath, {
  label = "withdrawal reason",
  expected,
} = {}) {
  await assertRegularFile(filePath, label);
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let carry = "";
  let nonWhitespace = false;
  try {
    for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      const text = decoder.decode(chunk, { stream: true });
      if (/\S/u.test(text)) nonWhitespace = true;
      const window = carry + text;
      scanPublicText(window, label);
      carry = window.slice(-4096);
    }
    const tail = decoder.decode();
    if (/\S/u.test(tail)) nonWhitespace = true;
    scanPublicText(carry + tail, label);
  } catch (error) {
    if (error instanceof TypeError) fail(`${label} is not valid UTF-8`);
    throw error;
  }
  if (!nonWhitespace) fail(`${label} must contain a non-whitespace explanation`);
  const observed = { bytes, sha256: hash.digest("hex") };
  assertExpectedIdentity(observed, expected, label);
  return observed;
}

export const __test = Object.freeze({ PRIVATE_PATH, SECRET_TEXT, DISALLOWED_CONTROL, MAX_CONTROL_LINE_CHARS });
