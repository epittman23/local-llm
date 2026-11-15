import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateInitialsImage } from './auth-helpers';

/** A canvas context that records what is drawn and hands back the pixels it was given, as an honest browser does. */
function fakeContext() {
	let pixels: Uint8ClampedArray = new Uint8ClampedArray(4);
	const drawn: Array<{ fill: string; font?: string; text?: string; rect?: boolean }> = [];
	const ctx = {
		fillStyle: '',
		font: '',
		textAlign: '',
		textBaseline: '',
		putImageData: (data: { data: Uint8ClampedArray }) => {
			pixels = new Uint8ClampedArray(data.data);
		},
		getImageData: () => ({ data: pixels }),
		fillRect: () => drawn.push({ fill: ctx.fillStyle, rect: true }),
		fillText: (text: string) => drawn.push({ fill: ctx.fillStyle, font: ctx.font, text })
	};
	return { ctx, drawn };
}

describe('generateInitialsImage', () => {
	let recorded: ReturnType<typeof fakeContext>;

	beforeEach(() => {
		recorded = fakeContext();
		vi.stubGlobal(
			'ImageData',
			class {
				data: Uint8ClampedArray;
				constructor(w: number, h: number) {
					this.data = new Uint8ClampedArray(w * h * 4);
				}
			}
		);
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recorded.ctx as never);
		vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,DRAWN');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		document.documentElement.removeAttribute('style');
	});

	it('draws the initials in --foreground-strong on --surface-3, read from the page (D1b)', () => {
		document.documentElement.style.setProperty('--surface-3', 'oklch(0.94 0.008 110)');
		document.documentElement.style.setProperty('--foreground-strong', 'oklch(0.24 0.02 170)');
		expect(generateInitialsImage('Ada Lovelace')).toBe('data:image/png;base64,DRAWN');
		const [background, text] = recorded.drawn;
		expect(background).toEqual({ fill: '#ebece6', rect: true });
		expect(text.fill).toBe('#16221e');
		expect(text.text).toBe('AL');
		expect(text.font).toMatch(/^500 40px /);
	});

	it('uses the dark theme’s values where the page has no tokens, never the old orange', () => {
		generateInitialsImage('grace');
		expect(recorded.drawn.map((d) => d.fill)).toEqual(['#2c3532', '#f1efe6']);
		expect(recorded.drawn[1].text).toBe('G');
	});

	it('falls back to the stored default picture when the canvas is tampered with', () => {
		recorded.ctx.getImageData = () => ({ data: new Uint8ClampedArray(4) });
		expect(generateInitialsImage('Ada')).toBe('/user.png');
		expect(recorded.drawn).toEqual([]);
	});
});
