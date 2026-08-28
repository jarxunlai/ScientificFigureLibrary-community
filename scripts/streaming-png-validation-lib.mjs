import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createInflate } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_DIMENSION = 16_384;
const DEFAULT_STREAM_WINDOW = 64 * 1024;
const MAX_STREAM_WINDOW = 1024 * 1024;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

class IncrementalCrc32 {
  #value = 0xffffffff;

  update(bytes) {
    let value = this.#value;
    for (const byte of bytes) value = (CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
    this.#value = value;
    return this;
  }

  digestNumber() { return (this.#value ^ 0xffffffff) >>> 0; }
}

function stableStat(stat) {
  return {
    bytes: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    dev: Number(stat.dev),
    ino: Number(stat.ino),
  };
}

function sameStat(left, right) {
  return (
    left.bytes === right.bytes && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.dev === right.dev && left.ino === right.ino
  );
}

function u32be(bytes, offset = 0) {
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

function u16be(bytes, offset = 0) { return bytes[offset] * 0x100 + bytes[offset + 1]; }
function chunkType(bytes) { return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]); }

function legalHeader(width, height, bitDepth, colorType) {
  if (width < 1 || height < 1 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
    throw new Error(`PNG dimensions must be between 1 and ${MAX_PNG_DIMENSION}`);
  }
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!Object.hasOwn(depths, colorType) || !depths[colorType].includes(bitDepth)) {
    throw new Error(`unsupported PNG color type/bit depth: ${colorType}/${bitDepth}`);
  }
}

function channelsFor(colorType) {
  return colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
}

function streamWindow(value) {
  const result = value ?? DEFAULT_STREAM_WINDOW;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_STREAM_WINDOW) {
    throw new Error(`PNG stream window must be an integer between 1 and ${MAX_STREAM_WINDOW}`);
  }
  return result;
}

async function readExact(handle, length, state) {
  const output = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(output, filled, length - filled, state.position + filled);
    if (bytesRead === 0) throw new Error("truncated PNG");
    filled += bytesRead;
  }
  state.position += length;
  state.bytes += length;
  state.fileHash.update(output);
  return output;
}

