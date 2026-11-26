import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileVersion } from '@/lib/apis/files/versions';
import { docOf, id, output, renderWithClient } from '../testing';
import { ChangesView, DiffView } from './ChangesView';

const api = vi.hoisted(() => ({
	text: vi.fn<(token: string, id: string, max: number) => Promise<{ text: string; truncated: boolean }>>()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputText: api.text, getSandboxOutputHtml: vi.fn() }));

const V1 = id('1');
const V2 = id('a');
const V3 = id('b');
const entry = (file: string, version: number): FileVersion => ({
	id: file,
	version,
	size: 10,
	created_at: 1_700_000_000,
	name: 'fit.py'
});
const VERSIONS = [entry(V1, 1), entry(V2, 2), entry(V3, 3)];
const TEXTS: Record<string, { text: string; truncated?: boolean }> = {
	[V1]: { text: 'a = 1\nb = 2\nc = 3\n' },
	[V2]: { text: 'a = 1\nb = 20\nc = 3\nd = 4\n' },
	[V3]: { text: 'a = 1\nb = 20\nc = 3\nd = 4\ne = 5\n' }
};

beforeAll(() => {
	// Radix Select measures and captures the pointer, which the test DOM does not do.
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
	api.text.mockReset();
	api.text.mockImplementation(async (_t, file) => ({ truncated: false, ...TEXTS[file] }));
});

const view = (shownIndex: number, versions = VERSIONS) =>
	renderWithClient(<ChangesView doc={docOf(output('1', 'fit.py'))} versions={versions} shownIndex={shownIndex} />);
const region = (from: number, to: number) =>
	screen.findByRole('region', { name: `Changes from version ${from} to version ${to}` });

describe('ChangesView', () => {
	it('compares the shown version with the one before it, with glyphs and both line numbers', async () => {
		view(1);
		const rows = await region(1, 2);
		expect(screen.getByRole('status')).toHaveTextContent('2 lines added, 1 removed');
		// Old number, new number, glyph, then the line; the screen reader's word comes with it.
		expect(Array.from(rows.querySelectorAll(':scope > div > div'), (row) => row.textContent)).toEqual([
			'11a = 1',
			'2-Removed: b = 2',
			'2+Added: b = 20',
			'33c = 3',
			'4+Added: d = 4'
		]);
	});

	it('is keyboard-scrollable and starts version 1 against 2 when version 1 is shown', async () => {
		view(0);
		expect(await region(1, 2)).toHaveAttribute('tabindex', '0');
	});

	it('says No differences when the versions are the same', async () => {
		api.text.mockResolvedValue({ text: 'same\n', truncated: false });
		view(2);
		expect(await screen.findByText('No differences')).toBeInTheDocument();
		expect(screen.queryByRole('region')).toBeNull();
	});

	it('says a version cut at the cap is too large to compare, with no partial diff', async () => {
		api.text.mockImplementation(async (_t, file) => ({ truncated: file === V2, ...TEXTS[file] }));
		view(1);
		expect(await screen.findByText('A version is too large to compare here. Open each in Source.')).toBeInTheDocument();
		expect(screen.queryByRole('region')).toBeNull();
	});

	it('says when a version cannot be read', async () => {
		api.text.mockImplementation(async (_t, file) => {
			if (file === V2) throw new Error('boom');
			return { truncated: false, ...TEXTS[file] };
		});
		view(1);
		expect(await screen.findByText(/Could not compare these versions: .*boom/)).toBeInTheDocument();
	});

	it('shows hostile text as text, never as markup', async () => {
		api.text.mockImplementation(async (_t, file) => ({
			truncated: false,
			text: file === V1 ? 'ok\n' : 'ok\n<img src=x onerror="alert(1)">\n</script><script>alert(2)</script>\n'
		}));
		const { container } = view(1);
		const rows = await region(1, 2);
		expect(rows).toHaveTextContent('<img src=x onerror="alert(1)">');
		expect(rows).toHaveTextContent('</script><script>alert(2)</script>');
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('script')).toBeNull();
	});

	it('refuses the same version on both sides by disabling it in the other selector', async () => {
		view(1);
		await region(1, 2);
		fireEvent.keyDown(screen.getByRole('combobox', { name: 'From version' }), { key: 'Enter' });
		const options = await screen.findAllByRole('option');
		expect(options).toHaveLength(3);
		// To is version 2, so version 2 cannot be chosen as From.
		expect(options[1]).toHaveAttribute('aria-disabled', 'true');
		expect(options[0]).not.toHaveAttribute('aria-disabled', 'true');
		fireEvent.click(options[2]);
		expect(await region(3, 2)).toHaveTextContent('Removed: e = 5');
		expect(api.text).toHaveBeenCalledWith('', V3, 256 * 1024, expect.any(AbortSignal));
	});

	it('reverses the direction with Swap, and keeps the pair apart', async () => {
		view(1);
		await region(1, 2);
		fireEvent.click(screen.getByRole('button', { name: 'Swap From and To' }));
		const rows = await region(2, 1);
		expect(rows).toHaveTextContent('Removed: d = 4');
		expect(screen.getByRole('status')).toHaveTextContent('1 line added, 2 removed');
		expect(screen.getByRole('combobox', { name: 'From version' })).toHaveTextContent('Version 2');
		expect(screen.getByRole('combobox', { name: 'To version' })).toHaveTextContent('Version 1 (original)');
	});
});

describe('DiffView', () => {
	const long = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

	it('folds an unchanged run of more than 6 lines, and expands it on request', async () => {
		render(`${long(20)}\n`, `changed\n${long(20)}\n`);
		const fold = screen.getByRole('button', { name: 'Show 20 unchanged lines' });
		expect(fold).toHaveTextContent('20 unchanged lines');
		expect(screen.queryByText('line 10')).toBeNull();
		fireEvent.click(fold);
		await waitFor(() => expect(screen.getByText('line 10', { exact: false })).toBeInTheDocument());
		expect(screen.queryByRole('button', { name: /unchanged lines/ })).toBeNull();
	});

	it('keeps a run of 6 or fewer unchanged lines visible', () => {
		render(`${long(6)}\n`, `changed\n${long(6)}\n`);
		expect(screen.queryByRole('button', { name: /unchanged/ })).toBeNull();
		expect(screen.getByText('line 3', { exact: false })).toBeInTheDocument();
	});

	it('says a final newline or the line endings alone differ', () => {
		const { unmount } = render('a\nb', 'a\nb\n');
		expect(screen.getByText(/Only the final newline differs/)).toBeInTheDocument();
		unmount();
		render('a\r\nb\r\n', 'a\nb\n');
		expect(screen.getByText(/Only the line endings differ/)).toBeInTheDocument();
	});

	it('says when the versions are too long, or too different, to compare', () => {
		const { unmount } = render(long(5001), 'a');
		expect(screen.getByText(/too long to compare here \(more than 5,000 lines\)/)).toBeInTheDocument();
		unmount();
		const left = Array.from({ length: 3000 }, (_, i) => `left ${i}`).join('\n');
		const right = Array.from({ length: 3000 }, (_, i) => `right ${i}`).join('\n');
		render(left, right);
		expect(screen.getByText(/differ too much to compare line by line/)).toBeInTheDocument();
	});

	it('uses the singular for one line', () => {
		render('a\n', 'a\nb\n');
		expect(screen.getByRole('status')).toHaveTextContent('1 line added, 0 removed');
	});
});

function render(from: string, to: string) {
	return renderWithClient(<DiffView from={from} to={to} label="Changes" />);
}
