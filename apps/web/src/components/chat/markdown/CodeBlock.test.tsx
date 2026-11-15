// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CodeRunResult } from '@/lib/apis/utils';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { CodeBlock, extensionOf, SANDBOX_UNAVAILABLE, useCodeBlockStore } from './CodeBlock';

const { saveAs, copyToClipboard } = vi.hoisted(() => ({ saveAs: vi.fn(), copyToClipboard: vi.fn() }));
vi.mock('file-saver', () => ({ default: saveAs }));
vi.mock('@/lib/utils', async (original) => ({ ...(await original<typeof import('@/lib/utils')>()), copyToClipboard }));

const FIG = {
	type: 'file',
	id: '0b6f2c7e-1a2b-4c3d-8e9f-0123456789ab',
	url: '/api/v1/files/0b6f2c7e-1a2b-4c3d-8e9f-0123456789ab',
	name: 'fig.png',
	meta: { source: 'sandbox_output', sandbox_path: 'outputs/fig.png', content_type: 'image/png' }
};

const block = (props: Partial<Parameters<typeof CodeBlock>[0]> = {}) =>
	render(<CodeBlock id="b1" lang="python" code={'print("hi")'} complete {...props} />, { wrapper: TooltipProvider });

beforeEach(() => {
	localStorage.clear();
	useCodeBlockStore.setState({ wrap: false, sandboxUnavailable: false });
});
afterEach(() => vi.clearAllMocks());

/** A runner whose answer the test releases. */
function pending() {
	let resolve: (r: CodeRunResult) => void = () => {};
	let reject: (e: unknown) => void = () => {};
	const onRun = vi.fn(
		() =>
			new Promise<CodeRunResult>((res, rej) => {
				resolve = res;
				reject = rej;
			})
	);
	return { onRun, resolve: (r: CodeRunResult) => resolve(r), reject: (e: unknown) => reject(e) };
}