async function* parseIdat(handle, before, parse, highWaterMark) {
  const stream = { position: 0, bytes: 0, fileHash: createHash("sha256") };
  const signature = await readExact(handle, 8, stream);
  if (!signature.equals(PNG_SIGNATURE)) throw new Error("invalid PNG signature");
  let sawIhdr = false;
  let sawPlte = false;
  let sawTrns = false;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;

  while (!sawIend) {
    const chunkHeader = await readExact(handle, 8, stream);
    const length = u32be(chunkHeader);
    const typeBytes = chunkHeader.subarray(4, 8);
    const type = chunkType(typeBytes);
    if (length > 0x7fffffff) throw new Error("PNG chunk length exceeds the format limit");
    if (!/^[A-Za-z]{4}$/u.test(type) || (typeBytes[2] & 0x20) !== 0) throw new Error(`invalid PNG chunk type: ${JSON.stringify(type)}`);
    if (!sawIhdr && type !== "IHDR") throw new Error("IHDR must be the first PNG chunk");
    if (sawIhdr && type === "IHDR") throw new Error("PNG contains multiple IHDR chunks");
    if (sawIdat && type !== "IDAT") idatEnded = true;
    if (type === "IDAT" && idatEnded) throw new Error("PNG IDAT chunks must be consecutive");
    if (type === "IDAT") {
      if (!parse.header) throw new Error("PNG IDAT precedes IHDR");
      if (parse.header.colorType === 3 && !parse.header.palette) throw new Error("indexed PNG is missing PLTE");
      sawIdat = true;
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new Error("animated PNG chunks are unsupported by the streaming trust decoder");
    }

    const crc = new IncrementalCrc32().update(typeBytes);
    const capture = type === "IHDR" || type === "PLTE" || type === "tRNS";
    if (capture && length > 768) throw new Error(`${type} PNG chunk has an invalid length`);
    const captured = capture ? Buffer.allocUnsafe(length) : undefined;
    let offset = 0;
    while (offset < length) {
      const blockLength = Math.min(length - offset, highWaterMark);
      const block = await readExact(handle, blockLength, stream);
      parse.peakChunkBytes = Math.max(parse.peakChunkBytes, block.byteLength);
      crc.update(block);
      if (captured) block.copy(captured, offset);
      offset += blockLength;
      if (type === "IDAT") {
        parse.totalIdatBytes += block.byteLength;
        yield block;
      }
    }
    const expectedCrc = u32be(await readExact(handle, 4, stream));
    if (crc.digestNumber() !== expectedCrc) throw new Error(`PNG ${type} chunk CRC mismatch`);

    if (type === "IHDR") {
      if (length !== 13 || !captured) throw new Error("PNG IHDR must contain 13 bytes");
      const width = u32be(captured);
      const height = u32be(captured, 4);
      const bitDepth = captured[8];
      const colorType = captured[9];
      legalHeader(width, height, bitDepth, colorType);
      if (captured[10] !== 0 || captured[11] !== 0) throw new Error("unsupported PNG compression or filter method");
      if (captured[12] !== 0) throw new Error("interlaced PNG is unsupported by the streaming trust decoder");
      const channels = channelsFor(colorType);
      parse.header = {
        width,
        height,
        bitDepth,
        colorType,
        channels,
        rowBytes: Math.ceil(width * channels * bitDepth / 8),
        filterBytesPerPixel: bitDepth < 8 ? 1 : channels * (bitDepth / 8),
      };
      sawIhdr = true;
    } else if (type === "PLTE") {
      const header = parse.header;
      if (
        sawPlte || sawTrns || sawIdat || length === 0 || length % 3 !== 0 || length > 768 ||
        header.colorType === 0 || header.colorType === 4
      ) throw new Error("invalid PNG PLTE chunk");
      if (header.colorType === 3 && length / 3 > 2 ** header.bitDepth) throw new Error("PNG palette exceeds bit-depth capacity");
      header.palette = new Uint8Array(captured);
      sawPlte = true;
    } else if (type === "tRNS") {
      const header = parse.header;
      if (sawTrns || sawIdat || header.colorType === 4 || header.colorType === 6) throw new Error("invalid PNG tRNS chunk");
      if (header.colorType === 3) {
        if (!header.palette || length === 0 || length > header.palette.length / 3) throw new Error("invalid indexed PNG tRNS chunk");
        header.paletteAlpha = new Uint8Array(captured);
      } else if (header.colorType === 0) {
        if (length !== 2) throw new Error("grayscale PNG tRNS must contain two bytes");
        header.transparentGray = u16be(captured);
        if (header.transparentGray > 2 ** header.bitDepth - 1) throw new Error("grayscale PNG tRNS sample exceeds its bit depth");
      } else {
        if (length !== 6) throw new Error("truecolor PNG tRNS must contain six bytes");
        header.transparentRgb = [u16be(captured), u16be(captured, 2), u16be(captured, 4)];
        if (header.transparentRgb.some((sample) => sample > 2 ** header.bitDepth - 1)) {
          throw new Error("truecolor PNG tRNS sample exceeds its bit depth");
        }
      }
      sawTrns = true;
    } else if (type === "IDAT") {
    } else if (type === "IEND") {
      if (length !== 0 || !sawIdat || parse.totalIdatBytes === 0) throw new Error("invalid PNG IEND or missing image data");
      sawIend = true;
    } else if ((typeBytes[0] & 0x20) === 0) {
      throw new Error(`unsupported critical PNG chunk: ${type}`);
    }
  }
  if (stream.position !== before.bytes) throw new Error("PNG contains trailing bytes after IEND");
  parse.fileBytes = stream.bytes;
  parse.fileSha256 = stream.fileHash.digest("hex");
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  return distanceLeft <= distanceUp && distanceLeft <= distanceUpperLeft ? left : distanceUp <= distanceUpperLeft ? up : upperLeft;
}

