import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptHistoryMenu } from '@/components/common/PromptHistoryMenu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPromptById, getPromptHistory, updatePromptById, updatePromptMetadata } from '@/lib/apis/prompts';
import { useAuthStore } from '@/lib/stores/authStore';
import { PromptCreateDialog } from './PromptCreateDialog';
import { PromptEditPage } from './PromptEditPage';
import { PromptEditView } from './PromptEditView';
import { commandProblem } from './promptTypes';

const accounts = vi.hoisted(() => ({ total: 2 }));
vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn(async () => ({ total: accounts.total })) }));
vi.mock('@/lib/apis/prompts', () => ({
	deletePromptHistoryVersion: vi.fn(),
	getPromptById: vi.fn(),
	getPromptHistory: vi.fn(async () => []),
	getPromptTags: vi.fn(async () => []),
	setProductionPromptVersion: vi.fn(),
	updatePromptAccessGrants: vi.fn(),
	updatePromptById: vi.fn(),
	updatePromptMetadata: vi.fn(async () => ({}))
}));

const TAKEN = 'Uh-oh! This command is already registered. Please choose another command string.';
const prompt = {
	id: 'p1',
	name: 'Summary',
	command: '/summary',
	content: 'Summarise this.',
	version_id: 'v2',
	tags: [],
	access_grants: []
};

const wrap = (ui: ReactNode, path = '/') =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<RouterProvider
					router={createMemoryRouter(
						[
							{ path: '/workspace/prompts/:id', element: ui },
							{ path: '*', element: ui }
						],
						{ initialEntries: [path] }
					)}
				/>
			</TooltipProvider>
		</QueryClientProvider>
	);

beforeEach(() => {
	useAuthStore.setState({ token: 't', user: { id: 'u', role: 'user' } } as never);
});
afterEach(() => {
	vi.clearAllMocks();
	accounts.total = 2;
});

describe('commandProblem (#1095)', () => {
	it('words a taken command for the field, and leaves other failures alone', () => {
		expect(commandProblem(TAKEN, 'summary')).toBe(
			'/summary is already used by another prompt. Choose another command.'
		);
		expect(commandProblem('Network error', 'summary')).toBeNull();
		expect(commandProblem(undefined, 'summary')).toBeNull();
	});
});

