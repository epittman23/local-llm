import { QueryProvider } from '@/lib/query/QueryProvider';
import { fireEvent, render, screen, waitFor } from '../../../../../apps/web/node_modules/@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeExecution from '@/routes/admin/settings/CodeExecution';
import { useAuthStore } from '@/lib/stores/authStore';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: (m: unknown) => toastError(m), success: vi.fn(), info: vi.fn() }) }));

const config = {
	ENABLE_CODE_EXECUTION: true,
	CODE_EXECUTION_ENGINE: 'jupyter',
	CODE_EXECUTION_JUPYTER_URL: 'http://j',
	CODE_EXECUTION_JUPYTER_AUTH: '',
	CODE_EXECUTION_JUPYTER_AUTH_TOKEN: '',
	CODE_EXECUTION_JUPYTER_AUTH_PASSWORD: '',
	CODE_EXECUTION_JUPYTER_TIMEOUT: 60,
	ENABLE_CODE_INTERPRETER: false,
	CODE_INTERPRETER_ENGINE: 'pyodide',
	CODE_INTERPRETER_PROMPT_TEMPLATE: '',
	CODE_INTERPRETER_JUPYTER_URL: '',
	CODE_INTERPRETER_JUPYTER_AUTH: '',
	CODE_INTERPRETER_JUPYTER_AUTH_TOKEN: '',
	CODE_INTERPRETER_JUPYTER_AUTH_PASSWORD: '',
	CODE_INTERPRETER_JUPYTER_TIMEOUT: 60
};

afterEach(() => vi.restoreAllMocks());

describe('CodeExecution: clearing the Jupyter timeout', () => {
	it('sends "" (not null) and a 422 detail array is toasted as [object Object]', async () => {
		useAuthStore.setState({ token: 't' } as never);
		const posted: unknown[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			if (init?.method === 'POST') {
				posted.push(JSON.parse(String(init.body)));
				// What FastAPI answers for CODE_EXECUTION_JUPYTER_TIMEOUT: "" (int | None)
				return new Response(
					JSON.stringify({
						detail: [
							{
								type: 'int_parsing',
								loc: ['body', 'CODE_EXECUTION_JUPYTER_TIMEOUT'],
								msg: 'Input should be a valid integer, unable to parse string as an integer',
								input: ''
							}
						]
					}),
					{ status: 422 }
				);
			}
			return new Response(JSON.stringify(config), { status: 200 });
		});
		render(
			<QueryProvider>
				<CodeExecution />
			</QueryProvider>
		);
		const timeout = await screen.findByPlaceholderText('e.g. 60');
		fireEvent.change(timeout, { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: /save/i }));
		await waitFor(() => expect(posted.length).toBe(1));
		console.log('POSTED TIMEOUT =', JSON.stringify((posted[0] as Record<string, unknown>).CODE_EXECUTION_JUPYTER_TIMEOUT));
		expect((posted[0] as Record<string, unknown>).CODE_EXECUTION_JUPYTER_TIMEOUT).toBe('');
		// What the tab's catch does with what the API helper throws: toast.error(`${error}`)
		const { setCodeExecutionConfig } = await import('@/lib/apis/configs');
		const thrown = await setCodeExecutionConfig('t', {}).then(() => 'resolved', (e) => e);
		console.log('TOAST TEXT =', `${thrown}`);
		expect(`${thrown}`).toBe('[object Object]');
	});
});
