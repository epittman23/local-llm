// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CodeRunResult } from '@/lib/apis/utils';
import { CodeBlock } from './CodeBlock';

const FIG = {
	type: 'file',
	id: '0b6f2c7e-1a2b-4c3d-8e9f-0123456789ab',
	url: '/api/v1/files/0b6f2c7e-1a2b-4c3d-8e9f-0123456789ab',
	name: 'fig.png',
	meta: { source: 'sandbox_output', sandbox_path: 'outputs/fig.png', content_type: 'image/png' }
};

const block = (props: Partial<Parameters<typeof CodeBlock>[0]> = {}) =>
	render(<CodeBlock id="b1" lang="python" code={'print("hi")'} complete {...props} />);

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
		expect((screen.getByRole('button', { name: /Run/ }) as HTMLButtonElement).disabled).toBe(true);
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

	it("shows the endpoint's refusal and the sandbox's error as a failed run", async () => {
		const run = pending();
		block({ onRun: run.onRun });
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		await act(async () => run.reject('Running code in the sandbox needs the chat it belongs to (chat_id)'));
		expect(screen.getByTestId('code-run-output').textContent).toContain('Run failed');
		expect(screen.getByTestId('code-run-output').textContent).toContain('needs the chat');
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		await act(async () => run.resolve({ error: 'The sandbox is not available on this server' }));
		expect(screen.getByTestId('code-run-output').textContent).toContain('Run failed');
		expect(screen.getByTestId('code-run-output').textContent).toContain('not available');
	});

	it('says when a run printed nothing or was stopped at its time limit', async () => {
		const onRun = vi.fn(async () => ({ stdout: '', stderr: '', result: '', files: [] }));
		block({ onRun });
		fireEvent.click(screen.getByRole('button', { name: /Run/ }));
		await waitFor(() => expect(screen.getByTestId('code-run-output').textContent).toContain('No output'));
		onRun.mockResolvedValueOnce({ stdout: 'part', stderr: '', result: '', files: [], timed_out: true } as never);
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
});
