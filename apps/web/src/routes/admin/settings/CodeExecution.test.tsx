import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import CodeExecution from './CodeExecution';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn(), info: vi.fn() })
}));

// What GET /configs/code_execution returns: both engines on Jupyter, so both
// timeout boxes are on screen.
const CONFIG = {
	ENABLE_CODE_EXECUTION: true,
	CODE_EXECUTION_ENGINE: 'jupyter',
	CODE_EXECUTION_JUPYTER_URL: 'http://jupyter:8888',
	CODE_EXECUTION_JUPYTER_AUTH: '',
	CODE_EXECUTION_JUPYTER_AUTH_TOKEN: '',
	CODE_EXECUTION_JUPYTER_AUTH_PASSWORD: '',
	CODE_EXECUTION_JUPYTER_TIMEOUT: 60,
	ENABLE_CODE_INTERPRETER: true,
	CODE_INTERPRETER_ENGINE: 'jupyter',
	CODE_INTERPRETER_PROMPT_TEMPLATE: '',
	CODE_INTERPRETER_JUPYTER_URL: 'http://jupyter:8888',
	CODE_INTERPRETER_JUPYTER_AUTH: '',
	CODE_INTERPRETER_JUPYTER_AUTH_TOKEN: '',
	CODE_INTERPRETER_JUPYTER_AUTH_PASSWORD: '',
	CODE_INTERPRETER_JUPYTER_TIMEOUT: 120
};

// The body of every POST, and what the server answers it with.
let posted: Record<string, unknown>[] = [];
let answer: () => Response = () => new Response(JSON.stringify(CONFIG), { status: 200 });

beforeEach(() => {
	posted = [];
	answer = () => new Response(JSON.stringify(CONFIG), { status: 200 });
	toastError.mockReset();
	useAuthStore.setState({ token: 't' } as never);
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
		if (init?.method === 'POST') {
			posted.push(JSON.parse(String(init.body)));
			return answer();
		}
		return new Response(JSON.stringify(CONFIG), { status: 200 });
	});
});

afterEach(() => vi.restoreAllMocks());

const renderTab = async () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<CodeExecution />
		</QueryClientProvider>
	);
	const boxes = await screen.findAllByPlaceholderText('e.g. 60');
	expect(boxes).toHaveLength(2);
	return boxes;
};

const save = () => fireEvent.click(screen.getByRole('button', { name: /save/i }));

describe('CodeExecution: a cleared Jupyter timeout', () => {
	it('is sent as null for code execution, which the int | None field accepts', async () => {
		const [execution] = await renderTab();
		fireEvent.change(execution, { target: { value: '' } });
		save();
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0].CODE_EXECUTION_JUPYTER_TIMEOUT).toBeNull();
		expect(posted[0].CODE_INTERPRETER_JUPYTER_TIMEOUT).toBe(120);
	});

	it('is sent as null for the code interpreter too', async () => {
		const [, interpreter] = await renderTab();
		fireEvent.change(interpreter, { target: { value: '' } });
		save();
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0].CODE_INTERPRETER_JUPYTER_TIMEOUT).toBeNull();
		expect(posted[0].CODE_EXECUTION_JUPYTER_TIMEOUT).toBe(60);
	});

	it('still sends a typed timeout as a number', async () => {
		const [execution] = await renderTab();
		fireEvent.change(execution, { target: { value: '90' } });
		save();
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0].CODE_EXECUTION_JUPYTER_TIMEOUT).toBe(90);
	});
});

describe('CodeExecution: a rejected save', () => {
	it("toasts the server's validation message, not [object Object]", async () => {
		const msg = 'Input should be a valid integer, unable to parse string as an integer';
		answer = () =>
			new Response(
				JSON.stringify({
					detail: [{ type: 'int_parsing', loc: ['body', 'CODE_EXECUTION_JUPYTER_TIMEOUT'], msg, input: '' }]
				}),
				{ status: 422 }
			);
		await renderTab();
		save();
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError).toHaveBeenCalledWith(`CODE_EXECUTION_JUPYTER_TIMEOUT: ${msg}`);
	});
});
