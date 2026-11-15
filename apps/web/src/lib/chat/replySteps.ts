import { getMessageText, getReasoningText, getToolResultText, type OutputItem } from './structuredOutput';

/**
 * A reply's `output` as it happened, for showing inline: the text the model
 * wrote, and between those texts the steps it took (thinking, tool calls with
 * what they were given and what came back). Every step has a one-line title
 * that says what it did, so the run can be followed without opening anything.
 */

export type StepStatus = 'running' | 'done' | 'failed' | 'waiting' | 'denied' | 'unanswered';
export type StepKind = 'reasoning' | 'command' | 'file' | 'search' | 'question' | 'code' | 'tool';

/** What a tool call returned, parsed from the JSON the sandbox tools answer with. */
export type StepResult =
	| { type: 'command'; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }
	| { type: 'error'; message: string }
	| { type: 'text'; text: string; language: string }
	| { type: 'none' };

export type Step = {
	id: string;
	kind: StepKind;
	name: string;
	title: string;
	/** A short fact after the title: "11 s", "exit 1". */
	meta?: string;
	status: StepStatus;
	/** The reasoning text, for a thinking step. */
	reasoning?: string;
	/** What the tool was given, as Markdown (fenced code), ready to render. */
	input?: string;
	result: StepResult;
	/** Images a tool returned (the sandbox's `view` of a PNG), as data URIs. */
	images: string[];
	/** The call id, for a tool call that can be approved or denied. */
	callId?: string;
};

export type ReplySegment = { type: 'text'; id: string; text: string } | { type: 'steps'; id: string; steps: Step[] };

const STEP_TYPES = new Set([
	'reasoning',
	'function_call',
	'open_webui:code_interpreter',
	'web_search_call',
	'file_search_call',
	'computer_call'
]);

