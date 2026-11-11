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
// What GET /configs/code_execution and GET /sandbox/status answer.
let served: Record<string, unknown> = CONFIG;
let sandboxStatus: () => Response = () => new Response(JSON.stringify({ ready: true, reason: null }), { status: 200 });

beforeEach(() => {
	posted = [];
	served = CONFIG;
	sandboxStatus = () => new Response(JSON.stringify({ ready: true, reason: null }), { status: 200 });
	answer = () => new Response(JSON.stringify(CONFIG), { status: 200 });
	toastError.mockReset();
	useAuthStore.setState({ token: 't' } as never);
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
		if (init?.method === 'POST') {
			posted.push(JSON.parse(String(init.body)));
			return answer();
		}
		if (String(_url).endsWith('/sandbox/status')) return sandboxStatus();
		return new Response(JSON.stringify(served), { status: 200 });
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

// Both engines on the sandbox, with the five settings the server stores.
const SANDBOX_CONFIG = {
	...CONFIG,
	CODE_EXECUTION_ENGINE: 'sandbox',
	CODE_INTERPRETER_ENGINE: 'sandbox',
	CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE: 'data',
	CODE_INTERPRETER_SANDBOX_TIMEOUT: 60,
	CODE_INTERPRETER_SANDBOX_MAX_RUNNING: 4,
	CODE_INTERPRETER_SANDBOX_IDLE_MINUTES: 30,
	CODE_INTERPRETER_SANDBOX_RETENTION_DAYS: 7
};

const renderSandbox = async (config: Record<string, unknown> = SANDBOX_CONFIG) => {
	served = config;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<CodeExecution />
		</QueryClientProvider>
	);
	await screen.findByLabelText('Code Interpreter Engine');
};

describe('CodeExecution: the sandbox engine', () => {
	it('offers sandbox as an engine for both sections', async () => {
		await renderSandbox({ ...CONFIG });
		for (const label of ['Code Execution Engine', 'Code Interpreter Engine']) {
			const options = Array.from(screen.getByLabelText(label).querySelectorAll('option')).map((o) => o.value);
			expect(options).toContain('sandbox');
		}
	});

	it('shows the five sandbox fields once, with the memory note', async () => {
		await renderSandbox();
		expect(screen.getAllByLabelText('Sandbox Default Image')).toHaveLength(1);
		expect(screen.getByLabelText('Sandbox Command Timeout')).toHaveValue(60);
		expect(screen.getByLabelText('Sandbox Maximum Running')).toHaveValue(4);
		expect(screen.getByLabelText('Sandbox Idle Minutes')).toHaveValue(30);
		expect(screen.getByLabelText('Sandbox Retention Days')).toHaveValue(7);
		expect(screen.getByText(/4 GiB of memory and 2 CPUs, so 16 at once is 64 GiB/)).toBeTruthy();
		expect(screen.queryByText('Jupyter URL')).toBeNull();
	});

	it('shows them under Code Execution when only that engine is the sandbox', async () => {
		await renderSandbox({ ...SANDBOX_CONFIG, CODE_INTERPRETER_ENGINE: 'pyodide' });
		expect(await screen.findAllByLabelText('Sandbox Maximum Running')).toHaveLength(1);
	});

	it('shows them under Code Execution when the interpreter is off but both engines are the sandbox', async () => {
		served = { ...SANDBOX_CONFIG, ENABLE_CODE_INTERPRETER: false };
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<CodeExecution />
			</QueryClientProvider>
		);
		expect(await screen.findAllByLabelText('Sandbox Maximum Running')).toHaveLength(1);
		expect(screen.queryByLabelText('Code Interpreter Engine')).toBeNull();
	});

	it('shows the default image when none is stored, and no reason when none is given', async () => {
		sandboxStatus = () => new Response(JSON.stringify({ ready: false, reason: null }), { status: 200 });
		await renderSandbox({ ...SANDBOX_CONFIG, CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE: null });
		expect(screen.getByLabelText('Sandbox Default Image')).toHaveValue('data');
		expect((await screen.findByRole('status')).textContent).toBe('The sandbox is unavailable: no reason given');
	});

	it('shows none of them for another engine', async () => {
		await renderSandbox({ ...SANDBOX_CONFIG, CODE_EXECUTION_ENGINE: 'pyodide', CODE_INTERPRETER_ENGINE: 'pyodide' });
		expect(screen.queryByLabelText('Sandbox Maximum Running')).toBeNull();
	});

	it('says the sandbox is ready', async () => {
		await renderSandbox();
		expect((await screen.findByRole('status')).textContent).toBe('The sandbox is ready.');
	});

	it('says why the sandbox is unavailable', async () => {
		sandboxStatus = () =>
			new Response(JSON.stringify({ ready: false, reason: 'the kata-clh runtime is not registered' }), {
				status: 200
			});
		await renderSandbox();
		expect((await screen.findByRole('status')).textContent).toBe(
			'The sandbox is unavailable: the kata-clh runtime is not registered'
		);
	});

	it('says so when the status cannot be read', async () => {
		sandboxStatus = () => new Response(JSON.stringify({ detail: 'nope' }), { status: 500 });
		await renderSandbox();
		expect((await screen.findByRole('status')).textContent).toBe('Could not check the sandbox.');
	});

	it('saves the settings as numbers, and a cleared one as null', async () => {
		await renderSandbox();
		fireEvent.change(screen.getByLabelText('Sandbox Maximum Running'), { target: { value: '8' } });
		fireEvent.change(screen.getByLabelText('Sandbox Idle Minutes'), { target: { value: '' } });
		fireEvent.change(screen.getByLabelText('Sandbox Default Image'), { target: { value: 'web' } });
		save();
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({
			CODE_INTERPRETER_ENGINE: 'sandbox',
			CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE: 'web',
			CODE_INTERPRETER_SANDBOX_TIMEOUT: 60,
			CODE_INTERPRETER_SANDBOX_MAX_RUNNING: 8,
			CODE_INTERPRETER_SANDBOX_IDLE_MINUTES: null,
			CODE_INTERPRETER_SANDBOX_RETENTION_DAYS: 7
		});
	});
});
