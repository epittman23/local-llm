import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AccessGrant } from '@/lib/access/accessGrants';
import { updateToolAccessGrants } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { ToolkitEditor } from './ToolkitEditor';
import type { ToolDraft } from './toolTypes';

// The editors guard unsaved changes with useBlocker, which needs a data router.
const Routed = ({ children }: { children: ReactNode }) => (
	<RouterProvider router={createMemoryRouter([{ path: '*', element: children }])} />
);

// The install's account count, for useSingleUser (S4-D1): two unless a test says one.
const accounts = vi.hoisted(() => ({ total: 2 }));
vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn(async () => ({ total: accounts.total })) }));

vi.mock('@/lib/apis/tools', () => ({ updateToolAccessGrants: vi.fn() }));
// The code editor, reduced to its handle and the props it was last given.
const codeEditor = vi.hoisted(() => ({
	outcome: 'unformatted' as string,
	props: {} as { onParseError?: (error: unknown) => void }
}));
vi.mock('@/components/common/CodeEditor', async () => {
	const { useImperativeHandle } = await import('react');
	return {
		default: (props: { ref?: React.Ref<unknown>; onParseError?: (error: unknown) => void }) => {
			codeEditor.props = props;
			useImperativeHandle(props.ref, () => ({ formatPython: async () => codeEditor.outcome, focus: () => {} }));
			return null;
		}
	};
});

// The access dialog, reduced to what the editor gives it and what it sends back.
const accessDialog = vi.hoisted(() => ({ send: [] as AccessGrant[] }));
vi.mock('@/components/common/AccessControlModal', () => ({
	AccessControlModal: ({
		accessGrants,
		onChange
	}: {
		accessGrants: AccessGrant[];
		onChange: (grants: AccessGrant[]) => Promise<void>;
	}) => (
		<div>
			<output data-testid="shown-grants">{accessGrants.map((g) => g.principal_id).join(',')}</output>
			<button type="button" onClick={() => void onChange(accessDialog.send)}>
				Send grants
			</button>
		</div>
	)
}));

const tool: ToolDraft = { id: 'calc', name: 'Calc', meta: { description: 'd' }, content: 'code', access_grants: [] };
const grant = (principal_id: string): AccessGrant => ({ principal_type: 'user', principal_id, permission: 'read' });
const shown = () => screen.getByTestId('shown-grants').textContent;
const send = (grants: AccessGrant[]) => {
	accessDialog.send = grants;
	fireEvent.click(screen.getByText('Send grants'));
};
const renderEditor = (props: Parameters<typeof ToolkitEditor>[0]) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<Routed>
					<ToolkitEditor {...props} />
				</Routed>
			</TooltipProvider>
		</QueryClientProvider>
	);

beforeEach(() => {
	useAuthStore.setState({
		token: 't',
		user: { id: 'u', email: 'e', name: 'n', role: 'user', profile_image_url: '' }
	} as never);
});
afterEach(() => {
	vi.clearAllMocks();
	codeEditor.outcome = 'unformatted';
});

describe('ToolkitEditor access dialog (#676)', () => {
	it('shows the grants the server stored, and warns when it dropped some', async () => {
		vi.mocked(updateToolAccessGrants).mockResolvedValue({ id: 'calc', access_grants: [grant('a')] });
		const warning = vi.spyOn(toast, 'warning');
		const success = vi.spyOn(toast, 'success');
		renderEditor({ tool, edit: true, onSave: vi.fn() });

		send([grant('a'), grant('*')]);

		await waitFor(() =>
			expect(warning).toHaveBeenCalledWith(
				'Some access settings were not saved: you are not allowed to share this way.'
			)
		);
		expect(shown()).toBe('a');
		expect(success).not.toHaveBeenCalled();
		expect(updateToolAccessGrants).toHaveBeenCalledWith('t', 'calc', [grant('a'), grant('*')]);
	});

	it('puts the previous grants back when the save fails, and says why', async () => {
		vi.mocked(updateToolAccessGrants).mockRejectedValue('Not allowed');
		const error = vi.spyOn(toast, 'error');
		renderEditor({ tool, edit: true, onSave: vi.fn() });

		send([grant('a')]);

		await waitFor(() => expect(error).toHaveBeenCalledWith('Not allowed'));
		expect(shown()).toBe('');
	});

	it('only keeps the grants of a tool not yet created, to send with it', async () => {
		const success = vi.spyOn(toast, 'success');
		renderEditor({ tool: null, onSave: vi.fn() });

		send([grant('a')]);

		await waitFor(() => expect(shown()).toBe('a'));
		expect(updateToolAccessGrants).not.toHaveBeenCalled();
		expect(success).not.toHaveBeenCalled();
	});
});