describe('PromptCreateDialog fields (#911, #1095)', () => {
	const open = (onSubmit = vi.fn()) => {
		wrap(<PromptCreateDialog open draft={null} onSubmit={onSubmit} onClose={vi.fn()} />);
		return onSubmit;
	};

	it('labels the shared fields, with the command as one field after a fixed "/"', () => {
		open();
		expect(screen.getByRole('heading', { name: 'New prompt' })).toBeInTheDocument();
		expect(screen.getByLabelText('Name')).toHaveAttribute('data-slot', 'input');
		expect(screen.getByLabelText('Prompt content')).toHaveAttribute('data-slot', 'textarea');
		const command = screen.getByLabelText('Command');
		expect(command.closest('[data-composite-field]')).toHaveTextContent('/');
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Weekly Report' } });
		expect(command).toHaveValue('weekly-report');
		expect(screen.getByText('Type /weekly-report in a chat to use it.')).toBeInTheDocument();
	});

	it('says a bad command under the field, without sending', () => {
		const onSubmit = open();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ok' } });
		fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'has spaces!' } });
		fireEvent.change(screen.getByLabelText('Prompt content'), { target: { value: 'x' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create prompt' }));
		expect(screen.getByRole('alert')).toHaveTextContent('Use only letters, numbers, hyphens and underscores.');
		expect(screen.getByLabelText('Command')).toHaveAttribute('aria-invalid', 'true');
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('asks for a command when it is empty, rather than listing the characters it may use', () => {
		const onSubmit = open();
		fireEvent.change(screen.getByLabelText('Prompt content'), { target: { value: 'x' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create prompt' }));
		expect(screen.getByLabelText('Command')).toHaveAccessibleDescription('Enter a command.');
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('says a taken command under the field, and any other failure above the buttons', async () => {
		const onSubmit = open(vi.fn().mockRejectedValueOnce(TAKEN).mockRejectedValueOnce('Server storage is full'));
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Summary' } });
		fireEvent.change(screen.getByLabelText('Prompt content'), { target: { value: 'x' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create prompt' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('/summary is already used by another prompt.');
		fireEvent.click(screen.getByRole('button', { name: 'Create prompt' }));
		expect(await screen.findByText("Couldn't create the prompt. Server storage is full")).toBeInTheDocument();
		expect(onSubmit).toHaveBeenCalledTimes(2);
	});

	it('is a 48 rem form that opens on Name, and says what is missing under each field (OVL-1, #1010)', async () => {
		const onSubmit = open();
		const name = screen.getByLabelText('Name');
		expect(screen.getByRole('dialog')).toHaveClass('sm:max-w-3xl');
		await waitFor(() => expect(document.activeElement).toBe(name));
		expect(name.closest('form')).toHaveAttribute('novalidate');
		fireEvent.submit(name.closest('form') as HTMLFormElement);
		expect(name).toHaveAccessibleDescription('Enter a name for this prompt.');
		expect(screen.getByLabelText('Prompt content')).toHaveAccessibleDescription(
			'Write the prompt: its command puts this text in the message.'
		);
		expect(document.activeElement).toBe(name);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('closes at once while untouched, and asks before Esc, × or Cancel drops a draft (FRM-3)', async () => {
		const onClose = vi.fn();
		wrap(<PromptCreateDialog open draft={null} onSubmit={vi.fn()} onClose={onClose} />);
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onClose).toHaveBeenCalledTimes(1);
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Weekly report' } });
		fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('This prompt is not created yet.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(onClose).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('closes without asking once the prompt is created', async () => {
		const onClose = vi.fn();
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		wrap(<PromptCreateDialog open draft={null} onSubmit={onSubmit} onClose={onClose} />);
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Weekly report' } });
		fireEvent.change(screen.getByLabelText('Prompt content'), { target: { value: 'Summarise the week.' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create prompt' }));
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('hides Access while the install has one account', async () => {
		accounts.total = 1;
		open();
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Access' })).toBeNull());
	});
});

describe('PromptHistoryMenu Delete version (#1012)', () => {
	it('names the version by its date, in the danger colour', async () => {
		const onDelete = vi.fn();
		wrap(<PromptHistoryMenu isProduction={false} date="Nov 14, 2026" onDelete={onDelete} />);
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Version options' }), { button: 0, ctrlKey: false });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete version' }));
		const dialog = await screen.findByRole('alertdialog', { name: 'Delete version from Nov 14, 2026?' });
		const confirm = within(dialog).getByRole('button', { name: 'Delete version' });
		expect(confirm).toHaveAttribute('data-variant', 'destructive');
		fireEvent.click(confirm);
		expect(onDelete).toHaveBeenCalledOnce();
	});
});

describe('PromptEditView (#911, #957, #1095)', () => {
	const view = (onSubmit = vi.fn()) => wrap(<PromptEditView prompt={prompt} disabled={false} onSubmit={onSubmit} />);

	it('keeps a taken command in its field with the reason under it, and says when the fields saved', async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(updatePromptMetadata).mockRejectedValueOnce(TAKEN).mockResolvedValueOnce({});
			view();
			fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'taken' } });
			await act(async () => vi.advanceTimersByTimeAsync(600));
			expect(screen.getByRole('alert')).toHaveTextContent('/taken is already used by another prompt.');
			expect(screen.getByLabelText('Command')).toHaveValue('taken');
			fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'free' } });
			await act(async () => vi.advanceTimersByTimeAsync(600));
			expect(screen.queryByRole('alert')).toBeNull();
			expect(screen.getByRole('status')).toHaveTextContent('Saved');
		} finally {
			vi.useRealTimers();
		}
	});

	it('puts the fields back and says so when a save fails for another reason', async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(updatePromptMetadata).mockRejectedValueOnce('Network error');
			view();
			fireEvent.change(screen.getByLabelText('Prompt name'), { target: { value: 'Other' } });
			await act(async () => vi.advanceTimersByTimeAsync(600));
			expect(screen.getByLabelText('Prompt name')).toHaveValue('Summary');
			expect(screen.getByRole('status')).toHaveTextContent("Couldn't save the name, command or tags.");
			fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'bad command' } });
			await act(async () => vi.advanceTimersByTimeAsync(600));
			expect(screen.getByRole('alert')).toHaveTextContent('Use only letters');
		} finally {
			vi.useRealTimers();
		}
	});

	it('asks for a command when one is cleared, and will not save a version without it', async () => {
		vi.useFakeTimers();
		try {
			const onSubmit = vi.fn();
			view(onSubmit);
			fireEvent.change(screen.getByLabelText('Command'), { target: { value: '' } });
			await act(async () => vi.advanceTimersByTimeAsync(600));
			expect(screen.getByRole('alert')).toHaveTextContent('Enter a command.');
			expect(updatePromptMetadata).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
			await act(async () => vi.advanceTimersByTimeAsync(0));
			const dialog = screen.getByRole('dialog', { name: 'Edit prompt' });
			fireEvent.change(within(dialog).getByLabelText('Prompt content'), { target: { value: 'New' } });
			fireEvent.click(within(dialog).getByRole('button', { name: 'Save new version' }));
			await act(async () => vi.advanceTimersByTimeAsync(0));
			expect(dialog).toHaveTextContent('Enter a command, then save the new version.');
			expect(onSubmit).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('opens the history as a sheet from the header, and closes it on a pick', async () => {
		vi.mocked(getPromptHistory).mockResolvedValue([
			{ id: 'v2', commit_message: 'Second', created_at: 2, snapshot: { content: 'Two' } },
			{ id: 'v1', commit_message: 'First', created_at: 1, snapshot: { content: 'One' } }
		] as never);
		view();
		fireEvent.click(screen.getByRole('button', { name: 'History' }));
		const sheet = await screen.findByRole('dialog', { name: 'History' });
		// Its title says History once; the list inside does not repeat it.
		expect(within(sheet).getAllByText('History')).toHaveLength(1);
		fireEvent.click(await within(sheet).findByText('First'));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'History' })).toBeNull());
		expect(screen.getByText('One')).toBeInTheDocument();
	});

	it('asks before Esc drops an edited version, puts the content back on Discard, and says an empty prompt under it', async () => {
		const onSubmit = vi.fn();
		view(onSubmit);
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		let dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
		// Untouched, it closes at once.
		fireEvent.keyDown(dialog, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit prompt' })).toBeNull());
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
		const content = within(dialog).getByLabelText('Prompt content');
		fireEvent.change(content, { target: { value: '' } });
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save new version' }));
		expect(content).toHaveAccessibleDescription('Write the prompt: its command puts this text in the message.');
		expect(onSubmit).not.toHaveBeenCalled();
		fireEvent.keyDown(dialog, { key: 'Escape' });
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('This version is not saved.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(screen.getByRole('dialog', { name: 'Edit prompt' })).toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole('dialog', { name: 'Edit prompt' }), { key: 'Escape' });
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit prompt' })).toBeNull());
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
		expect(within(dialog).getByLabelText('Prompt content')).toHaveValue('Summarise this.');
		expect(within(dialog).getByLabelText('Prompt content')).not.toHaveAttribute('aria-invalid');
	});

	it('saves a new version from labelled fields, and keeps a failure in the dialog', async () => {
		const onSubmit = vi.fn().mockRejectedValueOnce(TAKEN).mockResolvedValueOnce(undefined);
		view(onSubmit);
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		const dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
		fireEvent.change(within(dialog).getByLabelText('Prompt content'), { target: { value: 'New' } });
		const changed = within(dialog).getByLabelText('What changed (optional)');
		// "(optional)" is muted, as on the editors' other optional fields (FRM-6).
		expect(within(dialog).getByText('(optional)')).toHaveClass('text-foreground-muted');
		fireEvent.change(changed, { target: { value: 'shorter' } });
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save new version' }));
		expect(await within(dialog).findByRole('alert')).toHaveTextContent('/summary is already used by another prompt.');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save new version' }));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit prompt' })).toBeNull());
		expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'New', commit_message: 'shorter' }));
	});
});

