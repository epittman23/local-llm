import { describe, expect, it } from 'vitest';
import {
	currentStep,
	fence,
	parseResult,
	reasoningSeconds,
	replyActivity,
	replySegments,
	type Step
} from './replySteps';
import type { OutputItem } from './structuredOutput';

const text = (id: string, t: string): OutputItem => ({
	type: 'message',
	id,
	role: 'assistant',
	content: [{ type: 'output_text', text: t }]
});
const call = (id: string, name: string, args: unknown, extra: Partial<OutputItem> = {}): OutputItem => ({
	type: 'function_call',
	id,
	call_id: id,
	name,
	arguments: JSON.stringify(args),
	status: 'completed',
	...extra
});
const result = (id: string, body: unknown, extra: Partial<OutputItem> = {}): OutputItem => ({
	type: 'function_call_output',
	id: `fco_${id}`,
	call_id: id,
	output: [{ type: 'input_text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
	status: 'completed',
	...extra
});
const reasoning = (id: string, t: string, extra: Partial<OutputItem> = {}): OutputItem => ({
	type: 'reasoning',
	id,
	status: 'completed',
	content: [{ type: 'output_text', text: t }],
	...extra
});
const steps = (output: OutputItem[], done = true): Step[] =>
	replySegments(output, done).flatMap((s) => (s.type === 'steps' ? s.steps : []));

describe('replySegments', () => {
	it('keeps the order: texts, and the runs of steps between them', () => {
		const segments = replySegments([
			reasoning('r1', 'Look first.'),
			text('m1', 'Let me look.'),
			call('c1', 'bash', { command: 'ls' }),
			result('c1', { returncode: 0, stdout: 'a\n', stderr: '' }),
			call('c2', 'view', { path: '/workspace/a.txt' }),
			result('c2', { path: '/workspace/a.txt', content: 'hi' }),
			text('m2', 'Done.')
		]);
		expect(segments.map((s) => (s.type === 'text' ? s.text : s.steps.map((x) => x.title)))).toEqual([
			['Thought'],
			'Let me look.',
			['ls', 'Viewed /workspace/a.txt'],
			'Done.'
		]);
	});

	it('titles each kind of call by what it did', () => {
		const titles = steps([
			call('a', 'bash', { command: 'cd /x && latexmk doc.tex\necho done' }),
			call('b', 'write_file', { path: '/w/doc.tex', content: 'x' }),
			call('c', 'str_replace', { path: '/w/doc.tex', old_str: 'a', new_str: 'b' }),
			call('d', 'view', { path: '/w/doc.tex', start_line: 10, end_line: 20 }),
			call('e', 'search_web', { query: 'polymer repeat units' }),
			call('f', 'search_chats', { query: 'latex' }),
			call('g', 'get_current_timestamp', {})
		]).map((s) => s.title);
		expect(titles).toEqual([
			'cd /x && latexmk doc.tex',
			'Wrote /w/doc.tex',
			'Edited /w/doc.tex',
			'Viewed /w/doc.tex (lines 10–20)',
			'Searched the web for "polymer repeat units"',
			'Search chats: latex',
			'Get current timestamp'
		]);
	});

	it('gives the command, the file written and the edit as fenced input', () => {
		const [bash, write, edit] = steps([
			call('a', 'bash', { command: 'echo ```' }),
			call('b', 'write_file', { path: '/w/a.py', content: 'print(1)' }),
			call('c', 'str_replace', { path: '/w/a.py', old_str: 'print(1)', new_str: 'print(2)' })
		]);
		expect(bash.input).toBe('````bash\necho ```\n````');
		expect(write.input).toBe('```python\nprint(1)\n```');
		expect(edit.input).toContain('```python\nprint(1)\n```');
		expect(edit.input).toContain('```python\nprint(2)\n```');
	});

	it('says how long a thought took, from its timestamps when its duration is 0', () => {
		const [a, b, c] = steps([
			reasoning('a', 'x', { duration: 0, started_at: 100.2, ended_at: 111.6 }),
			reasoning('b', 'y', { duration: 4 }),
			reasoning('c', 'z', { duration: 0, started_at: 100, ended_at: null })
		]);
		expect([a.meta, b.meta, c.meta]).toEqual(['11 s', '4 s', undefined]);
	});

	it('marks the running step while the reply is written, and nothing running once it is done', () => {
		const live = [text('m', 'Checking.'), call('c1', 'bash', { command: 'sleep 5' }, { status: 'in_progress' })];
		expect(steps(live, false)[0].status).toBe('running');
		expect(steps(live, true)[0].status).toBe('unanswered');
		const streaming = [call('c3', 'bash', {}, { arguments: '', status: 'in_progress' })];
		expect(steps(streaming, false)[0].title).toBe('Preparing a command');
		expect(steps([reasoning('r', 'hm', { status: 'in_progress' })], false)[0]).toMatchObject({
			status: 'running',
			title: 'Thinking'
		});
	});

	it('tells a call waiting for approval or an answer from one the reply went on past', () => {
		const ask = call(
			'q',
			'ask_user',
			{ questions: [{ id: 'a', header: 'Layout', question: 'Which?' }] },
			{ status: 'pending' }
		);
		expect(steps([ask])[0]).toMatchObject({ status: 'waiting', title: 'Asked: Layout' });
		expect(steps([ask, text('m', 'Going ahead.')])[0].status).toBe('unanswered');
		expect(steps([call('t', 'bash', { command: 'rm x' }, { status: 'pending' })])[0].status).toBe('waiting');
	});

	it('asks only about the call a paused round waits on, and lets an approved one run', () => {
		// pause_for_tool_approval: the first unresolved call is pending, the rest queued.
		const round = steps([
			text('m', 'Two commands.'),
			call('a', 'bash', { command: 'rm a' }, { status: 'pending' }),
			call('b', 'bash', { command: 'rm b' }, { status: 'queued' })
		]);
		expect(round.map((s) => [s.status, s.approvable])).toEqual([
			['waiting', true],
			['queued', false]
		]);
		const approved = steps([call('a', 'bash', { command: 'rm a' }, { status: 'queued', approved: true })], false);
		expect(approved[0]).toMatchObject({ status: 'running', approvable: false });
		const question = steps([call('q', 'ask_user', { questions: [] }, { status: 'pending' })]);
		expect(question[0]).toMatchObject({ status: 'waiting', approvable: false });
	});

	it("shows the code interpreter's output and errors apart", () => {
		const [code] = steps([
			{
				type: 'open_webui:code_interpreter',
				id: 'ci',
				status: 'completed',
				code: 'print(1)',
				// The sandbox's {stdout, stderr, result}, where the type expects content parts.
				output: { stdout: '1\n', stderr: 'warn\n', result: '' }
			} as unknown as OutputItem
		]);
		expect(code).toMatchObject({ title: 'Ran code', input: '```python\nprint(1)\n```' });
		expect(code.result).toMatchObject({ type: 'command', stdout: '1\n', stderr: 'warn\n' });
	});

	it('shows a denied call and a failed one', () => {
		const [denied, failed] = steps([
			call('d', 'bash', { command: 'rm x' }, { status: 'rejected' }),
			result('d', 'Error: tool call rejected by user.', { status: 'rejected' }),
			call('f', 'write_file', { path: '/w/a', content: '' }),
			result('f', { error: '/w/a already exists; pass overwrite=true to replace it' })
		]);
		expect(denied.status).toBe('denied');
		expect(failed).toMatchObject({ status: 'failed', result: { type: 'error' } });
	});

	it('keeps the images a tool returned, not as text', () => {
		const [view] = steps([
			call('v', 'view', { path: '/w/sheet.png' }),
			{
				type: 'function_call_output',
				call_id: 'v',
				output: [
					{ type: 'input_text', text: 'view: Image file read successfully.' },
					{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
					{ type: 'input_image', image_url: 'https://tracker.example/pixel.png' }
				]
			}
		]);
		expect(view.images).toEqual(['data:image/png;base64,AAAA']);
		expect(view.result).toEqual({ type: 'text', text: 'view: Image file read successfully.', language: 'text' });
	});

	it('marks a non-zero exit after the title', () => {
		const [s] = steps([
			call('a', 'bash', { command: 'grep x y' }),
			result('a', { returncode: 1, stdout: '', stderr: '' })
		]);
		expect(s.meta).toBe('exit 1');
		expect(s.status).toBe('done');
	});
});

describe('parseResult', () => {
	it('reads a command result', () => {
		expect(parseResult(JSON.stringify({ returncode: 2, stdout: 'o', stderr: 'e', timed_out: true }))).toEqual({
			type: 'command',
			exitCode: 2,
			stdout: 'o',
			stderr: 'e',
			timedOut: true,
			truncated: false
		});
	});
	it('reads a file view with its language, an error, plain text and other JSON', () => {
		expect(parseResult(JSON.stringify({ path: '/a.tex', content: '\\x' }))).toEqual({
			type: 'text',
			text: '\\x',
			language: 'latex'
		});
		expect(parseResult(JSON.stringify({ error: 'nope' }))).toEqual({ type: 'error', message: 'nope' });
		expect(parseResult('Error: tool call rejected by user.')).toEqual({
			type: 'error',
			message: 'tool call rejected by user.'
		});
		expect(parseResult('plain')).toEqual({ type: 'text', text: 'plain', language: 'text' });
		expect(parseResult('{"path":"/a","bytes_written":3}')).toMatchObject({ type: 'text', language: 'json' });
		expect(parseResult('')).toEqual({ type: 'none' });
	});
});

describe('reasoningSeconds', () => {
	it('is null when neither a duration nor both timestamps are known', () => {
		expect(reasoningSeconds({ duration: 0 })).toBeNull();
		expect(reasoningSeconds({ started_at: 5 })).toBeNull();
		expect(reasoningSeconds({ started_at: 5, ended_at: 5.2 })).toBe(1);
	});
});

describe('fence', () => {
	it('outgrows any backtick run inside', () => {
		expect(fence('a\n', 'x')).toBe('```x\na\n```');
		expect(fence('````', '')).toBe('`````\n````\n`````');
	});
});

describe('currentStep', () => {
	it('is the running step, else one waiting on the person, else the last', () => {
		const [a, b, c] = steps(
			[
				call('a', 'bash', { command: 'a' }),
				result('a', 'ok'),
				call('b', 'bash', { command: 'b' }),
				call('c', 'view', { path: '/c' })
			],
			false
		);
		expect(currentStep([a, b, c]).title).toBe('b');
		const waiting = steps([call('w', 'bash', { command: 'w' }, { status: 'pending' })]);
		expect(currentStep([a, ...waiting]).title).toBe('w');
		expect(currentStep([a]).title).toBe('a');
	});
});

describe('replyActivity', () => {
	it('says what a reply being written is doing', () => {
		expect(replyActivity([])).toBe('starting');
		expect(replyActivity([text('m', 'Hel')])).toBe('writing');
		expect(replyActivity([reasoning('r', 'hm', { status: 'in_progress' })])).toBe('reasoning');
		expect(replyActivity([call('a', 'bash', { command: 'ls' }, { status: 'in_progress' })])).toBe('command');
		expect(replyActivity([call('a', 'bash', { command: 'ls' }), result('a', 'ok')])).toBe('between');
	});
	it('is null while the reply waits on the person', () => {
		expect(replyActivity([call('a', 'bash', { command: 'rm' }, { status: 'pending' })])).toBeNull();
		expect(replyActivity([call('q', 'ask_user', { questions: [] }, { status: 'pending' })])).toBeNull();
	});
});
