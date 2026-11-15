import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputItem } from '@/lib/chat/structuredOutput';
import { ReplySteps } from './ReplySteps';

const resolveChatMessageToolCall = vi.fn();
vi.mock('@/lib/apis/chats', () => ({
	resolveChatMessageToolCall: (...a: unknown[]) => resolveChatMessageToolCall(...a)
}));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1', name: 'Test User' } })
}));

const output: OutputItem[] = [
	{
		type: 'reasoning',
		id: 'r1',
		status: 'completed',
		duration: 3,
		content: [{ type: 'output_text', text: 'List the uploads.' }]
	},
	{
		type: 'message',
		id: 'm1',
		role: 'assistant',
		content: [{ type: 'output_text', text: 'Let me look at the file.' }]
	},
	{
		type: 'function_call',
		id: 'c1',
		call_id: 'c1',
		name: 'bash',
		arguments: JSON.stringify({ command: 'ls /workspace/uploads' }),
		status: 'completed'
	},
	{
		type: 'function_call_output',
		call_id: 'c1',
		output: [{ type: 'input_text', text: JSON.stringify({ returncode: 0, stdout: 'HW9.docx\n', stderr: '' }) }]
	},
	{ type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'Found it.' }] }
];

beforeEach(() => resolveChatMessageToolCall.mockReset().mockResolvedValue({}));
afterEach(cleanup);

describe('ReplySteps', () => {
	it('shows the texts and, between them, one line per step', () => {
		render(<ReplySteps id="a1" output={output} done />);
		const root = screen.getByTestId('reply-steps');
		expect(root.textContent?.indexOf('Thought')).toBeLessThan(root.textContent?.indexOf('Let me look') ?? 0);
		expect(root.textContent?.indexOf('Let me look')).toBeLessThan(root.textContent?.indexOf('ls /workspace') ?? 0);
		expect(root.textContent?.indexOf('ls /workspace')).toBeLessThan(root.textContent?.indexOf('Found it.') ?? 0);
		const steps = screen.getAllByTestId('reply-step');
		expect(steps.map((s) => s.querySelector('button')?.textContent)).toEqual(['Thought3 s', 'ls /workspace/uploads']);
	});

	it('opens a step to show the command and its output, with the exit code', () => {
		render(<ReplySteps id="a1" output={output} done />);
		const row = screen.getAllByTestId('reply-step')[1];
		const toggle = within(row).getByRole('button', { name: /ls \/workspace\/uploads/ });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(row.textContent).toContain('Exit code 0');
		expect(row.textContent).toContain('HW9.docx');
	});

	it('shows the running step while the reply is written', () => {
		const live: OutputItem[] = [
			output[1],
			{
				type: 'function_call',
				id: 'c2',
				call_id: 'c2',
				name: 'bash',
				arguments: '{"command":"sleep 5"}',
				status: 'in_progress'
			}
		];
		render(<ReplySteps id="a1" output={live} done={false} />);
		const row = screen.getByTestId('reply-step');
		expect(row.dataset.status).toBe('running');
		expect(within(row).getByText('Running')).toBeTruthy();
	});

	it('asks to allow a call that waits for approval, and resolves it', async () => {
		const onResolved = vi.fn();
		const waiting: OutputItem[] = [
			{
				type: 'function_call',
				id: 'c3',
				call_id: 'c3',
				name: 'bash',
				arguments: '{"command":"rm x"}',
				status: 'pending'
			}
		];
		render(
			<ReplySteps
				id="a1"
				output={waiting}
				done
				chatId="chat-1"
				messageId="a1"
				resolvable
				onToolCallResolved={onResolved}
			/>
		);
		expect(screen.getByText('Waiting for approval')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
		await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
		expect(resolveChatMessageToolCall).toHaveBeenCalledWith('t', 'chat-1', 'a1', 'c3', 'reject');
	});

	it('offers no Allow for a question, which is answered in its own dialog', () => {
		const ask: OutputItem[] = [
			{
				type: 'function_call',
				id: 'q',
				call_id: 'q',
				name: 'ask_user',
				arguments: JSON.stringify({ questions: [{ id: 'a', header: 'Layout', question: 'Which?' }] }),
				status: 'pending'
			}
		];
		render(<ReplySteps id="a1" output={ask} done chatId="chat-1" messageId="a1" resolvable />);
		expect(screen.getByText('Waiting for your answer')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
	});

	it('strips citations from texts when asked, and shows plain text with Markdown off', () => {
		render(<ReplySteps id="a1" output={[output[1]]} done plain formatText={(t) => t.replace('file', 'FILE')} />);
		expect(screen.getByText('Let me look at the FILE.')).toBeTruthy();
		expect(screen.queryByTestId('markdown')).toBeNull();
	});
});
