// QR codes for the Phone Remote pairing link (renderer/phone-remote.js draws
// the matrix as SVG). Byte mode, versions 1–40, error correction L/M/Q/H, and
// all eight masks scored with the standard penalty rules. Pure + UMD, so the
// tests run the same file the panel does (test/qr-code.test.js).
//
// The block tables are ISO/IEC 18004's; everything else is derived from them.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.QRCode = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const ECL = { L: 0, M: 1, Q: 2, H: 3 };
    const ECL_FORMAT_BITS = [1, 0, 3, 2];   // L, M, Q, H as the format word spells them

    // [ecl][version] — index 0 is unused.
    const ECC_CODEWORDS_PER_BLOCK = [
        [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
        [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    ];
    const NUM_ERROR_CORRECTION_BLOCKS = [
        [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
        [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
        [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
        [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
    ];

    const getBit = (x, i) => ((x >>> i) & 1) !== 0;

    /** Data modules in a version once every function pattern is taken out. */
    function numRawDataModules(ver) {
        let result = (16 * ver + 128) * ver + 64;
        if (ver >= 2) {
            const numAlign = Math.floor(ver / 7) + 2;
            result -= (25 * numAlign - 10) * numAlign - 55;
            if (ver >= 7) result -= 36;
        }
        return result;
    }

    function numDataCodewords(ver, ecl) {
        return Math.floor(numRawDataModules(ver) / 8)
            - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    }

    // ── Reed–Solomon over GF(2^8), x^8 + x^4 + x^3 + x^2 + 1 ───────────────

    function gfMultiply(x, y) {
        let z = 0;
        for (let i = 7; i >= 0; i--) {
            z = (z << 1) ^ ((z >>> 7) * 0x11D);
            z ^= ((y >>> i) & 1) * x;
        }
        return z;
    }

    function rsDivisor(degree) {
        const result = new Array(degree).fill(0);
        result[degree - 1] = 1;
        let root = 1;
        for (let i = 0; i < degree; i++) {
            for (let j = 0; j < result.length; j++) {
                result[j] = gfMultiply(result[j], root);
                if (j + 1 < result.length) result[j] ^= result[j + 1];
            }
            root = gfMultiply(root, 0x02);
        }
        return result;
    }

    function rsRemainder(data, divisor) {
        const result = divisor.map(() => 0);
        for (const b of data) {
            const factor = b ^ result.shift();
            result.push(0);
            divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
        }
        return result;
    }

    /** Splits data into the version's blocks, adds each block's ECC, interleaves. */
    function addEccAndInterleave(data, ver, ecl) {
        const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
        const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
        const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
        const numShortBlocks = numBlocks - rawCodewords % numBlocks;
        const shortBlockLen = Math.floor(rawCodewords / numBlocks);
        const divisor = rsDivisor(blockEccLen);
        const blocks = [];
        for (let i = 0, k = 0; i < numBlocks; i++) {
            const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
            k += dat.length;
            const ecc = rsRemainder(dat, divisor);
            if (i < numShortBlocks) dat.push(0);   // placeholder, skipped below
            blocks.push(dat.concat(ecc));
        }
        const result = [];
        for (let i = 0; i < blocks[0].length; i++) {
            blocks.forEach((block, j) => {
                if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
            });
        }
        return result;
    }

    function alignmentPositions(ver) {
        if (ver === 1) return [];
        const numAlign = Math.floor(ver / 7) + 2;
        const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
        const result = [6];
        for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
        return result;
    }

    /** The 15-bit format word for an error-correction level and mask. */
    function formatBits(ecl, mask) {
        const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        return ((data << 10) | rem) ^ 0x5412;
    }

    /** The 18-bit version word (versions 7 and up). */
    function versionBits(ver) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
        return (ver << 12) | rem;
    }

    function maskInverts(mask, x, y) {
        switch (mask) {
            case 0: return (x + y) % 2 === 0;
            case 1: return y % 2 === 0;
            case 2: return x % 3 === 0;
            case 3: return (x + y) % 3 === 0;
            case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            case 5: return (x * y) % 2 + (x * y) % 3 === 0;
            case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
            default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
        }
    }

    /**
     * Encode text as a QR code. Returns { version, size, ecl, mask, modules },
     * where modules[y][x] is true for a dark module. The 4-module quiet zone is
     * left to the renderer.
     */
    function encode(text, eclName = 'M') {
        const ecl = ECL[eclName];
        if (ecl === undefined) throw new Error('bad error correction level');
        const bytes = Array.from(new TextEncoder().encode(String(text)));

        let ver = 1;
        let capacityBits = 0;
        for (; ; ver++) {
            if (ver > 40) throw new Error('text too long for a QR code');
            capacityBits = numDataCodewords(ver, ecl) * 8;
            if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= capacityBits) break;
        }

        // Mode, count, data, terminator, byte padding, then alternating pad bytes.
        const bits = [];
        const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
        push(0x4, 4);
        push(bytes.length, ver <= 9 ? 8 : 16);
        bytes.forEach((b) => push(b, 8));
        push(0, Math.min(4, capacityBits - bits.length));
        push(0, (8 - (bits.length % 8)) % 8);
        for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) push(pad, 8);
        const data = [];
        for (let i = 0; i < bits.length; i += 8) {
            let b = 0;
            for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
            data.push(b);
        }
        const codewords = addEccAndInterleave(data, ver, ecl);

        const size = ver * 4 + 17;
        const modules = Array.from({ length: size }, () => new Array(size).fill(false));
        const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
        const setFunction = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };

        // Timing patterns, then the three finders (with separators).
        for (let i = 0; i < size; i++) {
            setFunction(6, i, i % 2 === 0);
            setFunction(i, 6, i % 2 === 0);
        }
        const drawFinder = (cx, cy) => {
            for (let dy = -4; dy <= 4; dy++) {
                for (let dx = -4; dx <= 4; dx++) {
                    const x = cx + dx;
                    const y = cy + dy;
                    if (x < 0 || x >= size || y < 0 || y >= size) continue;
                    const dist = Math.max(Math.abs(dx), Math.abs(dy));
                    setFunction(x, y, dist !== 2 && dist !== 4);
                }
            }
        };
        drawFinder(3, 3);
        drawFinder(size - 4, 3);
        drawFinder(3, size - 4);

        const align = alignmentPositions(ver);
        for (let i = 0; i < align.length; i++) {
            for (let j = 0; j < align.length; j++) {
                const last = align.length - 1;
                if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        setFunction(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                    }
                }
            }
        }

        const drawFormat = (mask) => {
            const f = formatBits(ecl, mask);
            for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(f, i));
            setFunction(8, 7, getBit(f, 6));
            setFunction(8, 8, getBit(f, 7));
            setFunction(7, 8, getBit(f, 8));
            for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(f, i));
            for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(f, i));
            for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(f, i));
            setFunction(8, size - 8, true);   // the always-dark module
        };
        drawFormat(0);   // reserves the format areas before data goes in

        if (ver >= 7) {
            const v = versionBits(ver);
            for (let i = 0; i < 18; i++) {
                const dark = getBit(v, i);
                const a = size - 11 + (i % 3);
                const b = Math.floor(i / 3);
                setFunction(a, b, dark);
                setFunction(b, a, dark);
            }
        }

        // Codewords in the two-column zigzag from the bottom right, skipping the
        // vertical timing column.
        let bitIndex = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? size - 1 - vert : vert;
                    if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
                        modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
                        bitIndex++;
                    }
                }
            }
        }

        const applyMask = (mask) => {
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    if (!isFunction[y][x] && maskInverts(mask, x, y)) modules[y][x] = !modules[y][x];
                }
            }
        };

        let best = 0;
        let bestScore = Infinity;
        for (let mask = 0; mask < 8; mask++) {
            applyMask(mask);
            drawFormat(mask);
            const score = penalty(modules, size);
            if (score < bestScore) { best = mask; bestScore = score; }
            applyMask(mask);   // XOR again undoes it
        }
        applyMask(best);
        drawFormat(best);
        return { version: ver, size, ecl: eclName, mask: best, modules };
    }

    // ── Mask penalty (ISO/IEC 18004 §8.8.2) ─────────────────────────────────

    function penalty(modules, size) {
        let result = 0;
        const line = (get) => {
            let runColor = false;
            let runLength = 0;
            const history = [0, 0, 0, 0, 0, 0, 0];
            const addHistory = (len) => {
                if (history[0] === 0) len += size;   // the light border counts as light
                history.pop();
                history.unshift(len);
            };
            const finderLike = () => {
                const n = history[1];
                const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
                return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0)
                    + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
            };
            for (let i = 0; i < size; i++) {
                if (get(i) === runColor) {
                    runLength++;
                    if (runLength === 5) result += 3;
                    else if (runLength > 5) result++;
                } else {
                    addHistory(runLength);
                    if (!runColor) result += finderLike() * 40;
                    runColor = get(i);
                    runLength = 1;
                }
            }
            if (runColor) { addHistory(runLength); runLength = 0; }
            addHistory(runLength + size);
            result += finderLike() * 40;
        };
        for (let y = 0; y < size; y++) line((x) => modules[y][x]);
        for (let x = 0; x < size; x++) line((y) => modules[y][x]);

        for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
                const c = modules[y][x];
                if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
            }
        }

        let dark = 0;
        for (const row of modules) for (const c of row) if (c) dark++;
        const total = size * size;
        result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
        return result;
    }

    /** SVG path data for the dark modules, offset by `margin` modules. */
    function svgPath(qr, margin = 4) {
        let d = '';
        for (let y = 0; y < qr.size; y++) {
            for (let x = 0; x < qr.size; x++) {
                if (qr.modules[y][x]) d += `M${x + margin},${y + margin}h1v1h-1z`;
            }
        }
        return d;
    }

    return {
        encode, svgPath,
        // exposed for the tests
        _internal: { addEccAndInterleave, rsDivisor, rsRemainder, formatBits, versionBits, alignmentPositions, numDataCodewords, numRawDataModules, ECL, ECC_CODEWORDS_PER_BLOCK, NUM_ERROR_CORRECTION_BLOCKS },
    };
}));
