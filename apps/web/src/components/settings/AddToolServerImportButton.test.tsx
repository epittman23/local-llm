import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/lib/stores/authStore';
import { AddToolServerModal } from './AddToolServerModal';

const saveAs = vi.hoisted(() => vi.fn());
vi.mock('file-saver', () => ({ default: saveAs }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('AddToolServerModal header buttons', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	const open = () => {
		useAuthStore.setState({ token: 'jwt' } as never);
		render(
			<TooltipProvider>
				<AddToolServerModal open onOpenChange={vi.fn()} onSubmit={vi.fn()} />
			</TooltipProvider>
		);
	};

	it('opens the file chooser from the Import button', () => {
		open();
		const click = vi.spyOn(screen.getByLabelText('Import connection file') as HTMLInputElement, 'click');
		fireEvent.click(screen.getByRole('button', { name: 'Import' }));
		expect(click).toHaveBeenCalledTimes(1);
	});

	it('fills the form from an imported connection file', async () => {
		open();
		const file = new File([JSON.stringify({ url: 'https://tools.example.com', name: 'Imported' })], 'c.json', {
			type: 'application/json'
		});
		fireEvent.change(screen.getByLabelText('Import connection file'), { target: { files: [file] } });
		await waitFor(() => expect(screen.getByDisplayValue('https://tools.example.com')).toBeInTheDocument());
	});

	it('saves a connection file from the Export button', () => {
		open();
		fireEvent.click(screen.getByRole('button', { name: 'Export' }));
		expect(saveAs).toHaveBeenCalledTimes(1);
	});
});
