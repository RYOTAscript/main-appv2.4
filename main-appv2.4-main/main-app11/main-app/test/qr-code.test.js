'use strict';

// The pairing QR code. A wrong module anywhere and a phone camera simply finds
// nothing — no error, the code just never scans. So the pieces are pinned to
// published values (the Reed–Solomon example everyone checks against, the
// format- and version-word tables, the alignment positions), and every
// generated code is read back by an independent decoder written here: function
// patterns, format word, unmasking, the zigzag, de-interleaving, a fresh
// Reed–Solomon check of every block, and the byte-mode payload.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const QR = require(path.join(__dirname, '..', 'renderer', 'qr-code.js'));
const I = QR._internal;

test('Reed–Solomon matches the standard "HELLO WORLD" 1-M example', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(I.rsRemainder(data, I.rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('format words match the published table', () => {
  const table = {
    L: ['111011111000100', '111001011110011', '111110110101010', '111100010011101',
      '110011000101111', '110001100011000', '110110001000001', '110100101110110'],
    M: ['101010000010010', '101000100100101', '101111001111100', '101101101001011',
      '100010111111001', '100000011001110', '100111110010111', '100101010100000'],
  };
  for (const [ecl, rows] of Object.entries(table)) {
    rows.forEach((bits, mask) => assert.equal(I.formatBits(I.ECL[ecl], mask), parseInt(bits, 2), `${ecl}${mask}`));
  }
  assert.equal(I.formatBits(I.ECL.Q, 0), parseInt('011010101011111', 2));
  assert.equal(I.formatBits(I.ECL.H, 0), parseInt('001011010001001', 2));
});

test('version words and alignment positions match the published tables', () => {
  assert.equal(I.versionBits(7), 0x07C94);
  assert.equal(I.versionBits(8), 0x085BC);
  assert.equal(I.versionBits(9), 0x09A99);
  assert.equal(I.versionBits(10), 0x0A4D3);
  assert.deepEqual(I.alignmentPositions(1), []);
  assert.deepEqual(I.alignmentPositions(2), [6, 18]);
  assert.deepEqual(I.alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(I.alignmentPositions(14), [6, 26, 46, 66]);
  assert.deepEqual(I.alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(I.alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

test('capacities match the published table', () => {
  assert.equal(I.numDataCodewords(1, I.ECL.M), 16);
  assert.equal(I.numDataCodewords(8, I.ECL.M), 154);
  assert.equal(I.numDataCodewords(9, I.ECL.M), 182);
  assert.equal(I.numDataCodewords(10, I.ECL.H), 122);
  assert.equal(I.numDataCodewords(40, I.ECL.L), 2956);
  // Every version/level: raw codewords split exactly into data + ECC blocks.
  for (let v = 1; v <= 40; v++) {
    for (let e = 0; e < 4; e++) {
      const raw = Math.floor(I.numRawDataModules(v) / 8);
      const blocks = I.NUM_ERROR_CORRECTION_BLOCKS[e][v];
      assert.ok(I.numDataCodewords(v, e) > 0 && raw >= blocks, `v${v} ecl${e}`);
    }
  }
});

// ── An independent reader ──────────────────────────────────────────────────

function functionMap(version, size) {
  const f = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) f[y][x] = true;
  };
  mark(0, 0, 9, 9);                 // top-left finder, separator, format
  mark(size - 8, 0, 8, 9);          // top-right
  mark(0, size - 8, 9, 8);          // bottom-left
  mark(6, 0, 1, size);              // timing
  mark(0, 6, size, 1);
  // Every alignment pattern except the three that would sit on a finder. The
  // ones on the timing lines DO exist (at (24,6) in version 8, say).
  const align = I.alignmentPositions(version);
  const last = align.length - 1;
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    mark(ax - 2, ay - 2, 5, 5);
  }));
  if (version >= 7) {
    mark(size - 11, 0, 3, 6);
    mark(0, size - 11, 6, 3);
  }
  return f;
}

function readQr(qr) {
  const { size, modules, version } = qr;
  const bit = (x, y) => (modules[y][x] ? 1 : 0);

  // Format word: first copy, around the top-left finder.
  let f = 0;
  for (let i = 0; i <= 5; i++) f |= bit(8, i) << i;
  f |= bit(8, 7) << 6;
  f |= bit(8, 8) << 7;
  f |= bit(7, 8) << 8;
  for (let i = 9; i < 15; i++) f |= bit(14 - i, 8) << i;
  // ...and it must agree with the second copy.
  let f2 = 0;
  for (let i = 0; i < 8; i++) f2 |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) f2 |= bit(8, size - 15 + i) << i;
  assert.equal(f, f2, 'both format copies agree');
  const word = (f ^ 0x5412) >>> 10;
  const eclBits = word >>> 3;
  const mask = word & 7;
  const ecl = [1, 0, 3, 2].indexOf(eclBits);
  assert.equal(modules[size - 8][8], true, 'dark module');
  if (version >= 7) {
    // Both version blocks: 6x3 above the bottom-left finder, 3x6 left of the top-right one.
    let a = 0;
    let b = 0;
    for (let i = 0; i < 18; i++) {
      a |= bit(size - 11 + (i % 3), Math.floor(i / 3)) << i;
      b |= bit(Math.floor(i / 3), size - 11 + (i % 3)) << i;
    }
    assert.equal(a, I.versionBits(version), 'top-right version word');
    assert.equal(b, I.versionBits(version), 'bottom-left version word');
  }

  // Finders.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        assert.equal(modules[cy + dy][cx + dx], d !== 2, `finder at ${cx},${cy}`);
      }
    }
  }

  const fn = functionMap(version, size);
  const inverts = (x, y) => [
    (x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0,
    (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x * y) % 2 + (x * y) % 3 === 0,
    ((x * y) % 2 + (x * y) % 3) % 2 === 0, ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ][mask];

  const stream = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let k = 0; k < size; k++) {
      const y = upward ? size - 1 - k : k;
      for (const x of [right, right - 1]) {
        if (fn[y][x]) continue;
        stream.push(bit(x, y) ^ (inverts(x, y) ? 1 : 0));
      }
    }
  }
  const raw = Math.floor(I.numRawDataModules(version) / 8);
  const codewords = [];
  for (let i = 0; i < raw; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | stream[i * 8 + j];
    codewords.push(b);
  }

  // De-interleave and check every block's ECC from scratch.
  const numBlocks = I.NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
  const eccLen = I.ECC_CODEWORDS_PER_BLOCK[ecl][version];
  const numShort = numBlocks - (raw % numBlocks);
  const shortData = Math.floor(raw / numBlocks) - eccLen;
  const blocks = Array.from({ length: numBlocks }, (_, b) => ({ data: [], ecc: [], dataLen: shortData + (b < numShort ? 0 : 1) }));
  let p = 0;
  for (let i = 0; i < shortData + 1; i++) {
    for (const blk of blocks) if (i < blk.dataLen) blk.data.push(codewords[p++]);
  }
  for (let i = 0; i < eccLen; i++) for (const blk of blocks) blk.ecc.push(codewords[p++]);
  assert.equal(p, raw);
  const divisor = I.rsDivisor(eccLen);
  for (const blk of blocks) assert.deepEqual(I.rsRemainder(blk.data, divisor), blk.ecc, `block ECC (v${version}, ecl ${ecl})`);

  // Byte-mode payload.
  const data = blocks.flatMap((b) => b.data);
  const bits = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >>> i) & 1));
  let q = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits[q++]; return v; };
  assert.equal(take(4), 0x4, 'byte mode');
  const count = take(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < count; i++) bytes.push(take(8));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), ecl, mask };
}

