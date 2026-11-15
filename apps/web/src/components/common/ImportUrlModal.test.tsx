import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportUrlModal } from './ImportUrlModal';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

const open = (loadUrl: (url: string) => Promise<never>) => {
	const onImport = vi.fn();
	const onOpenChange = vi.fn();
	render(<ImportUrlModal open onOpenChange={onOpenChange} loadUrl={loadUrl} onImport={onImport} />);
	fireEvent.change(screen.getByRole('textbox', { name: 'URL' }), { target: { value: 'https://example.com/unit.py' } });
	fireEvent.click(screen.getByRole('button', { name: 'Import' }));
	return { onImport, onOpenChange };
};

describe('ImportUrlModal', () => {
	it('hands the loaded code to the create page without claiming anything was imported', async () => {
		const content = '"""\ntitle: Unit converter\ndescription: Converts units.\n"""\n';
		const { onImport, onOpenChange } = open(async () => ({ name: 'unit', content }) as never);
		await waitFor(() => expect(onImport).toHaveBeenCalled());
		expect(onImport).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'unit', name: 'Unit converter', meta: { description: 'Converts units.' } }),
			'https://example.com/unit.py'
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('stays open with the reason when the link cannot be loaded', async () => {
		const { onImport, onOpenChange } = open(async () => Promise.reject('Not found') as never);
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not found'));
		expect(onImport).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});
