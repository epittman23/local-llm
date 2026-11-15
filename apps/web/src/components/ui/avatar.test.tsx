import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasPicture, ProfileAvatar } from './avatar';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** jsdom never loads an image; this one loads as soon as it is given a src, as a browser's would. */
class LoadingImage {
	onload: ((event: { currentTarget: LoadingImage }) => void) | null = null;
	onerror: ((event: { currentTarget: LoadingImage }) => void) | null = null;
	complete = false;
	naturalWidth = 0;
	addEventListener(type: string, listener: (event: { currentTarget: LoadingImage }) => void) {
		if (type === 'load') this.onload = listener;
		if (type === 'error') this.onerror = listener;
	}
	removeEventListener() {}
	set src(_: string) {
		this.complete = true;
		this.naturalWidth = 10;
		queueMicrotask(() => this.onload?.call(this, { currentTarget: this }));
	}
}

describe('hasPicture', () => {
	it('is false for nothing and for the stored defaults that mean no picture', () => {
		for (const src of [undefined, null, '', '/user.png', '/favicon.png', '/static/favicon.png']) {
			expect(hasPicture(src), String(src)).toBe(false);
		}
	});

	it('is true for an uploaded, linked or served picture', () => {
		for (const src of [
			'data:image/png;base64,AAAA',
			'https://example.com/user.png',
			'/api/v1/users/u1/profile/image',
			'/api/v1/models/model/profile/image?id=m'
		]) {
			expect(hasPicture(src), src).toBe(true);
		}
	});
});

describe('ProfileAvatar', () => {
	it('shows the initials on the surface-3 token when there is no picture (D1)', () => {
		const { container } = render(<ProfileAvatar name="Ada Lovelace" src="/user.png" />);
		const fallback = container.querySelector('[data-slot="avatar-fallback"]') as HTMLElement;
		expect(fallback.textContent).toBe('AL');
		expect(fallback.className).toContain('bg-surface-3');
		expect(fallback.className).toContain('text-foreground-strong');
		expect(container.querySelector('img')).toBeNull();
	});

	it('is hidden from assistive technology unless it is given a label', () => {
		const { container } = render(<ProfileAvatar name="Coder" />);
		expect(container.querySelector('[data-slot="avatar"]')?.getAttribute('aria-hidden')).toBe('true');
		cleanup();
		render(<ProfileAvatar name="Coder" label="Coder's picture" />);
		expect(screen.getByRole('img', { name: "Coder's picture" }).textContent).toBe('C');
	});

	it('shows the picture once it has loaded, in place of the initials', async () => {
		vi.stubGlobal('Image', LoadingImage);
		const { container } = render(<ProfileAvatar name="Ada" src="data:image/png;base64,AAAA" size="lg" className="size-5" />);
		await act(async () => {
			await Promise.resolve();
		});
		const img = container.querySelector('img');
		expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
		expect(container.querySelector('[data-slot="avatar-fallback"]')).toBeNull();
		const root = container.querySelector('[data-slot="avatar"]') as HTMLElement;
		expect(root.dataset.size).toBe('lg');
		expect(root.className).toContain('size-5');
	});
});
