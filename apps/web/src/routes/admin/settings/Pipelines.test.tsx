import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPageHost } from '@/components/settings/controls';
import { useAuthStore } from '@/lib/stores/authStore';
import Pipelines from './Pipelines';

vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() })
}));

const apis = vi.hoisted(() => ({
	getPipelinesList: vi.fn(),
	getPipelines: vi.fn(),
	getPipelineValves: vi.fn(),
	getPipelineValvesSpec: vi.fn(),
	updatePipelineValves: vi.fn(),
	deletePipeline: vi.fn(),
	downloadPipeline: vi.fn(),
	uploadPipeline: vi.fn()
}));
vi.mock('@/lib/apis', async (importOriginal) => ({ ...(await importOriginal<object>()), ...apis }));

const SPEC = { properties: { api_key: { title: 'API key', type: 'string' } } };
const VALVES: Record<string, Record<string, unknown>> = { p1: { api_key: 'first' }, p2: { api_key: 'second' } };

beforeEach(() => {
	useAuthStore.setState({ token: 't' } as never);
	apis.getPipelinesList.mockReset().mockResolvedValue([{ idx: 0, url: 'http://127.0.0.1:9099' }]);
	apis.getPipelines.mockReset().mockResolvedValue([
		{ id: 'p1', name: 'Rate limit', type: 'filter', valves: true },
		{ id: 'p2', name: 'Summarise', type: 'pipe', valves: true }
	]);
	apis.getPipelineValvesSpec.mockReset().mockResolvedValue(SPEC);
	apis.getPipelineValves.mockReset().mockImplementation(async (_t: string, id: string) => VALVES[id]);
	apis.updatePipelineValves.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => vi.clearAllMocks());

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createMemoryRouter(
		[
			{
				path: '/admin/settings/pipelines',
				element: (
					<SettingsPageHost>
						<Pipelines />
						<Link to="/elsewhere">Elsewhere</Link>
					</SettingsPageHost>
				)
			},
			{ path: '/elsewhere', element: <p>elsewhere</p> }
		],
		{ initialEntries: ['/admin/settings/pipelines'] }
	);
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
	return router;
}

const valveBox = () => screen.findByRole<HTMLInputElement>('textbox', { name: 'API key' });
const status = () => screen.getByText(/Unsaved changes|All changes saved/);

describe('Pipelines: the valves are a draft with the SaveBar (FRM-3)', () => {
	it('shows the SaveBar, says when the valves change, and Discard changes puts them back', async () => {
		mount();
		expect((await valveBox()).value).toBe('first');
		expect(status().textContent).toBe('All changes saved');
		expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
		fireEvent.change(await valveBox(), { target: { value: 'edited' } });
		expect(status().textContent).toBe('Unsaved changes');
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect((await valveBox()).value).toBe('first');
		expect(status().textContent).toBe('All changes saved');
	});

	it('saves the edited valves, after which nothing is unsaved', async () => {
		mount();
		fireEvent.change(await valveBox(), { target: { value: 'edited' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(apis.updatePipelineValves).toHaveBeenCalledWith('t', 'p1', { api_key: 'edited' }, '0'));
		await waitFor(() => expect(status().textContent).toBe('All changes saved'));
	});

	it('stays unsaved when the server refuses the valves', async () => {
		apis.updatePipelineValves.mockRejectedValue('Refused');
		mount();
		fireEvent.change(await valveBox(), { target: { value: 'edited' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(apis.updatePipelineValves).toHaveBeenCalled());
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false));
		expect(status().textContent).toBe('Unsaved changes');
	});

	it('asks before navigation loses edited valves, through the page’s guard', async () => {
		const router = mount();
		fireEvent.change(await valveBox(), { target: { value: 'edited' } });
		fireEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(router.state.location.pathname).toBe('/admin/settings/pipelines');
		fireEvent.click(within(ask).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
	});

	it('asks before choosing another pipeline loses edited valves; Keep editing keeps them', async () => {
		mount();
		fireEvent.change(await valveBox(), { target: { value: 'edited' } });
		const pipeline = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Pipeline' });
		fireEvent.change(pipeline, { target: { value: '1' } });
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask.textContent).toContain('lost if you choose another');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(pipeline.value).toBe('0');
		expect((await valveBox()).value).toBe('edited');

		fireEvent.change(pipeline, { target: { value: '1' } });
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() =>
			expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'API key' }).value).toBe('second')
		);
		expect(status().textContent).toBe('All changes saved');
	});

	it('chooses another pipeline or server at once while nothing is unsaved', async () => {
		mount();
		await valveBox();
		act(() => {
			fireEvent.change(screen.getByRole('combobox', { name: 'Pipeline' }), { target: { value: '1' } });
		});
		await waitFor(() =>
			expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'API key' }).value).toBe('second')
		);
		fireEvent.change(screen.getByRole('combobox', { name: 'Pipeline URL' }), { target: { value: '0' } });
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('shows no SaveBar while no pipelines server is connected', async () => {
		apis.getPipelinesList.mockResolvedValue([]);
		mount();
		expect(await screen.findAllByText('Pipelines Not Detected')).toHaveLength(1);
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
		expect(screen.queryByText('All changes saved')).toBeNull();
	});
});

describe('Pipelines: Delete', () => {
	it('asks first, naming the pipeline, and deletes only on Delete pipeline (ACT-3)', async () => {
		apis.deletePipeline.mockReset().mockResolvedValue({ ok: true });
		mount();
		await valveBox();
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Delete “Rate limit”?' });
		expect(apis.deletePipeline).not.toHaveBeenCalled();
		fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(apis.deletePipeline).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		const confirm = await screen.findByRole('alertdialog', { name: 'Delete “Rate limit”?' });
		fireEvent.click(within(confirm).getByRole('button', { name: 'Delete pipeline' }));
		await waitFor(() => expect(apis.deletePipeline).toHaveBeenCalledWith('t', 'p1', '0'));
	});
});
