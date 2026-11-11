const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Decode the small RGBA asset without a platform image library, including all
// PNG row filters so re-encoding the same image does not affect this check.
function rgbaPng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const chunks = [];
  let width, height;
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      assert.deepEqual([...bytes.subarray(offset + 16, offset + 21)], [8, 6, 0, 0, 0]);
    }
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  assert.equal(raw.length, height * (stride + 1));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 4 ? pixels[index - 4] : 0;
      const above = y > 0 ? pixels[index - stride] : 0;
      const corner = y > 0 && x >= 4 ? pixels[index - stride - 4] : 0;
      const prediction = left + above - corner;
      const distances = [left, above, corner].map(value => Math.abs(prediction - value));
      const paeth = [left, above, corner][distances.indexOf(Math.min(...distances))];
      const adjustment = [0, left, above, Math.floor((left + above) / 2), paeth][filter];
      pixels[index] = (raw[y * (stride + 1) + 1 + x] + adjustment) & 255;
    }
  }
  return { width, height, pixels };
}

test("native K glyph has equal left/right and top/bottom margins in its actual PNG", () => {
  const iconPath = path.join(__dirname, "../src-tauri/icons/titlebar-k.png");
  const { width, height, pixels } = rgbaPng(fs.readFileSync(iconPath));
  assert.equal(width, height);
  assert.ok(width >= 32, "retain enough pixels for high-DPI window icons");
  const points = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if ([0, 1, 2, 3].every(channel => pixels[offset + channel] > 240)) points.push([x, y]);
    }
  }
  assert.ok(points.length > width, "white K must be visible on the blue tile");
  for (const [axis, size] of [[0, width], [1, height]]) {
    const min = Math.min(...points.map(point => point[axis]));
    const max = Math.max(...points.map(point => point[axis]));
    assert.ok(Math.abs(min - (size - 1 - max)) <= 1, `glyph margins must match on axis ${axis}`);
  }
});
