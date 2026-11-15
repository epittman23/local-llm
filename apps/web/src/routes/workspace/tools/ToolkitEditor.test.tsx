import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AccessGrant } from '@/lib/access/accessGrants';
import { updateToolAccessGrants } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { ToolkitEditor } from './ToolkitEditor';
import type { ToolDraft } from './toolTypes';

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
		<TooltipProvider>
			<MemoryRouter>
				<ToolkitEditor {...props} />
			</MemoryRouter>
		</TooltipProvider>
	);

beforeEach(() => {
	useAuthStore.setState({
		token: 't',
		user: { id: 'u', email: 'e', name: 'n', role: 'user', profile_image_url: '' }
	} as never);
});
afterEach(() => vi.clearAllMocks());

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
		expect(name).toHaveAttribute('data-slot', 'input');
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
		await waitFor(() => expect(screen.getByRole('button', { name: /save/i })).toBeEnabled());
		act(() => codeEditor.props.onParseError?.({ line: 3, column: 9, detail: 'cannot parse: 3:9' }));
		expect(screen.getByRole('alert')).toHaveTextContent("Line 3, column 9: this line isn't valid Python.");
		expect(onSave).not.toHaveBeenCalled();
		act(() => codeEditor.props.onParseError?.(null));
		expect(screen.queryByRole('alert')).toBeNull();
		codeEditor.outcome = 'unformatted';
	});
});