describe('ToolkitEditor fields (#1057, #983)', () => {
	it('gives each field a visible label tied to it, and an example as its placeholder', () => {
		renderEditor({ tool: { ...tool, id: '', name: '' }, edit: false, onSave: vi.fn() });
		const name = screen.getByLabelText('Tool name');
		expect(name).toHaveAttribute('data-slot', 'textarea'); // the shared Textarea, one line that wraps (#958)
		expect(name).toHaveAttribute('placeholder', 'e.g. My Tools');
		expect(screen.getByLabelText('Tool ID')).toHaveClass('font-mono');
		expect(screen.getByLabelText('Tool description')).toHaveValue('d');
		expect(screen.getByText('Tool name').tagName).toBe('LABEL');
	});

	it('edits the name, id and description through the labelled fields', () => {
		renderEditor({ tool: { ...tool, id: '', name: '' }, edit: false, onSave: vi.fn() });
		fireEvent.change(screen.getByLabelText('Tool name'), { target: { value: 'Unit Converter' } });
		fireEvent.change(screen.getByLabelText('Tool ID'), { target: { value: 'units' } });
		fireEvent.change(screen.getByLabelText('Tool description'), { target: { value: 'Converts units' } });
		expect(screen.getByLabelText('Tool name')).toHaveValue('Unit Converter');
		expect(screen.getByLabelText('Tool ID')).toHaveValue('units');
		expect(screen.getByLabelText('Tool description')).toHaveValue('Converts units');
	});

	it('shows a created tool’s fixed id as text, not as a field', () => {
		renderEditor({ tool, edit: true, onSave: vi.fn() });
		expect(screen.queryByLabelText('Tool ID')).toBeNull();
		expect(screen.getByText('Tool ID')).toBeInTheDocument();
		expect(screen.getByTitle('calc')).toHaveTextContent('calc');
	});
});

describe('ToolkitEditor code field (#910, #987)', () => {
	it('labels the code and says how to leave it with the keyboard', () => {
		renderEditor({ tool, edit: true, onSave: vi.fn() });
		expect(screen.getByText('Tool code')).toBeInTheDocument();
		expect(screen.getByText('Tab indents. Press Esc, then Tab, to leave the editor.')).toHaveAttribute('id');
	});
});

describe('ToolkitEditor errors stay above the footer (#1015)', () => {
	it('shows why a save failed in place of the help line, not as a toast', async () => {
		const error = vi.spyOn(toast, 'error');
		const onSave = vi.fn().mockRejectedValue('[ERROR: Error updating tool]');
		renderEditor({ tool, edit: true, onSave });
		fireEvent.submit(screen.getByLabelText('Tool name').closest('form') as HTMLFormElement);
		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent("Couldn't save the tool. The server couldn't load its code; check that it runs.");
		expect(screen.queryByText('Tab indents. Press Esc, then Tab, to leave the editor.')).toBeNull();
		expect(error).not.toHaveBeenCalled();
	});

	it('does not send code that is not valid Python, and says where it stopped', async () => {
		codeEditor.outcome = 'invalid';
		const onSave = vi.fn();
		renderEditor({ tool, edit: true, onSave });
		fireEvent.submit(screen.getByLabelText('Tool name').closest('form') as HTMLFormElement);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).not.toHaveAttribute('aria-busy'));
		act(() => codeEditor.props.onParseError?.({ line: 3, column: 9, detail: 'cannot parse: 3:9' }));
		expect(screen.getByRole('alert')).toHaveTextContent("Line 3, column 9: this line isn't valid Python.");
		expect(onSave).not.toHaveBeenCalled();
		act(() => codeEditor.props.onParseError?.(null));
		expect(screen.queryByRole('alert')).toBeNull();
	});
});

