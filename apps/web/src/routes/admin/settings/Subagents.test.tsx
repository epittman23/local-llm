import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import Subagents from './Subagents';

vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() })
}));

// What GET /configs/subagents returns when the environment set both bounded limits to -1.
const BASE = {
	ENABLE_SUBAGENTS: true,
	SUBAGENTS_BACKGROUND_ENABLED: true,
	SUBAGENTS_MAX_CONCURRENT: -1,
	SUBAGENTS_MAX_ASYNC: 5,
	SUBAGENTS_MAX_ITERATIONS: -1,
	SUBAGENTS_MAX_OUTPUT: -1,
	SUBAGENTS_SYSTEM_PROMPT: ''
};

let CONFIG: typeof BASE = BASE;
let posted: Record<string, unknown>[] = [];

beforeEach(() => {
	posted = [];
	CONFIG = { ...BASE };
	useAuthStore.setState({ token: 't' } as never);
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
		if (init?.method === 'POST') posted.push(JSON.parse(String(init.body)));
		return new Response(JSON.stringify(CONFIG), { status: 200 });
	});
});

afterEach(() => vi.restoreAllMocks());

const renderTab = async () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<Subagents />
		</QueryClientProvider>
	);
	await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Max iterations').value).toBe('-1'));
	return {
		iterations: screen.getByLabelText<HTMLInputElement>('Max iterations'),
		output: screen.getByLabelText<HTMLInputElement>('Max output'),
		form: screen.getByLabelText<HTMLInputElement>('Max iterations').form as HTMLFormElement
	};
};

describe('Sub-agents limits: -1 is no limit (#602)', () => {
	it('loads -1 for iterations and output, and saves it', async () => {
		const { output, form } = await renderTab();
		expect(output.value).toBe('-1');
		expect(form.checkValidity()).toBe(true);

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({
			SUBAGENTS_MAX_CONCURRENT: -1,
			SUBAGENTS_MAX_ITERATIONS: -1,
			SUBAGENTS_MAX_OUTPUT: -1
		});
	});

	it('says on each of the four limits that -1 means no limit', async () => {
		await renderTab();
		expect(screen.getAllByText('Set -1 for no limit.')).toHaveLength(4);
	});

	it("keeps each field's own bounds for any other value", async () => {
		const { iterations, output, form } = await renderTab();

		fireEvent.change(output, { target: { value: '500' } });
		expect(output.validationMessage).toBe('Enter -1 for no limit, or at least 1000.');
		fireEvent.change(output, { target: { value: '30000' } });
		expect(output.validity.valid).toBe(true);

		fireEvent.change(iterations, { target: { value: '0' } });
		expect(iterations.validationMessage).toBe('Enter -1 for no limit, or at least 1.');
		expect(form.checkValidity()).toBe(false);
		fireEvent.change(iterations, { target: { value: '12' } });
		expect(form.checkValidity()).toBe(true);
	});
});

describe('Sub-agents limits above the old form maximum (#760)', () => {
	it('loads 200 and 200000 from the server and saves them unchanged', async () => {
		CONFIG = { ...BASE, SUBAGENTS_MAX_ITERATIONS: 200, SUBAGENTS_MAX_OUTPUT: 200000 };
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<Subagents />
			</QueryClientProvider>
		);
		await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Max iterations').value).toBe('200'));
		const iterations = screen.getByLabelText<HTMLInputElement>('Max iterations');
		const output = screen.getByLabelText<HTMLInputElement>('Max output');
		expect(output.value).toBe('200000');
		expect(iterations.validity.rangeOverflow).toBe(false);
		expect(output.validity.rangeOverflow).toBe(false);
		expect((iterations.form as HTMLFormElement).checkValidity()).toBe(true);

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ SUBAGENTS_MAX_ITERATIONS: 200, SUBAGENTS_MAX_OUTPUT: 200000 });
	});
});
