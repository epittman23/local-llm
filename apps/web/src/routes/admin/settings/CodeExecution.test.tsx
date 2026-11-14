import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import CodeExecution from './CodeExecution';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn(), info: vi.fn() })
}));

// What GET /configs/code_execution returns: both sections on, with the six
// sandbox settings the server stores.
const CONFIG = {
	ENABLE_CODE_EXECUTION: true,
	CODE_EXECUTION_ENGINE: 'sandbox',
	ENABLE_CODE_INTERPRETER: true,
	CODE_INTERPRETER_ENGINE: 'sandbox',
	CODE_INTERPRETER_PROMPT_TEMPLATE: '',
	CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE: 'data',
	CODE_INTERPRETER_SANDBOX_TIMEOUT: 60,
	CODE_INTERPRETER_SANDBOX_MAX_RUNNING: 4,
	CODE_INTERPRETER_SANDBOX_IDLE_MINUTES: 30,
	CODE_INTERPRETER_SANDBOX_RETENTION_DAYS: 7,
	CODE_INTERPRETER_SANDBOX_MAX_WORKSPACES: 20
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

const renderSandbox = async (config: Record<string, unknown> = CONFIG) => {
	served = config;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<CodeExecution />
		</QueryClientProvider>
	);
	await screen.findByLabelText('Sandbox Maximum Running');
};

const save = () => fireEvent.click(screen.getByRole('button', { name: /save/i }));

describe('CodeExecution: a cleared sandbox timeout', () => {
	it('is sent as null, which the int | None field accepts', async () => {
		await renderSandbox();
		fireEvent.change(screen.getByLabelText('Sandbox Command Timeout'), { target: { value: '' } });
		save();
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0].CODE_INTERPRETER_SANDBOX_TIMEOUT).toBeNull();
	});

	it('still sends a typed timeout as a number', async () => {
		await renderSandbox();
		fireEvent.change(screen.getByLabelText('Sandbox Command Timeout'), { target: { value: '90' } });
		save();
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0].CODE_INTERPRETER_SANDBOX_TIMEOUT).toBe(90);
	});
});

describe('CodeExecution: a rejected save', () => {
	it("toasts the server's validation message, not [object Object]", async () => {
		const msg = 'Input should be a valid integer, unable to parse string as an integer';
		answer = () =>
			new Response(
				JSON.stringify({
					detail: [{ type: 'int_parsing', loc: ['body', 'CODE_INTERPRETER_SANDBOX_TIMEOUT'], msg, input: '' }]
				}),
				{ status: 422 }
			);
		await renderSandbox();
		save();
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError).toHaveBeenCalledWith(`CODE_INTERPRETER_SANDBOX_TIMEOUT: ${msg}`);
	});
});

const section = (name: string) => screen.getByRole('region', { name });

describe('CodeExecution: the sandbox, the only engine', () => {
	it('shows no engine select and no Jupyter field', async () => {
		await renderSandbox();
		expect(screen.queryByLabelText('Code Execution Engine')).toBeNull();
		expect(screen.queryByLabelText('Code Interpreter Engine')).toBeNull();
		expect(screen.queryByText(/jupyter/i)).toBeNull();
		expect(screen.queryByPlaceholderText(/jupyter/i)).toBeNull();
	});

	it('shows the six sandbox fields once, with the memory note', async () => {
		await renderSandbox();
		expect(screen.getAllByLabelText('Sandbox Default Image')).toHaveLength(1);
		expect(screen.getByLabelText('Sandbox Command Timeout')).toHaveValue(60);
		expect(screen.getByLabelText('Sandbox Maximum Running')).toHaveValue(4);
		expect(screen.getByLabelText('Sandbox Idle Minutes')).toHaveValue(30);
		expect(screen.getByLabelText('Sandbox Retention Days')).toHaveValue(7);
		expect(screen.getByLabelText('Sandbox Workspaces per User')).toHaveValue(20);
		expect(screen.getByText(/4 GiB of memory and 2 CPUs, so 16 at once is 64 GiB/)).toBeTruthy();
	});

	it('shows them under Code Interpreter, not Code Execution, when the interpreter is enabled', async () => {
		await renderSandbox();
		expect(within(section('Code Interpreter')).getByLabelText('Sandbox Maximum Running')).toBeTruthy();
		expect(within(section('Code Execution')).queryByLabelText('Sandbox Maximum Running')).toBeNull();
	});

	it('shows them under Code Execution when the interpreter is off but code execution is on', async () => {
		await renderSandbox({ ...CONFIG, ENABLE_CODE_INTERPRETER: false });
		expect(within(section('Code Execution')).getByLabelText('Sandbox Maximum Running')).toBeTruthy();
		expect(within(section('Code Interpreter')).queryByLabelText('Sandbox Maximum Running')).toBeNull();
		expect(screen.queryByText('Code Interpreter Prompt Template')).toBeNull();
	});

	it('shows none of them when code execution is off and the interpreter is off', async () => {
		served = { ...CONFIG, ENABLE_CODE_EXECUTION: false, ENABLE_CODE_INTERPRETER: false };
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<CodeExecution />
			</QueryClientProvider>
		);
		await screen.findByRole('switch', { name: 'Enable Code Execution' });
		expect(screen.queryByLabelText('Sandbox Maximum Running')).toBeNull();
	});

	it.each(['jupyter', 'pyodide'])(
		'renders a stored legacy engine %s and saves sandbox for both engines',
		async (legacy) => {
			await renderSandbox({ ...CONFIG, CODE_EXECUTION_ENGINE: legacy, CODE_INTERPRETER_ENGINE: legacy });
			expect(screen.queryByLabelText('Code Interpreter Engine')).toBeNull();
			save();
			await waitFor(() => expect(posted).toHaveLength(1));
			expect(posted[0]).toMatchObject({ CODE_EXECUTION_ENGINE: 'sandbox', CODE_INTERPRETER_ENGINE: 'sandbox' });
		}
	);

	it('shows the default image when none is stored, and no reason when none is given', async () => {
		sandboxStatus = () => new Response(JSON.stringify({ ready: false, reason: null }), { status: 200 });
		await renderSandbox({ ...CONFIG, CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE: null });
		expect(screen.getByLabelText('Sandbox Default Image')).toHaveValue('data');
		expect((await screen.findByRole('status')).textContent).toBe('The sandbox is unavailable: no reason given');
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
		fireEvent.change(screen.getByLabelText('Sandbox Workspaces per User'), { target: { value: '5' } });
		save();
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({
			CODE_EXECUTION_ENGINE: 'sandbox',
			CODE_INTERPRETER_ENGINE: 'sandbox',
			CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE: 'web',
			CODE_INTERPRETER_SANDBOX_TIMEOUT: 60,
			CODE_INTERPRETER_SANDBOX_MAX_RUNNING: 8,
			CODE_INTERPRETER_SANDBOX_IDLE_MINUTES: null,
			CODE_INTERPRETER_SANDBOX_RETENTION_DAYS: 7,
			CODE_INTERPRETER_SANDBOX_MAX_WORKSPACES: 5
		});
	});
});