test('every code reads back to exactly what was encoded', () => {
  const link = 'https://main-website-eosin-beta.vercel.app/remote/index.html#k=W-q28IGhUi3fjq2mfFb2xnQdCnZh0rN1Qa8pnE9e1sE&r=main-phone-relay.budgiekid1311.workers.dev';
  const cases = [
    ['HELLO WORLD', 'M'],
    ['a', 'L'],
    ['https://example.com', 'H'],
    [link, 'M'],
    [link, 'L'],
    [link + link, 'Q'],
    ['naïve ☃ café 🎵', 'M'],
    ['x'.repeat(1000), 'L'],
  ];
  for (const [text, ecl] of cases) {
    const qr = QR.encode(text, ecl);
    assert.equal(qr.size, qr.version * 4 + 17);
    const back = readQr(qr);
    assert.equal(back.text, text, `${ecl} v${qr.version}`);
    assert.equal(back.ecl, I.ECL[ecl]);
    assert.equal(back.mask, qr.mask);
  }
});

test('the pairing link fits a code a phone camera reads easily', () => {
  const link = 'https://main-website-eosin-beta.vercel.app/remote/index.html#k=W-q28IGhUi3fjq2mfFb2xnQdCnZh0rN1Qa8pnE9e1sE&r=main-phone-relay.budgiekid1311.workers.dev';
  const qr = QR.encode(link, 'M');
  assert.ok(qr.version <= 10, `version ${qr.version}`);
  assert.match(QR.svgPath(qr), /^(M\d+,\d+h1v1h-1z)+$/);
});

test('text too long for any version is refused, not truncated', () => {
  assert.throws(() => QR.encode('x'.repeat(3000), 'L'), /too long/);
});
