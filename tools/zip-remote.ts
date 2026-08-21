'use strict';

/**
 * Minimal read-only ZIP client that works over HTTP range requests.
 *
 * The 136M Keystrokes archive is 1.4 GB and holds one file per participant, but
 * a model only needs a few thousand of them. Reading the central directory and
 * then pulling just the sampled entries keeps the download at a few tens of MB
 * instead of the whole archive.
 */

import * as https from 'node:https';
import * as zlib from 'node:zlib';

const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const ZIP64_EXTRA_ID = 0x0001;
/** Field value meaning "the real number lives in the zip64 extra field". */
const NEEDS_ZIP64 = 0xffffffff;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface RemoteZipOptions {
  /** Called with the byte count of each range response, for progress output. */
  onBytes?: (bytes: number) => void;
}

export class RemoteZip {
  private constructor(
    private readonly url: string,
    private readonly options: RemoteZipOptions,
    readonly size: number,
    readonly entries: ZipEntry[],
  ) {}

  /** Fetches `length` bytes starting at `offset`. */
  private static request(url: string, offset: number, length: number): Promise<Buffer> {
    const end = offset + length - 1;
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { Range: 'bytes=' + offset + '-' + end } }, (res) => {
        if (res.statusCode !== 206) {
          res.resume();
          reject(new Error('Expected 206 for range ' + offset + '-' + end + ', got ' + res.statusCode));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('Range request timed out')));
    });
  }

  private async range(offset: number, length: number): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const buffer = await RemoteZip.request(this.url, offset, length);
        this.options.onBytes?.(buffer.length);
        return buffer;
      } catch (err) {
        lastError = err;
        // The host throttles bursts of range requests; back off rather than hammer it.
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private static contentLength(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'HEAD' }, (res) => {
        res.resume();
        const length = Number(res.headers['content-length']);
        if (!Number.isFinite(length)) reject(new Error('Server did not report a content length'));
        else if (res.headers['accept-ranges'] !== 'bytes') reject(new Error('Server does not support range requests'));
        else resolve(length);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** Reads the archive's central directory so its entries can be fetched individually. */
  static async open(url: string, options: RemoteZipOptions = {}): Promise<RemoteZip> {
    const size = await RemoteZip.contentLength(url);
    const tailLength = Math.min(size, 128 * 1024);
    const tail = await RemoteZip.request(url, size - tailLength, tailLength);

    const eocd = lastIndexOfSignature(tail, SIG_EOCD);
    if (eocd < 0) throw new Error('No end-of-central-directory record found');

    let entryCount = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);

    // Archives with more than 65535 entries or past the 4 GB mark carry the real
    // values in a zip64 record ahead of the classic one.
    const zip64 = lastIndexOfSignature(tail, SIG_ZIP64_EOCD);
    if (zip64 >= 0) {
      entryCount = Number(tail.readBigUInt64LE(zip64 + 32));
      directorySize = Number(tail.readBigUInt64LE(zip64 + 40));
      directoryOffset = Number(tail.readBigUInt64LE(zip64 + 48));
    }

    const zip = new RemoteZip(url, options, size, []);
    const directory = await zip.range(directoryOffset, directorySize);
    // Appended one at a time: spreading 168k entries into push overflows the stack.
    for (const entry of parseCentralDirectory(directory, entryCount)) zip.entries.push(entry);
    return zip;
  }

  /** Downloads and decompresses a single entry. */
  async read(entry: ZipEntry): Promise<Buffer> {
    // The local header repeats the name and may carry a different extra field,
    // so its length has to be read rather than assumed from the central record.
    const guess = Math.min(30 + entry.name.length + 4096 + entry.compressedSize, this.size - entry.localHeaderOffset);
    let block = await this.range(entry.localHeaderOffset, guess);

    const nameLength = block.readUInt16LE(26);
    const extraLength = block.readUInt16LE(28);
    const dataStart = 30 + nameLength + extraLength;

    if (dataStart + entry.compressedSize > block.length) {
      block = await this.range(entry.localHeaderOffset, dataStart + entry.compressedSize);
    }

    const payload = block.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(payload);
    if (entry.method === 8) return zlib.inflateRawSync(payload);
    throw new Error('Unsupported compression method ' + entry.method + ' for ' + entry.name);
  }
}

function lastIndexOfSignature(buffer: Buffer, signature: number): number {
  for (let i = buffer.length - 4; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === signature) return i;
  }
  return -1;
}

function parseCentralDirectory(directory: Buffer, entryCount: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let cursor = 0;

  for (let i = 0; i < entryCount && cursor + 46 <= directory.length; i++) {
    if (directory.readUInt32LE(cursor) !== SIG_CENTRAL) break;

    const method = directory.readUInt16LE(cursor + 10);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    let compressedSize = directory.readUInt32LE(cursor + 20);
    let uncompressedSize = directory.readUInt32LE(cursor + 24);
    let localHeaderOffset = directory.readUInt32LE(cursor + 42);

    if (compressedSize === NEEDS_ZIP64 || uncompressedSize === NEEDS_ZIP64 || localHeaderOffset === NEEDS_ZIP64) {
      const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const zip64 = findExtraField(extra, ZIP64_EXTRA_ID);
      if (zip64) {
        // Only the overflowed fields are present, and always in this order.
        let at = 0;
        if (uncompressedSize === NEEDS_ZIP64) { uncompressedSize = Number(zip64.readBigUInt64LE(at)); at += 8; }
        if (compressedSize === NEEDS_ZIP64) { compressedSize = Number(zip64.readBigUInt64LE(at)); at += 8; }
        if (localHeaderOffset === NEEDS_ZIP64) { localHeaderOffset = Number(zip64.readBigUInt64LE(at)); at += 8; }
      }
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findExtraField(extra: Buffer, id: number): Buffer | null {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const fieldId = extra.readUInt16LE(cursor);
    const fieldSize = extra.readUInt16LE(cursor + 2);
    if (fieldId === id) return extra.subarray(cursor + 4, cursor + 4 + fieldSize);
    cursor += 4 + fieldSize;
  }
  return null;
}
