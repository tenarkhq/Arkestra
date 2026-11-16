/*---------------------------------------------------------------------------------------------
 *  Arkestra. A QR code for the Remote Control pairing link, so a phone reads it with its camera.
 *  Byte mode, error correction level M, the smallest version that holds the text. The algorithm
 *  follows Project Nayuki's QR Code generator (MIT License, https://www.nayuki.io/page/qr-code-generator-library).
 *--------------------------------------------------------------------------------------------*/

const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
/** Level M's two format bits. */
const FORMAT_M = 0;

function rawDataModules(ver: number): number {
	let result = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const align = Math.floor(ver / 7) + 2;
		result -= (25 * align - 10) * align - 55;
		if (ver >= 7) {
			result -= 36;
		}
	}
	return result;
}

const dataCodewords = (ver: number) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];

function gfMul(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function rsDivisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMul(result[j], root);
			if (j + 1 < result.length) {
				result[j] ^= result[j + 1];
			}
		}
		root = gfMul(root, 0x02);
	}
	return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
	}
	return result;
}

function withEcc(data: readonly number[], ver: number): number[] {
	const blocks = BLOCKS_M[ver];
	const eccLen = ECC_PER_BLOCK_M[ver];
	const raw = Math.floor(rawDataModules(ver) / 8);
	const shortBlocks = blocks - raw % blocks;
	const shortLen = Math.floor(raw / blocks);
	const divisor = rsDivisor(eccLen);
	const all: number[][] = [];
	for (let i = 0, k = 0; i < blocks; i++) {
		const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, divisor);
		if (i < shortBlocks) {
			dat.push(0);
		}
		all.push(dat.concat(ecc));
	}
	const result: number[] = [];
	for (let i = 0; i < all[0].length; i++) {
		all.forEach((block, j) => {
			if (i !== shortLen - eccLen || j >= shortBlocks) {
				result.push(block[i]);
			}
		});
	}
	return result;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/** The QR code's modules (true = dark), row by row, without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
	const bytes = [...new TextEncoder().encode(text)];
	let ver = 1;
	for (; ver <= 40; ver++) {
		const countBits = ver < 10 ? 8 : 16;
		if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) {
			break;
		}
	}
	if (ver > 40) {
		throw new Error('text too long for a QR code');
	}
	const bits: number[] = [];
	const put = (value: number, len: number) => { for (let i = len - 1; i >= 0; i--) { bits.push((value >>> i) & 1); } };
	put(0x4, 4);
	put(bytes.length, ver < 10 ? 8 : 16);
	bytes.forEach(b => put(b, 8));
	const capacity = dataCodewords(ver) * 8;
	put(0, Math.min(4, capacity - bits.length));
	put(0, (8 - bits.length % 8) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
		put(pad, 8);
	}
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
	}
	const codewords = withEcc(data, ver);

	const size = ver * 4 + 17;
	const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const set = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; fn[y][x] = true; };

	for (let i = 0; i < size; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	const finder = (x: number, y: number) => {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const d = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx, yy = y + dy;
				if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
					set(xx, yy, d !== 2 && d !== 4);
				}
			}
		}
	};
	finder(3, 3);
	finder(size - 4, 3);
	finder(3, size - 4);
	if (ver > 1) {
		const count = Math.floor(ver / 7) + 2;
		const step = Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
		const pos = [6];
		for (let p = size - 7; pos.length < count; p -= step) {
			pos.splice(1, 0, p);
		}
		for (let i = 0; i < count; i++) {
			for (let j = 0; j < count; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) {
					continue;
				}
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) {
						set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
					}
				}
			}
		}
	}
	const format = (mask: number) => {
		const d = (FORMAT_M << 3) | mask;
		let rem = d;
		for (let i = 0; i < 10; i++) {
			rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		}
		const b = ((d << 10) | rem) ^ 0x5412;
		for (let i = 0; i <= 5; i++) {
			set(8, i, bit(b, i));
		}
		set(8, 7, bit(b, 6));
		set(8, 8, bit(b, 7));
		set(7, 8, bit(b, 8));
		for (let i = 9; i < 15; i++) {
			set(14 - i, 8, bit(b, i));
		}
		for (let i = 0; i < 8; i++) {
			set(size - 1 - i, 8, bit(b, i));
		}
		for (let i = 8; i < 15; i++) {
			set(8, size - 15 + i, bit(b, i));
		}
		set(8, size - 8, true);
	};
	format(0);
	if (ver >= 7) {
		let rem = ver;
		for (let i = 0; i < 12; i++) {
			rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		}
		const b = (ver << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const a = size - 11 + i % 3, c = Math.floor(i / 3);
			set(a, c, bit(b, i));
			set(c, a, bit(b, i));
		}
	}

	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) {
			right = 5;
		}
		for (let vert = 0; vert < size; vert++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
				if (!fn[y][x] && i < codewords.length * 8) {
					modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
					i++;
				}
			}
		}
	}

	const masked = (mask: number) => modules.map((row, y) => row.map((dark, x) => {
		if (fn[y][x]) {
			return dark;
		}
		let invert: boolean;
		switch (mask) {
			case 0: invert = (x + y) % 2 === 0; break;
			case 1: invert = y % 2 === 0; break;
			case 2: invert = x % 3 === 0; break;
			case 3: invert = (x + y) % 3 === 0; break;
			case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
			case 5: invert = x * y % 2 + x * y % 3 === 0; break;
			case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
			default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
		}
		return dark !== invert;
	}));
	// The mask with the lowest penalty (runs, 2x2 blocks, dark balance) is kept.
	const penalty = (m: boolean[][]) => {
		let score = 0;
		for (let a = 0; a < size; a++) {
			for (const line of [(k: number) => m[a][k], (k: number) => m[k][a]]) {
				let run = 1;
				for (let k = 1; k <= size; k++) {
					if (k < size && line(k) === line(k - 1)) {
						run++;
					} else {
						if (run >= 5) {
							score += run - 2;
						}
						run = 1;
					}
				}
			}
		}
		let dark = 0;
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				dark += m[y][x] ? 1 : 0;
				if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) {
					score += 3;
				}
			}
		}
		const total = size * size;
		score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
		return score;
	};
	let best: boolean[][] = modules;
	let bestScore = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		format(mask);
		const m = masked(mask);
		const s = penalty(m);
		if (s < bestScore) {
			bestScore = s;
			best = m;
		}
	}
	return best;
}

/** An SVG path (one unit per module, 4 units of quiet zone) and the side length it needs. */
export function qrPath(text: string): { readonly d: string; readonly size: number } {
	const m = qrMatrix(text);
	let d = '';
	m.forEach((row, y) => row.forEach((dark, x) => { if (dark) { d += `M${x + 4} ${y + 4}h1v1h-1z`; } }));
	return { d, size: m.length + 8 };
}
