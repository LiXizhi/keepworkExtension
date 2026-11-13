// Read bounded ZIP members without extracting or executing untrusted files.
const zlib = require('node:zlib');

function readRuntimeArchive(bytes) {
  if (bytes.length > 128 * 1024 * 1024 || bytes.length < 22) throw Error('Invalid runtime archive size');
  const end = bytes.lastIndexOf(Buffer.from('PK\x05\x06'));
  if (end < 0 || end + 22 > bytes.length || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
    || bytes.readUInt32LE(end + 4) !== 0) throw Error('Unsupported runtime ZIP layout');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16), total = 0;
  if (count > 256 || bytes.readUInt16LE(end + 8) !== count || cursor + size !== end) throw Error('Invalid runtime ZIP directory');
  const members = new Map();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw Error('Invalid runtime ZIP entry');
    const nameSize = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameSize + extra + comment;
    if (next > end) throw Error('Truncated runtime ZIP directory');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    const parts = name.replace(/\/$/, '').split('/');
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if (!name || name.includes('\\') || name.includes('\0') || parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))
      || (mode & 0xf000) === 0xa000 || members.has(name)) throw Error('Unsafe or duplicate runtime ZIP member');
    const compressedSize = bytes.readUInt32LE(cursor + 20), uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const method = bytes.readUInt16LE(cursor + 10), flags = bytes.readUInt16LE(cursor + 8), offset = bytes.readUInt32LE(cursor + 42);
    total += uncompressedSize;
    if (total > 64 * 1024 * 1024 || uncompressedSize > 32 * 1024 * 1024 || (flags & 1) || ![0, 8].includes(method)
      || offset + 30 > end || bytes.readUInt32LE(offset) !== 0x04034b50) throw Error('Unsupported or oversized runtime ZIP member');
    const localNameSize = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + localNameSize + localExtra;
    if (dataOffset + compressedSize > end || bytes.subarray(offset + 30, offset + 30 + localNameSize).toString('utf8') !== name) throw Error('Runtime ZIP local header mismatch');
    const data = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 32 * 1024 * 1024 }) : Buffer.from(data);
    if (content.length !== uncompressedSize) throw Error('Runtime ZIP expanded size mismatch');
    members.set(name, content);
    cursor = next;
  }
  if (cursor !== end) throw Error('Invalid runtime ZIP directory length');
  return members;
}

module.exports = { readRuntimeArchive };
