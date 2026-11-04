import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeFileHash, paddedLength, sha256Fallback, writeBitLength } from './hash';

// #258: the pure-JS SHA-256, used when crypto.subtle is missing (the app over
// plain HTTP on a LAN), wrote only the low 32 bits of the message's length in
// bits. From 2^32 bits (512 MiB) on, every digest was wrong, so a directory
// sync saw a mismatch and re-uploaded the file every time. And the padded
// length was worked out with 32-bit operators, which wrapped from just under
// 2 GiB on, so the fallback threw a RangeError there.

const nodeSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

describe('sha256Fallback', () => {
	// The padding changes shape at 55/56 bytes (the length no longer fits in
	// the last block) and at each 64-byte block boundary.
	it.each([0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000])('matches SHA-256 for %i bytes', (n) => {
		const bytes = bytesOf(n);
		expect(sha256Fallback(bytes)).toBe(nodeSha256(bytes));
	});

	it('gives the known digest of "abc"', () => {
		expect(sha256Fallback(new TextEncoder().encode('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});
});

describe('writeBitLength', () => {
	/** The 8 bytes written before the end of a 16-byte block that starts filled with 0xff. */
	const written = (byteLength: number) => {
		const view = new DataView(new Uint8Array(16).fill(0xff).buffer);
		writeBitLength(view, 16, byteLength);
		return [...new Uint8Array(view.buffer)];
	};
	const before = new Array(8).fill(0xff);

	it('writes the length in bits as a 64-bit big-endian number', () => {
		expect(written(0)).toEqual([...before, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(written(3)).toEqual([...before, 0, 0, 0, 0, 0, 0, 0, 24]);
		expect(written(2 ** 29 - 1)).toEqual([...before, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xf8]);
	});

	it('carries into the high word from 512 MiB (2^32 bits) on', () => {
		expect(written(2 ** 29)).toEqual([...before, 0, 0, 0, 1, 0, 0, 0, 0]);
		expect(written(2 ** 29 + 1)).toEqual([...before, 0, 0, 0, 1, 0, 0, 0, 8]);
		expect(written(5 * 2 ** 30)).toEqual([...before, 0, 0, 0, 10, 0, 0, 0, 0]);
	});
});

describe('paddedLength', () => {
	it('rounds the message, the 0x80 byte and the 8-byte length up to whole 64-byte blocks', () => {
		expect(paddedLength(0)).toBe(64);
		expect(paddedLength(55)).toBe(64);
		expect(paddedLength(56)).toBe(128);
		expect(paddedLength(64)).toBe(128);
		expect(paddedLength(119)).toBe(128);
		expect(paddedLength(120)).toBe(192);
	});

	it('does not wrap at 2 GiB or 4 GiB, where 32-bit operators did', () => {
		expect(paddedLength(2 ** 31 - 73)).toBe(2 ** 31 - 64);
		expect(paddedLength(2 ** 31 - 72)).toBe(2 ** 31);
		expect(paddedLength(2 ** 31)).toBe(2 ** 31 + 64);
		expect(paddedLength(2 ** 32 - 8)).toBe(2 ** 32 + 64);
		expect(paddedLength(5 * 2 ** 30)).toBe(5 * 2 ** 30 + 64);
	});
});

describe('computeFileHash', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('uses the fallback when crypto.subtle is missing, with the same digest', async () => {
		const bytes = bytesOf(5000);
		const withSubtle = await computeFileHash(new File([bytes], 'a.bin'));
		vi.stubGlobal('crypto', {});
		const withoutSubtle = await computeFileHash(new File([bytes], 'a.bin'));
		expect(withoutSubtle).toBe(withSubtle);
		expect(withoutSubtle).toBe(nodeSha256(bytes));
	});
});
