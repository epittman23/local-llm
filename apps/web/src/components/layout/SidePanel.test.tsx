import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CONTENT_MIN, clampWidth, maxWidth, panelMode, SidePanel, stepFor } from './SidePanel';

/** Gives every observed row a width, since jsdom lays nothing out, and lets a test change it. */
let rowWidth = 1200;
let observers: (() => void)[] = [];
class FakeResizeObserver {
	constructor(private cb: () => void) {
		observers.push(cb);
	}
	observe(el: HTMLElement) {
		Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => rowWidth });
		// As a browser does: the first observation reports the size at once.
		this.cb();
	}
	disconnect() {
		observers = observers.filter((o) => o !== this.cb);
	}
}
function resizeRow(width: number) {
	rowWidth = width;
	act(() => {
		for (const o of observers) o();
	});
}
function setMdUp(matches: boolean) {
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
	);
}

function Harness({ initiallyOpen = false, actions }: { initiallyOpen?: boolean; actions?: React.ReactNode }) {
	const [open, setOpen] = useState(initiallyOpen);
	return (
		<TooltipProvider>
			<div data-testid="row">
				<input aria-label="Message" />
				<button type="button" onClick={() => setOpen((o) => !o)}>
					Controls
				</button>
				<SidePanel
					open={open}
					onClose={() => setOpen(false)}
					title="Controls"
					storageKey="test.panel"
					defaultWidth={320}
					minWidth={288}
					actions={actions}
				>
					<label>
						System prompt
						<textarea />
					</label>
				</SidePanel>
			</div>
		</TooltipProvider>
	);
}

/** A panel opened by a key in the message box, as the Controls shortcut does. */
function ShortcutHarness() {
	const [open, setOpen] = useState(false);
	return (
		<TooltipProvider>
			<div>
				<input aria-label="Message" onKeyDown={(e) => e.key === '.' && e.ctrlKey && setOpen((o) => !o)} />
				<SidePanel
					open={open}
					onClose={() => setOpen(false)}
					title="Controls"
					storageKey="k"
					defaultWidth={320}
					minWidth={288}
				>
					<p>Body</p>
				</SidePanel>
			</div>
		</TooltipProvider>
	);
}