describe('CodeBlock Run', () => {
	it('offers Run only for complete Python blocks with a runner', () => {
		const onRun = vi.fn();
		const { rerender } = block();
		expect(screen.queryByRole('button', { name: /Run/ })).toBeNull();
		rerender(<CodeBlock id="b1" lang="js" code="1" complete onRun={onRun} />);
		expect(screen.queryByRole('button', { name: /Run/ })).toBeNull();
		rerender(<CodeBlock id="b1" lang="py" code="1" complete={false} onRun={onRun} />);
		const run = screen.getByRole('button', { name: /Run/ });
		// aria-disabled, so the button keeps the keyboard focus; a press does nothing.
		expect(run.getAttribute('aria-disabled')).toBe('true');
		fireEvent.click(run);
		expect(onRun).not.toHaveBeenCalled();
	});

	it('runs the code and shows its output, errors and sandbox outputs under the block', async () => {
		const run = pending();
		block({ onRun: run.onRun });
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		expect(run.onRun).toHaveBeenCalledWith('print("hi")');
		const output = screen.getByTestId('code-run-output');
		expect(output.textContent).toContain('Running...');
		// A second press while it runs does nothing.
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		expect(run.onRun).toHaveBeenCalledTimes(1);
		await act(async () => run.resolve({ stdout: 'hi\n', stderr: 'careful\n', result: '', files: [FIG] }));
		const shown = screen.getByTestId('code-run-output');
		expect(shown.textContent).toContain('Output');
		expect(shown.textContent).toContain('hi');
		expect(shown.textContent).toContain('careful');
		expect(within(shown).getByRole('img', { name: /fig\.png/ })).toBeTruthy();
	});

	it("shows the endpoint's refusal and the sandbox's error as a failed run, labelled once", async () => {
		const run = pending();
		block({ onRun: run.onRun });
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		await act(async () => run.reject('Running code in the sandbox needs the chat it belongs to (chat_id)'));
		const output = screen.getByTestId('code-run-output');
		expect(output.textContent).toBe('Run failedRunning code in the sandbox needs the chat it belongs to (chat_id)');
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		await act(async () => run.resolve({ error: 'The sandbox failed: it stopped during the call' }));
		expect(screen.getByTestId('code-run-output').textContent).toBe(
			'Run failedThe sandbox failed: it stopped during the call'
		);
		// The sandbox can still run: Run stays offered.
		expect(screen.getByRole('button', { name: 'Run' }).getAttribute('aria-disabled')).toBe('false');
	});

	it('says what an unavailable sandbox needs, and disables Run in every block for the session (S3-D6)', async () => {
		const run = pending();
		render(
			<>
				<CodeBlock id="b1" lang="python" code="1" complete onRun={run.onRun} />
				<CodeBlock id="b2" lang="python" code="2" complete onRun={run.onRun} />
			</>,
			{ wrapper: TooltipProvider }
		);
		fireEvent.click(screen.getAllByRole('button', { name: 'Run' })[0]);
		// The backend may add notes after the fixed text.
		await act(async () => run.resolve({ error: `${SANDBOX_UNAVAILABLE} (uploads not copied)` }));
		const output = screen.getByTestId('code-run-output');
		expect(output.textContent).toContain("The code sandbox isn't set up on this machine");
		expect(output.textContent).toContain('KVM, the Kata runtime and the sandbox images');
		expect(output.textContent).not.toContain('Run failed');
		expect(within(output).getByRole('link', { name: 'Read the sandbox guide' }).getAttribute('href')).toMatch(
			/docs\/guides\/sandbox\.md$/
		);
		// Not an admin: no settings link.
		expect(within(output).queryByRole('button', { name: /settings/ })).toBeNull();
		expect(screen.getAllByRole('status')[0].textContent).toBe("The code sandbox isn't set up on this machine");
		const runs = screen.getAllByRole('button', { name: "Run: the code sandbox isn't set up on this machine" });
		expect(runs).toHaveLength(2);
		for (const button of runs) {
			expect(button.getAttribute('aria-disabled')).toBe('true');
			expect(button.className).toContain('text-foreground-disabled');
			expect(button.className.split(' ')).not.toContain('opacity-50');
			fireEvent.click(button);
		}
		expect(run.onRun).toHaveBeenCalledTimes(1);
	});

	it('takes a thrown "not available" as the same state, and offers an admin the Code execution settings', async () => {
		useAuthStore.setState({ user: { id: 'u1', role: 'admin' } as never });
		const openSettings = vi.fn();
		useSettingsModalStore.setState({ openSettings });
		const onRun = vi.fn(async (): Promise<CodeRunResult> => {
			throw SANDBOX_UNAVAILABLE;
		});
		block({ onRun });
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		const settings = await screen.findByRole('button', { name: 'Open Code execution settings' });
		fireEvent.click(settings);
		expect(openSettings).toHaveBeenCalledWith('admin:code-execution');
		expect(useCodeBlockStore.getState().sandboxUnavailable).toBe(true);
		useAuthStore.setState({ user: null });
	});

	it('says when a run printed nothing or was stopped at its time limit', async () => {
		const onRun = vi.fn(async (): Promise<CodeRunResult> => ({ stdout: '', stderr: '', result: '', files: [] }));
		block({ onRun });
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		await waitFor(() => expect(screen.getByTestId('code-run-output').textContent).toContain('No output'));
		onRun.mockResolvedValueOnce({ stdout: 'part', stderr: '', result: '', files: [], timed_out: true });
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		await waitFor(() =>
			expect(screen.getByTestId('code-run-output').textContent).toContain('Stopped at its time limit')
		);
	});

	it('closes the output, and a new run replaces the last one', async () => {
		const run = pending();
		block({ onRun: run.onRun });
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		// Nothing to close while it runs.
		expect(screen.queryByRole('button', { name: 'Close output' })).toBeNull();
		await act(async () => run.resolve({ stdout: 'one' }));
		fireEvent.click(screen.getByRole('button', { name: 'Close output' }));
		expect(screen.queryByTestId('code-run-output')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		expect(screen.getByTestId('code-run-output').textContent).toContain('Running...');
		await act(async () => run.resolve({ stdout: 'two' }));
		expect(screen.getByTestId('code-run-output').textContent).toContain('two');
		expect(screen.getByTestId('code-run-output').textContent).not.toContain('one');
	});

	it('drops the answer of a run whose block was removed', async () => {
		const run = pending();
		const { unmount } = block({ onRun: run.onRun });
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		unmount();
		await act(async () => run.resolve({ stdout: 'late' }));
		expect(screen.queryByTestId('code-run-output')).toBeNull();
	});

	it('announces only the status, and says when a run exited non-zero or its output was cut', async () => {
		const run = pending();
		block({ onRun: run.onRun });
		const status = screen.getByRole('status');
		expect(status.textContent).toBe('');
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		expect(status.textContent).toBe('Running...');
		expect(screen.getByTestId('code-run-output').getAttribute('aria-busy')).toBe('true');
		await act(async () => run.resolve({ stdout: 'x'.repeat(50), returncode: 2, truncated: true }));
		expect(status.textContent).toBe('Exited with code 2');
		expect(screen.getByTestId('code-run-output').textContent).toContain('cut to its first and last');
	});

	it('gives the focus back to Run when the output is closed', async () => {
		const onRun = vi.fn(async () => ({ stdout: 'ok', returncode: 0 }));
		block({ onRun });
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Finished'));
		fireEvent.click(screen.getByRole('button', { name: 'Close output' }));
		expect(document.activeElement).toBe(screen.getByRole('button', { name: /Run/ }));
	});
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('CodeBlock header (CNT-2)', () => {
	it('offers Collapse only above 25 lines, and a collapsed block says how many lines Show all shows', () => {
		const { rerender } = block({ lang: 'bash', code: 'pip install numpy\n' });
		expect(screen.queryByRole('button', { name: /Collapse|Expand/ })).toBeNull();
		rerender(<CodeBlock id="b1" lang="bash" code={lines(25)} complete />);
		expect(screen.queryByRole('button', { name: /Collapse|Expand/ })).toBeNull();
		rerender(<CodeBlock id="b1" lang="bash" code={lines(40)} complete />);
		fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
		const listing = screen.getByRole('figure', { name: 'bash code' });
		expect(listing.className).toContain('max-h-[calc(25lh+0.75rem)]');
		expect(screen.getByRole('button', { name: 'Expand' }).getAttribute('aria-expanded')).toBe('false');
		fireEvent.click(screen.getByRole('button', { name: 'Show all 40 lines' }));
		expect(listing.className).not.toContain('max-h-');
		expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
	});

	it('collapses by the user setting only the blocks long enough to collapse', () => {
		const { rerender } = block({ code: lines(3), defaultCollapsed: true });
		expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
		expect(screen.getByRole('figure', { name: 'python code' }).className).not.toContain('max-h-');
		// A streaming block that grows past the threshold collapses then.
		rerender(<CodeBlock id="b1" lang="python" code={lines(30)} complete={false} defaultCollapsed />);
		expect(screen.getByRole('button', { name: 'Show all 30 lines' })).toBeTruthy();
	});

	it('wraps lines in every block, and remembers it', () => {
		render(
			<>
				<CodeBlock id="b1" lang="python" code="a" complete />
				<CodeBlock id="b2" lang="python" code="b" complete />
			</>,
			{ wrapper: TooltipProvider }
		);
		const [first] = screen.getAllByRole('button', { name: 'Wrap lines' });
		expect(first.getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(first);
		for (const pre of document.querySelectorAll('pre')) expect(pre.className).toContain('whitespace-pre-wrap');
		expect(screen.getAllByRole('button', { name: 'Wrap lines' })[1].getAttribute('aria-pressed')).toBe('true');
		expect(localStorage.getItem('codeWrap')).toBe('true');
		fireEvent.click(first);
		expect(localStorage.getItem('codeWrap')).toBe('false');
	});

	it('keeps wrapping for the page when storage is blocked', () => {
		const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		block();
		fireEvent.click(screen.getByRole('button', { name: 'Wrap lines' }));
		expect((document.querySelector('pre') as HTMLElement).className).toContain('whitespace-pre-wrap');
		setItem.mockRestore();
	});

	it('downloads the code named by its language', () => {
		block({ lang: 'Python', code: 'x = 1' });
		fireEvent.click(screen.getByRole('button', { name: 'Download' }));
		expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'code.py');
		expect(extensionOf('bash')).toBe('sh');
		expect(extensionOf('json')).toBe('json');
		expect(extensionOf('')).toBe('txt');
		expect(extensionOf('objective-c')).toBe('txt');
	});

	it('copies the code and says Copied, or says the browser refused', async () => {
		copyToClipboard.mockResolvedValueOnce(true);
		block();
		fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
		expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
		expect(copyToClipboard).toHaveBeenCalledWith('print("hi")');
	});

	it('names its listing as a figure, a tab stop only while long lines overflow', () => {
		const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900);
		const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
		block({ lang: '', code: 'x'.repeat(300) });
		const listing = screen.getByRole('figure', { name: 'text code' });
		expect(listing.getAttribute('tabindex')).toBe('0');
		expect(listing.parentElement?.hasAttribute('data-clipped-end')).toBe(true);
		widths.mockReturnValue(300);
		act(() => window.dispatchEvent(new Event('resize')));
		expect(listing.getAttribute('tabindex')).toBeNull();
		expect(listing.parentElement?.hasAttribute('data-clipped-end')).toBe(false);
		widths.mockRestore();
		client.mockRestore();
	});

	it('shows its actions as named icons with tooltips when the block is narrow (ACT-4)', () => {
		const callbacks: ResizeObserverCallback[] = [];
		const Observer = vi.fn(function (this: unknown, callback: ResizeObserverCallback) {
			callbacks.push(callback);
			return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
		});
		vi.stubGlobal('ResizeObserver', Observer);
		block({ onRun: vi.fn() });
		expect(screen.getByRole('button', { name: 'Copy' }).textContent).toBe('Copy');
		const entry = { contentRect: { width: 358 } } as ResizeObserverEntry;
		act(() => {
			for (const report of callbacks) report([entry], {} as ResizeObserver);
		});
		const copy = screen.getByRole('button', { name: 'Copy' });
		expect(copy.textContent).toBe('');
		expect(copy.getAttribute('data-size')).toBe('icon-xs');
		expect(screen.getByRole('button', { name: 'Run' }).textContent).toBe('');
		vi.unstubAllGlobals();
	});

	it('keeps the same, focused button when the block turns narrow, so a panel it opened can return focus (NAV-4)', () => {
		const callbacks: ResizeObserverCallback[] = [];
		const Observer = vi.fn(function (this: unknown, callback: ResizeObserverCallback) {
			callbacks.push(callback);
			return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
		});
		vi.stubGlobal('ResizeObserver', Observer);
		block({ lang: 'html', code: '<p>hi</p>', onPreview: vi.fn() });
		const preview = screen.getByRole('button', { name: 'Preview' });
		preview.focus();
		// The side panel opening beside the chat narrows the block.
		const entry = { contentRect: { width: 320 } } as ResizeObserverEntry;
		act(() => {
			for (const report of callbacks) report([entry], {} as ResizeObserver);
		});
		expect(preview.textContent).toBe('');
		expect(preview.isConnected).toBe(true);
		expect(screen.getByRole('button', { name: 'Preview' })).toBe(preview);
		expect(document.activeElement).toBe(preview);
		vi.unstubAllGlobals();
	});
});