/** A fenced block that no backtick run inside `text` can close early. */
export function fence(text: string, language = ''): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const ticks = '`'.repeat(Math.max(3, longest + 1));
	return `${ticks}${language}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

function parseArguments(raw: unknown): Record<string, unknown> {
	let value = raw;
	while (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			break;
		}
	}
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';
const clip = (text: string, n = 120) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

const EXTENSION_LANGUAGES: Record<string, string> = {
	py: 'python',
	js: 'javascript',
	ts: 'typescript',
	tsx: 'tsx',
	json: 'json',
	md: 'markdown',
	tex: 'latex',
	sh: 'bash',
	html: 'html',
	css: 'css',
	csv: 'csv',
	yaml: 'yaml',
	yml: 'yaml',
	toml: 'toml',
	sql: 'sql',
	r: 'r'
};
const languageOf = (path: string) => EXTENSION_LANGUAGES[path.split('.').pop()?.toLowerCase() ?? ''] ?? '';

/** "search_chats" → "Search chats". */
const humanize = (name: string) => {
	const words = name.replace(/[_-]+/g, ' ').trim();
	return words ? words[0].toUpperCase() + words.slice(1) : 'Tool';
};

/** Seconds a thinking step took: its own duration, else from its timestamps; null when unknown. */
export function reasoningSeconds(item: OutputItem): number | null {
	const duration = Number(item.duration);
	if (Number.isFinite(duration) && duration > 0) return Math.round(duration);
	const start = Number(item.started_at);
	const end = Number(item.ended_at);
	if (Number.isFinite(start) && Number.isFinite(end) && end >= start && item.ended_at != null) {
		return Math.max(1, Math.round(end - start));
	}
	return null;
}

export function parseResult(text: string): StepResult {
	if (!text.trim()) return { type: 'none' };
	const parsed = parseArguments(text);
	if (Object.keys(parsed).length) {
		if ('returncode' in parsed || 'stdout' in parsed || 'stderr' in parsed) {
			const code = parsed.returncode;
			return {
				type: 'command',
				exitCode: typeof code === 'number' ? code : null,
				stdout: str(parsed.stdout),
				stderr: str(parsed.stderr),
				timedOut: parsed.timed_out === true,
				truncated: parsed.truncated === true
			};
		}
		if (typeof parsed.error === 'string' && Object.keys(parsed).length <= 2) {
			return { type: 'error', message: parsed.error };
		}
		if (typeof parsed.content === 'string') {
			return { type: 'text', text: parsed.content, language: languageOf(str(parsed.path)) || 'text' };
		}
		if (typeof parsed.context === 'string') return { type: 'text', text: parsed.context, language: 'text' };
		return { type: 'text', text: JSON.stringify(parsed, null, 2), language: 'json' };
	}
	if (/^error\b/i.test(text.trim())) return { type: 'error', message: text.trim().replace(/^error:\s*/i, '') };
	return { type: 'text', text, language: 'text' };
}

function describeCall(name: string, args: Record<string, unknown>): Pick<Step, 'kind' | 'title' | 'input'> {
	const path = str(args.path);
	switch (name) {
		case 'bash': {
			const command = str(args.command);
			return { kind: 'command', title: clip(firstLine(command)) || 'Command', input: fence(command, 'bash') };
		}
		case 'write_file':
			return {
				kind: 'file',
				title: `Wrote ${path || 'a file'}`,
				input: fence(str(args.content), languageOf(path))
			};
		case 'str_replace':
			return {
				kind: 'file',
				title: `Edited ${path || 'a file'}`,
				input: `Replaced\n\n${fence(str(args.old_str), languageOf(path))}\n\nwith\n\n${fence(str(args.new_str), languageOf(path))}`
			};
		case 'view': {
			const range = args.start_line ? ` (lines ${args.start_line}${args.end_line ? `–${args.end_line}` : ' on'})` : '';
			return { kind: 'file', title: `Viewed ${path || 'a file'}${range}` };
		}
		case 'search_web':
			return { kind: 'search', title: `Searched the web for "${clip(str(args.query), 80)}"` };
		case 'fetch_url':
			return { kind: 'search', title: `Read ${clip(str(args.url), 100)}` };
		case 'ask_user': {
			const questions = Array.isArray(args.questions) ? (args.questions as Record<string, unknown>[]) : [];
			const asked = questions.map((q) => str(q.header) || str(q.question)).filter(Boolean);
			return {
				kind: 'question',
				title: asked.length ? `Asked: ${clip(asked.join(' · '), 100)}` : 'Asked a question',
				input: questions.map((q) => `- ${str(q.question)}`).join('\n')
			};
		}
		default: {
			// The first short text argument says what the call was about (a query, a path, an id).
			const subject = Object.values(args).find((v): v is string => typeof v === 'string' && v.length <= 120);
			const rest = Object.keys(args).length ? fence(JSON.stringify(args, null, 2), 'json') : undefined;
			return { kind: 'tool', title: subject ? `${humanize(name)}: ${clip(subject, 80)}` : humanize(name), input: rest };
		}
	}
}

function toolStep(item: OutputItem, result: OutputItem | undefined, replyDone: boolean, movedOn: boolean): Step {
	const name = item.name ?? '';
	const args = parseArguments(item.arguments);
	const { kind, title, input } = describeCall(name, args);
	const parsed = parseResult(getToolResultText(result));
	const images = (result?.output ?? [])
		.filter((p) => p?.type === 'input_image' && typeof p.image_url === 'string')
		.map((p) => p.image_url as string);
	const callStatus = String(item.status ?? '');
	let status: StepStatus;
	if (callStatus === 'rejected' || result?.status === 'rejected') status = 'denied';
	else if (result) status = parsed.type === 'error' || callStatus === 'failed' ? 'failed' : 'done';
	// A call still marked pending in a reply that went on past it was never answered.
	else if (['pending', 'queued', 'requires_approval'].includes(callStatus)) status = movedOn ? 'unanswered' : 'waiting';
	else if (callStatus === 'failed' || callStatus === 'incomplete') status = 'failed';
	else status = replyDone ? 'unanswered' : 'running';
	// An answered question: the answer is the result, as the person gave it.
	if (name === 'ask_user' && result && parsed.type === 'text') {
		const answer = parseArguments(parsed.text);
		if (answer.status === 'cancelled' || answer.timed_out) status = 'unanswered';
	}
	const meta =
		parsed.type === 'command' && parsed.exitCode !== null && parsed.exitCode !== 0
			? `exit ${parsed.exitCode}`
			: parsed.type === 'command' && parsed.timedOut
				? 'timed out'
				: undefined;
	// While a call's arguments are still streaming in there is nothing to name yet.
	const preparing = status === 'running' && !Object.keys(args).length;
	return {
		id: item.id ?? item.call_id ?? '',
		kind,
		name,
		title: preparing ? `Preparing ${name === 'bash' ? 'a command' : humanize(name).toLowerCase()}` : title,
		meta,
		status,
		input,
		result: parsed,
		images,
		callId: item.call_id ?? item.id
	};
}

function otherStep(item: OutputItem, isLast: boolean, replyDone: boolean): Step {
	const finished = ['completed', 'failed', 'incomplete'].includes(String(item.status)) || !isLast || replyDone;
	const status: StepStatus = finished ? (item.status === 'failed' ? 'failed' : 'done') : 'running';
	if (item.type === 'reasoning') {
		const seconds = reasoningSeconds(item);
		return {
			id: item.id ?? '',
			kind: 'reasoning',
			name: 'reasoning',
			title: status === 'running' ? 'Thinking' : 'Thought',
			meta: status === 'running' || seconds === null ? undefined : `${seconds} s`,
			status,
			reasoning: getReasoningText(item),
			result: { type: 'none' },
			images: []
		};
	}
	if (item.type === 'open_webui:code_interpreter') {
		const code = str(item.code);
		const output = item.output as unknown;
		return {
			id: item.id ?? '',
			kind: 'code',
			name: 'code_interpreter',
			title: status === 'running' ? 'Running code' : 'Ran code',
			status,
			input: code ? fence(code, str(item.lang) || 'python') : undefined,
			result:
				typeof output === 'string' && output
					? { type: 'text', text: output, language: 'text' }
					: output && typeof output === 'object'
						? { type: 'text', text: JSON.stringify(output, null, 2), language: 'json' }
						: { type: 'none' },
			images: []
		};
	}
	const action = (item.action ?? {}) as Record<string, unknown>;
	const queries = [...(Array.isArray(action.queries) ? action.queries : []), action.query, ...(item.queries ?? [])]
		.filter((q): q is string => typeof q === 'string' && q !== '')
		.join(', ');
	const label =
		item.type === 'web_search_call'
			? 'Searched the web'
			: item.type === 'file_search_call'
				? 'Searched files'
				: 'Used the computer';
	return {
		id: item.id ?? '',
		kind: item.type === 'computer_call' ? 'tool' : 'search',
		name: item.type ?? 'tool',
		title: queries ? `${label} for "${clip(queries, 80)}"` : label,
		status,
		result: { type: 'none' },
		images: []
	};
}

/** The reply's output, in order: its texts, and the runs of steps between them. */
export function replySegments(output: OutputItem[] = [], replyDone = true): ReplySegment[] {
	const results: Record<string, OutputItem> = {};
	for (const item of output) if (item?.type === 'function_call_output' && item.call_id) results[item.call_id] = item;

	const segments: ReplySegment[] = [];
	let run: Step[] = [];
	const flush = () => {
		if (run.length) segments.push({ type: 'steps', id: `steps-${segments.length}`, steps: run });
		run = [];
	};
	const lastStepOrText = output.findLastIndex((item) => item && item.type !== 'function_call_output');
	output.forEach((item, index) => {
		if (!item || item.type === 'function_call_output') return;
		const isLast = index === output.length - 1;
		if (item.type === 'function_call') {
			run.push(toolStep(item, results[item.call_id ?? item.id ?? ''], replyDone, index < lastStepOrText));
		} else if (STEP_TYPES.has(item.type ?? '')) {
			run.push(otherStep(item, isLast, replyDone));
		} else {
			const text = getMessageText(item);
			if (!text.trim()) return;
			flush();
			segments.push({ type: 'text', id: item.id ?? `text-${index}`, text });
		}
	});
	flush();
	return segments;
}
