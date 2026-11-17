import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lineTone, ServeLog } from './ServeLog';

vi.mock('@/lib/utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/utils')>()),
	copyToClipboard: vi.fn().mockResolvedValue(true)
}));

describe('ServeLog', () => {
	afterEach(cleanup);

	it('tints warnings and errors by llama.cpp level', () => {
		expect(lineTone('srv load_model: W the slot context exceeds')).toBe('warning');
		expect(lineTone('ggml_cuda: E CUDA error: out of memory')).toBe('danger');
		expect(lineTone('error: failed to load model')).toBe('danger');
		expect(lineTone('load_tensors: offloaded 20/66 layers to GPU')).toBeNull();
	});

	it('is a named, focusable region with Follow and Copy', async () => {
		render(
			<ServeLog
				streaming
				lines={[
					{ n: 0, text: 'one' },
					{ n: 1, text: 'two' }
				]}
			/>
		);
		const region = screen.getByRole('region', { name: 'Log' });
		expect(region.getAttribute('tabindex')).toBe('0');
		expect(screen.getByText('Streaming')).toBeInTheDocument();
		const follow = screen.getByRole('button', { name: 'Following' });
		expect(follow.getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(follow);
		expect(screen.getByRole('button', { name: 'Follow' }).getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(screen.getByRole('button', { name: 'Copy log' }));
		expect(await screen.findByText('Copied')).toBeInTheDocument();
	});

	it('says what goes here while empty, and offers nothing to copy', () => {
		render(<ServeLog streaming={false} lines={[]} />);
		expect(screen.getByText(/No log output yet/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Copy log' })).toBeDisabled();
		expect(screen.getByRole('region', { name: 'Log' }).getAttribute('tabindex')).toBeNull();
	});
});