describe('ToolkitEditor saves on request (#905, #1011, FRM-3)', () => {
	it('names its save for what it does, and counts only real changes as unsaved', () => {
		renderEditor({ tool, edit: true, onSave: vi.fn() });
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
		expect(screen.getByText('All changes saved')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Tool name'), { target: { value: 'Calc 2' } });
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.getByLabelText('Tool name')).toHaveValue('Calc');
		expect(screen.getByText('All changes saved')).toBeInTheDocument();
	});

	it('a new tool starts saved: the boilerplate is not a change', () => {
		renderEditor({ tool: null, onSave: vi.fn() });
		expect(screen.getByRole('button', { name: 'Create tool' })).toBeDisabled();
		expect(screen.getByText('Nothing to save yet')).toBeInTheDocument();
	});

	it('takes the stored code as saved after an edit, and stays on the page', async () => {
		const onSave = vi.fn().mockResolvedValue(true);
		renderEditor({ tool, edit: true, onSave });
		fireEvent.change(screen.getByLabelText('Tool name'), { target: { value: 'Calc 2' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() => expect(screen.getByText('All changes saved')).toBeInTheDocument());
		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Calc 2', content: 'code' }));
		expect(screen.getByLabelText('Tool name')).toBeInTheDocument();
	});
});

describe('ToolkitEditor acknowledgement (#1098, S4-D4)', () => {
	it('creates code written here without asking', async () => {
		const onSave = vi.fn().mockResolvedValue(false);
		renderEditor({ tool: null, onSave });
		fireEvent.change(screen.getByLabelText('Tool name'), { target: { value: 'Mine' } });
		fireEvent.change(screen.getByLabelText('Tool description'), { target: { value: 'Mine' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('asks before creating an import, naming the link it came from', async () => {
		const onSave = vi.fn().mockResolvedValue(false);
		renderEditor({ tool, clone: true, source: { kind: 'link', from: 'https://example.com/calc.py' }, onSave });
		fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));
		const ack = await screen.findByRole('alertdialog', { name: 'Create tool?' });
		expect(ack).toHaveTextContent(
			'The code comes from https://example.com/calc.py, and tools run their code on this server: create it only if you trust that source.'
		);
		expect(onSave).not.toHaveBeenCalled();
	});
});

describe('ToolkitEditor with one account (#1013, S4-D1)', () => {
	afterEach(() => {
		accounts.total = 2;
	});
	it('hides Access while the install has one account', async () => {
		accounts.total = 1;
		renderEditor({ tool, edit: true, onSave: vi.fn() });
		await screen.findByLabelText('Tool name');
		expect(screen.queryByRole('button', { name: 'Access' })).toBeNull();
	});
	it('shows Access once there is a second account', async () => {
		renderEditor({ tool, edit: true, onSave: vi.fn() });
		expect(await screen.findByRole('button', { name: 'Access' })).toBeInTheDocument();
	});
});

describe('ToolkitEditor description (#958)', () => {
	it('is a two-line field that grows with its text', () => {
		renderEditor({ tool, edit: true, onSave: vi.fn() });
		const description = screen.getByLabelText('Tool description');
		expect(description.tagName).toBe('TEXTAREA');
		expect(description).toHaveAttribute('rows', '2');
		expect(description).toHaveClass('max-h-40');
	});
});