describe('PromptEditPage (#1095, NAV-3, STA-4)', () => {
	it('says in place that a prompt no longer exists', async () => {
		vi.mocked(getPromptById).mockRejectedValue("We could not find what you're looking for :/");
		wrap(<PromptEditPage />, '/workspace/prompts/gone');
		expect(await screen.findByRole('heading', { name: 'This prompt no longer exists.' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Prompts' })).toBeInTheDocument();
	});

	it('offers to try again when the prompt failed to load', async () => {
		vi.mocked(getPromptById)
			.mockRejectedValueOnce('Internal error')
			.mockResolvedValueOnce({
				...prompt,
				write_access: true
			} as never);
		wrap(<PromptEditPage />, '/workspace/prompts/p1');
		fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
		expect(await screen.findByLabelText('Prompt name')).toHaveValue('Summary');
	});

	it('adopts the saved version', async () => {
		vi.mocked(getPromptById).mockResolvedValue({ ...prompt, write_access: true } as never);
		vi.mocked(updatePromptById).mockResolvedValue({ ...prompt, content: 'Saved content' } as never);
		wrap(<PromptEditPage />, '/workspace/prompts/p1');
		fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
		const dialog = await screen.findByRole('dialog', { name: 'Edit prompt' });
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save new version' }));
		await waitFor(() => expect(updatePromptById).toHaveBeenCalledOnce());
	});
});