beforeEach(() => {
	rowWidth = 1200;
	observers = [];
	localStorage.clear();
	vi.stubGlobal('ResizeObserver', FakeResizeObserver);
	setMdUp(true);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('SidePanel helpers', () => {
	it('is a column only where the space holds the minimum plus 24 rem of content, and never below md (CNV-2)', () => {
		expect(CONTENT_MIN).toBe(384);
		// 768 px with the sidebar open leaves 512 px; with the rail 720 px.
		expect(panelMode(512, 288, true)).toBe('sheet');
		expect(panelMode(720, 288, true)).toBe('column');
		expect(panelMode(672, 288, true)).toBe('column');
		expect(panelMode(671, 288, true)).toBe('sheet');
		expect(panelMode(1200, 288, false)).toBe('sheet');
	});

	it('clamps a width between the minimum and what leaves the content 24 rem', () => {
		expect(maxWidth(288, 1200)).toBe(816);
		expect(maxWidth(288, 500)).toBe(288);
		expect(clampWidth(100, 288, 1200)).toBe(288);
		expect(clampWidth(2000, 288, 1200)).toBe(816);
		expect(clampWidth(400.4, 288, 1200)).toBe(400);
	});

	it('maps the arrow keys, Shift, Home and End to the width', () => {
		expect(stepFor('ArrowLeft', false)).toBe(16);
		expect(stepFor('ArrowRight', false)).toBe(-16);
		expect(stepFor('ArrowLeft', true)).toBe(64);
		expect(stepFor('ArrowRight', true)).toBe(-64);
		expect(stepFor('Home', false)).toBe('max');
		expect(stepFor('End', false)).toBe('min');
		expect(stepFor('a', false)).toBeNull();
	});
});

describe('SidePanel as a column', () => {
	it('is a named region with a heading, its actions and one Close', () => {
		render(<Harness initiallyOpen actions={<button type="button">Download</button>} />);
		const region = screen.getByRole('complementary', { name: 'Controls' });
		expect(region.style.width).toBe('320px');
		expect(screen.getByRole('heading', { level: 2, name: 'Controls' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
		expect(screen.getAllByRole('button', { name: /^Close/ })).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Close controls' })).toBeInTheDocument();
	});

	it('resizes from the keyboard, says its width, and keeps it (NAV-5)', () => {
		render(<Harness initiallyOpen />);
		const handle = screen.getByRole('separator', { name: 'Resize controls' });
		expect(handle.getAttribute('aria-orientation')).toBe('vertical');
		expect(handle.getAttribute('aria-valuenow')).toBe('320');
		expect(handle.getAttribute('aria-valuemin')).toBe('288');
		expect(handle.getAttribute('aria-valuemax')).toBe('816');
		expect(handle.tabIndex).toBe(0);

		fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		expect(handle.getAttribute('aria-valuenow')).toBe('336');
		fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
		expect(handle.getAttribute('aria-valuenow')).toBe('288');
		fireEvent.keyDown(handle, { key: 'Home' });
		expect(handle.getAttribute('aria-valuenow')).toBe('816');
		fireEvent.keyDown(handle, { key: 'End' });
		expect(handle.getAttribute('aria-valuenow')).toBe('288');
		fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		expect(localStorage.getItem('test.panel')).toBe('304');
		fireEvent.keyDown(handle, { key: 'Tab' });
		expect(handle.getAttribute('aria-valuenow')).toBe('304');
	});

	it('starts from the kept width, clamped to the room there is now', () => {
		localStorage.setItem('test.panel', '900');
		render(<Harness initiallyOpen />);
		expect(screen.getByRole('complementary', { name: 'Controls' }).style.width).toBe('816px');
		resizeRow(800);
		expect(screen.getByRole('complementary', { name: 'Controls' }).style.width).toBe('416px');
	});

	it('falls back to the default width when storage cannot be read', () => {
		const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		render(<Harness initiallyOpen />);
		const handle = screen.getByRole('separator');
		expect(handle.getAttribute('aria-valuenow')).toBe('320');
		fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		expect(handle.getAttribute('aria-valuenow')).toBe('336');
		get.mockRestore();
		set.mockRestore();
	});

	it('resizes by dragging the handle', () => {
		render(<Harness initiallyOpen />);
		const handle = screen.getByRole('separator');
		fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
		fireEvent.pointerMove(handle, { clientX: 450, pointerId: 1 });
		expect(handle.getAttribute('aria-valuenow')).toBe('370');
		fireEvent.pointerUp(handle, { pointerId: 1 });
		fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
		expect(handle.getAttribute('aria-valuenow')).toBe('370');
	});

	it('moves focus to its heading on opening and back to the opener on closing (NAV-4)', () => {
		render(<Harness />);
		const opener = screen.getByRole('button', { name: 'Controls' });
		opener.focus();
		fireEvent.click(opener);
		expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Controls' }));
		fireEvent.click(screen.getByRole('button', { name: 'Close controls' }));
		expect(screen.queryByRole('complementary')).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it('returns focus to whatever had it when the panel opened without a click (a shortcut)', () => {
		render(<ShortcutHarness />);
		const message = screen.getByRole('textbox', { name: 'Message' });
		message.focus();
		fireEvent.keyDown(message, { key: '.', ctrlKey: true });
		const heading = screen.getByRole('heading', { name: 'Controls' });
		expect(document.activeElement).toBe(heading);
		fireEvent.keyDown(heading, { key: 'Escape' });
		expect(screen.queryByRole('complementary')).toBeNull();
		expect(document.activeElement).toBe(message);
	});

	it('leaves focus where it is when closed from outside the panel', () => {
		render(<Harness initiallyOpen />);
		const message = screen.getByRole('textbox', { name: 'Message' });
		message.focus();
		fireEvent.click(screen.getByRole('button', { name: 'Controls' }));
		expect(screen.queryByRole('complementary')).toBeNull();
		expect(document.activeElement).toBe(message);
	});

	it('closes on Escape only from inside, and not when something inside took the key (NAV-4)', () => {
		render(<Harness initiallyOpen />);
		fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Escape' });
		expect(screen.getByRole('complementary', { name: 'Controls' })).toBeInTheDocument();

		const field = screen.getByRole('textbox', { name: 'System prompt' });
		field.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(screen.getByRole('complementary', { name: 'Controls' })).toBeInTheDocument();

		fireEvent.keyDown(field, { key: 'Enter' });
		expect(screen.getByRole('complementary', { name: 'Controls' })).toBeInTheDocument();
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(screen.queryByRole('complementary')).toBeNull();
	});
});

describe('SidePanel as a sheet', () => {
	it('is a full-screen sheet below md, with exactly one Close (LAY-4)', () => {
		setMdUp(false);
		render(<Harness initiallyOpen />);
		expect(screen.queryByRole('complementary')).toBeNull();
		const sheet = screen.getByRole('dialog', { name: 'Controls' });
		expect(sheet.className).toContain('data-[side=right]:w-full');
		expect(sheet.className).toContain('data-[side=right]:sm:max-w-none');
		expect(screen.getAllByRole('button', { name: /close/i })).toHaveLength(1);
		expect(screen.queryByRole('separator')).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Controls' }));
	});

	it('is a sheet where the space beside the sidebar is too narrow, and closes back', () => {
		rowWidth = 512;
		render(<Harness />);
		const opener = screen.getByRole('button', { name: 'Controls' });
		opener.focus();
		fireEvent.click(opener);
		expect(screen.getByRole('dialog', { name: 'Controls' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close controls' }));
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('becomes a column when the room grows', () => {
		rowWidth = 512;
		render(<Harness initiallyOpen />);
		expect(screen.getByRole('dialog', { name: 'Controls' })).toBeInTheDocument();
		resizeRow(1024);
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByRole('complementary', { name: 'Controls' })).toBeInTheDocument();
	});
});
