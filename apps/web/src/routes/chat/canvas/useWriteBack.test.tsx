import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVED_TO_WORKSPACE, useWriteBack, WORKSPACE_BUSY } from './useWriteBack';

const api = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@/lib/apis/sandbox', () => ({ writeBackOutput: api.write }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let current: ReturnType<typeof useWriteBack>;
function Probe() {
	current = useWriteBack();
	return current.dialog;
}

beforeEach(() => {
	api.write.mockReset();
	vi.mocked(toast.success).mockReset();
	vi.mocked(toast.error).mockReset();
});
afterEach(cleanup);

describe('useWriteBack', () => {
	it('writes once and says the model sees it when it next reads the file', async () => {
		api.write.mockResolvedValue({ status: 'written', path: 'outputs/a.py', bytes: 3 });
		render(<Probe />);
		await act(() => current.run('f1'));
		expect(api.write).toHaveBeenCalledWith('', 'f1', false);
		expect(toast.success).toHaveBeenCalledWith(SAVED_TO_WORKSPACE);
		expect(SAVED_TO_WORKSPACE).toBe('Saved to the workspace. The model sees it the next time it reads the file.');
	});

	it('sends one request for a double press', async () => {
		let release: (value: unknown) => void = () => {};
		api.write.mockReturnValue(new Promise((resolve) => (release = resolve)));
		render(<Probe />);
		await act(async () => {
			void current.run('f1');
			void current.run('f1');
		});
		expect(current.pending).toBe(true);
		expect(api.write).toHaveBeenCalledTimes(1);
		await act(async () => release({ status: 'written', path: 'p', bytes: 1 }));
		expect(current.pending).toBe(false);
	});

	it('asks before replacing a changed file, and Replace repeats with force', async () => {
		api.write
			.mockResolvedValueOnce({ status: 'changed', missing: false })
			.mockResolvedValueOnce({ status: 'written', path: 'p', bytes: 1 });
		render(<Probe />);
		await act(() => current.run('f1'));
		expect(toast.success).not.toHaveBeenCalled();
		expect(await screen.findByText('Replace the workspace file?')).toBeInTheDocument();
		expect(
			screen.getByText('The file in the workspace changed after this version. Replace it with this version?')
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
		await waitFor(() => expect(api.write).toHaveBeenCalledTimes(2));
		expect(api.write).toHaveBeenLastCalledWith('', 'f1', true);
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith(SAVED_TO_WORKSPACE));
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('says a missing file will be created, and Cancel sends nothing more', async () => {
		api.write.mockResolvedValue({ status: 'changed', missing: true });
		render(<Probe />);
		await act(() => current.run('f1'));
		expect(await screen.findByText('Create the workspace file?')).toBeInTheDocument();
		expect(
			screen.getByText('The file is no longer in the workspace. Create it with this version?')
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(api.write).toHaveBeenCalledTimes(1);
	});

	it('toasts a busy workspace and a failure, and can be pressed again after each', async () => {
		api.write.mockResolvedValueOnce({ status: 'busy' }).mockRejectedValueOnce({ detail: 'down' });
		render(<Probe />);
		await act(() => current.run('f1'));
		expect(toast.error).toHaveBeenCalledWith(WORKSPACE_BUSY);
		await act(() => current.run('f1'));
		expect(toast.error).toHaveBeenLastCalledWith('Could not save to the workspace. Try again.', expect.anything());
		expect(current.pending).toBe(false);
		expect(api.write).toHaveBeenCalledTimes(2);
	});
});