function unfilter(filter, raw, output, previous, bytesPerPixel) {
  if (filter > 4) throw new Error(`unsupported PNG scanline filter: ${filter}`);
  for (let index = 0; index < raw.length; index += 1) {
    const left = index >= bytesPerPixel ? output[index - bytesPerPixel] : 0;
    const up = previous[index];
    const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
    const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
    output[index] = (raw[index] + predictor) & 0xff;
  }
}

function sampleAt(row, sampleIndex, bitDepth) {
  if (bitDepth === 8) return row[sampleIndex];
  if (bitDepth === 16) return u16be(row, sampleIndex * 2);
  const bitOffset = sampleIndex * bitDepth;
  const shift = 8 - bitDepth - (bitOffset & 7);
  return (row[bitOffset >>> 3] >>> shift) & ((1 << bitDepth) - 1);
}

function scaleSample(sample, bitDepth) {
  return bitDepth === 8 ? sample : Math.floor(sample * 255 / (2 ** bitDepth - 1) + 0.5);
}

function rowToRgba(header, row, rgba) {
  const { width, bitDepth, colorType } = header;
  for (let x = 0; x < width; x += 1) {
    const target = x * 4;
    if (colorType === 0) {
      const gray = sampleAt(row, x, bitDepth);
      if (header.transparentGray === gray) rgba.fill(0, target, target + 4);
      else {
        const scaled = scaleSample(gray, bitDepth);
        rgba[target] = scaled;
        rgba[target + 1] = scaled;
        rgba[target + 2] = scaled;
        rgba[target + 3] = 255;
      }
    } else if (colorType === 2) {
      const red = sampleAt(row, x * 3, bitDepth);
      const green = sampleAt(row, x * 3 + 1, bitDepth);
      const blue = sampleAt(row, x * 3 + 2, bitDepth);
      if (header.transparentRgb?.[0] === red && header.transparentRgb[1] === green && header.transparentRgb[2] === blue) {
        rgba.fill(0, target, target + 4);
      } else {
        rgba[target] = scaleSample(red, bitDepth);
        rgba[target + 1] = scaleSample(green, bitDepth);
        rgba[target + 2] = scaleSample(blue, bitDepth);
        rgba[target + 3] = 255;
      }
    } else if (colorType === 3) {
      const index = sampleAt(row, x, bitDepth);
      const paletteOffset = index * 3;
      if (!header.palette || paletteOffset + 2 >= header.palette.length) throw new Error(`PNG palette index ${index} is undefined`);
      rgba[target] = header.palette[paletteOffset];
      rgba[target + 1] = header.palette[paletteOffset + 1];
      rgba[target + 2] = header.palette[paletteOffset + 2];
      rgba[target + 3] = header.paletteAlpha?.[index] ?? 255;
    } else if (colorType === 4) {
      const gray = scaleSample(sampleAt(row, x * 2, bitDepth), bitDepth);
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = scaleSample(sampleAt(row, x * 2 + 1, bitDepth), bitDepth);
    } else {
      rgba[target] = scaleSample(sampleAt(row, x * 4, bitDepth), bitDepth);
      rgba[target + 1] = scaleSample(sampleAt(row, x * 4 + 1, bitDepth), bitDepth);
      rgba[target + 2] = scaleSample(sampleAt(row, x * 4 + 2, bitDepth), bitDepth);
      rgba[target + 3] = scaleSample(sampleAt(row, x * 4 + 3, bitDepth), bitDepth);
    }
  }
}

