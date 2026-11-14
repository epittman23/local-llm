import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/components/common/CodeEditor', () => ({ default: () => null }));

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
