import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	getToolValvesById,
	getToolValvesSpecById,
	getUserValvesById,
	getUserValvesSpecById,
	updateToolValvesById
} from '@/lib/apis/tools';
import { ValvesModal } from './ValvesModal';

vi.mock('@/lib/apis/tools', () => ({
	getToolValvesById: vi.fn(),
	getToolValvesSpecById: vi.fn(),
	updateToolValvesById: vi.fn(),
	getUserValvesById: vi.fn(),
	getUserValvesSpecById: vi.fn(),
	updateUserValvesById: vi.fn()
}));
vi.mock('@/lib/apis/functions', () => ({}));

const spec = {
	properties: {
		tags: { title: 'Tags', type: 'array', default: [] },
		max_rows: { title: 'Max Rows', type: 'integer', default: 100 }
	}
};
const show = () => render(<ValvesModal open onOpenChange={vi.fn()} id="calc" name="Unit converter" />);

afterEach(() => vi.clearAllMocks());

describe('ValvesModal (#1016, WRD-2)', () => {
	it('is "Settings for" the tool, and saves arrays as arrays and empty fields as defaults', async () => {
		vi.mocked(getToolValvesById).mockResolvedValue({ tags: ['a', 'b'], max_rows: null });
		vi.mocked(getToolValvesSpecById).mockResolvedValue(spec);
		vi.mocked(updateToolValvesById).mockResolvedValue({});
		const success = vi.spyOn(toast, 'success');
		show();
		expect(screen.getByRole('dialog', { name: 'Settings for Unit converter' })).toBeInTheDocument();
		const tags = await screen.findByLabelText('Tags');
		expect(tags).toHaveValue('a,b');
		fireEvent.change(tags, { target: { value: 'x, y ,,z' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
		await waitFor(() =>
			expect(updateToolValvesById).toHaveBeenCalledWith(expect.anything(), 'calc', {
				tags: ['x', 'y', 'z'],
				max_rows: null
			})
		);
		expect(success).toHaveBeenCalledWith('Settings for Unit converter saved');
	});

	it("says in a sentence whose settings these are: the tool's, or the user's own", async () => {
		vi.mocked(getToolValvesById).mockResolvedValue({});
		vi.mocked(getToolValvesSpecById).mockResolvedValue(spec);
		vi.mocked(getUserValvesById).mockResolvedValue({});
		vi.mocked(getUserValvesSpecById).mockResolvedValue(spec);
		const { unmount } = show();
		expect(screen.getByText('Settings this tool takes. Leave a field empty to use its default.')).toBeInTheDocument();
		unmount();
		render(<ValvesModal open onOpenChange={vi.fn()} id="calc" name="Unit converter" userValves />);
		expect(
			screen.getByText('Your own settings for this tool. Leave a field empty to use its default.')
		).toBeInTheDocument();
		await screen.findByLabelText('Tags');
	});

	it('wraps a long title short of the close button (#1016)', async () => {
		vi.mocked(getToolValvesById).mockResolvedValue({});
		vi.mocked(getToolValvesSpecById).mockResolvedValue(spec);
		show();
		const title = screen.getByRole('heading', { name: 'Settings for Unit converter' });
		expect(title).toHaveClass('break-words');
		expect(title.parentElement).toHaveClass('pe-11');
		await screen.findByLabelText('Tags');
	});

	it('says a tool has no settings, with Save off', async () => {
		vi.mocked(getToolValvesById).mockResolvedValue({});
		vi.mocked(getToolValvesSpecById).mockResolvedValue(null);
		show();
		expect(await screen.findByText('This tool has no settings.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
	});

	it('says in the dialog when the settings did not load, and tries again', async () => {
		vi.mocked(getToolValvesById).mockRejectedValueOnce('Internal error').mockResolvedValue({});
		vi.mocked(getToolValvesSpecById).mockResolvedValue(spec);
		show();
		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the settings.");
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByLabelText('Max rows')).toBeInTheDocument();
	});

	it('keeps a failed save in the dialog', async () => {
		vi.mocked(getToolValvesById).mockResolvedValue({});
		vi.mocked(getToolValvesSpecById).mockResolvedValue(spec);
		vi.mocked(updateToolValvesById).mockRejectedValue('Value is not a valid integer');
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
		expect(await screen.findByRole('alert')).toHaveTextContent(
			"Couldn't save the settings. Value is not a valid integer"
		);
	});
});