/** Strictly validates one file-backed PNG and incrementally hashes canonical RGBA scanlines. */
export async function inspectPngStream(filePath, { highWaterMark } = {}) {
  const window = streamWindow(highWaterMark);
  const resolved = path.resolve(filePath);
  const linkStat = await fs.lstat(resolved);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw new Error("PNG source must be a regular non-symbolic-link file");
  const handle = await fs.open(resolved, "r");
  try {
    const before = stableStat(await handle.stat());
    const parse = { totalIdatBytes: 0, fileBytes: 0, peakChunkBytes: 0 };
    const iterator = parseIdat(handle, before, parse, window)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const header = parse.header;
    if (!header || first.done) throw new Error("PNG contains no image data");
    const inflater = createInflate({ chunkSize: Math.max(64, window) });
    let producerError;
    const produce = (async () => {
      try {
        let item = first;
        while (!item.done) {
          if (!inflater.write(item.value)) await once(inflater, "drain");
          item = await iterator.next();
        }
        inflater.end();
      } catch (error) {
        producerError = error;
        inflater.destroy(error instanceof Error ? error : new Error("PNG chunk parsing failed", { cause: error }));
      }
    })();
    const rgbaHash = createHash("sha256");
    let previous = new Uint8Array(header.rowBytes);
    let current = new Uint8Array(header.rowBytes);
    const encodedRow = new Uint8Array(header.rowBytes + 1);
    const rgbaRow = new Uint8Array(header.width * 4);
    let encodedOffset = 0;
    let rows = 0;
    let inflatedBytes = 0;
    let peakInflateChunk = 0;
    let consumerError;
    try {
      for await (const output of inflater) {
        const bytes = output;
        peakInflateChunk = Math.max(peakInflateChunk, bytes.byteLength);
        inflatedBytes += bytes.byteLength;
        let sourceOffset = 0;
        while (sourceOffset < bytes.byteLength) {
          if (rows >= header.height) throw new Error("PNG inflate stream contains trailing scanline bytes");
          const amount = Math.min(encodedRow.byteLength - encodedOffset, bytes.byteLength - sourceOffset);
          encodedRow.set(bytes.subarray(sourceOffset, sourceOffset + amount), encodedOffset);
          encodedOffset += amount;
          sourceOffset += amount;
          if (encodedOffset === encodedRow.byteLength) {
            unfilter(encodedRow[0], encodedRow.subarray(1), current, previous, header.filterBytesPerPixel);
            rowToRgba(header, current, rgbaRow);
            rgbaHash.update(rgbaRow);
            const swap = previous;
            previous = current;
            current = swap;
            encodedOffset = 0;
            rows += 1;
          }
        }
      }
      await produce;
    } catch (error) {
      consumerError = error;
      inflater.destroy(error instanceof Error ? error : new Error("PNG scanline decoding failed", { cause: error }));
      await produce;
    }
    if (producerError) throw producerError;
    if (consumerError) throw consumerError;
    if (rows !== header.height || encodedOffset !== 0 || inflatedBytes !== header.height * (header.rowBytes + 1)) {
      throw new Error("PNG inflate stream does not contain the exact declared scanlines");
    }
    if (inflater.bytesWritten !== parse.totalIdatBytes) throw new Error("PNG IDAT contains trailing compressed payload");
    if (!parse.fileSha256 || parse.fileBytes !== before.bytes) throw new Error("PNG parser did not consume the complete file");
    const after = stableStat(await handle.stat());
    const pathAfter = await fs.lstat(resolved);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || !sameStat(before, after) || !sameStat(before, stableStat(pathAfter))) {
      throw new Error("PNG source changed while it was inspected");
    }
    return {
      path: resolved,
      ...after,
      bytes: parse.fileBytes,
      sha256: parse.fileSha256,
      mediaType: "image/png",
      width: header.width,
      height: header.height,
      bitDepth: header.bitDepth,
      colorType: header.colorType,
      canonicalRgbaSha256: rgbaHash.digest("hex"),
      canonicalRgbaBytes: header.width * header.height * 4,
      peakBufferedBytes:
        parse.peakChunkBytes + peakInflateChunk + encodedRow.byteLength +
        previous.byteLength + current.byteLength + rgbaRow.byteLength,
    };
  } finally {
    await handle.close();
  }
}
