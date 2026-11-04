import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MODELFILE,
	finishUpload,
	isNotableStatus,
	modelLabel,
	parseStreamLines,
	progressPercent,
	sanitizeModelTag,
	streamError,
	uploadedModelfile
} from './ollamaStreams';

describe('parseStreamLines', () => {
	it('parses each line and skips blanks', () => {
		expect(parseStreamLines('{"status":"a"}\n\n{"status":"b"}\n')).toEqual([{ status: 'a' }, { status: 'b' }]);
	});
	it('drops a server-sent-events prefix', () => {
		expect(parseStreamLines('data: {"progress":40}')).toEqual([{ progress: 40 }]);
	});
	it('throws on a line that is not JSON, so a caller can report it', () => {
		expect(() => parseStreamLines('oops')).toThrow();
	});
});

describe('progressPercent', () => {
	it('is the rounded share done, to one decimal', () => {
		expect(progressPercent({ completed: 1, total: 3 })).toBe(33.3);
		expect(progressPercent({ completed: 50, total: 200 })).toBe(25);
	});
	it('is 100 when there is nothing left to count', () => {
		expect(progressPercent({})).toBe(100);
		expect(progressPercent({ completed: 0, total: 10 })).toBe(100);
		expect(progressPercent({ completed: 5 })).toBe(100);
	});
});

describe('streamError', () => {
	it('reads the server error, then the proxy detail, as text', () => {
		expect(streamError({ error: 'boom' })).toBe('boom');
		expect(streamError({ detail: 'nope' })).toBe('nope');
		expect(streamError({ error: { code: 1 } })).toBe('{"code":1}');
	});
	it('is null for an ordinary message', () => {
		expect(streamError({ status: 'pulling manifest' })).toBeNull();
	});
});

describe('sanitizeModelTag', () => {
	it('strips a pasted ollama command and whitespace', () => {
		expect(sanitizeModelTag('  ollama run mistral:7b ')).toBe('mistral:7b');
		expect(sanitizeModelTag('ollama pull llama3')).toBe('llama3');
		expect(sanitizeModelTag('mistral:7b')).toBe('mistral:7b');
	});
});

describe('isNotableStatus', () => {
	it('shows plain milestones, not layer transfers or blob writes', () => {
		expect(isNotableStatus({ status: 'success' })).toBe(true);
		expect(isNotableStatus({ status: 'pulling abc', digest: 'sha256:abc' })).toBe(false);
		expect(isNotableStatus({ status: 'writing manifest' })).toBe(false);
		expect(isNotableStatus({ status: 'using existing sha256:abc' })).toBe(false);
		expect(isNotableStatus({})).toBe(false);
	});
});

describe('modelLabel', () => {
	it('shows the size in GB', () => {
		expect(modelLabel({ id: 'a', name: 'llama3:8b', size: 4.7 * 1024 ** 3 })).toBe('llama3:8b (4.7 GB)');
		expect(modelLabel({ id: 'a' })).toBe('a (0.0 GB)');
	});
});

describe('uploaded Modelfile', () => {
	it('starts FROM the uploaded blob', () => {
		expect(uploadedModelfile('sha256:abc', 'PARAMETER num_ctx 4096')).toBe('FROM @sha256:abc\nPARAMETER num_ctx 4096');
		expect(DEFAULT_MODELFILE).toContain('PARAMETER num_ctx 4096');
	});
});

describe('finishUpload (#250)', () => {
	const stream = (...events: object[]) =>
		new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });

	const steps = () => {
		const calls: string[] = [];
		return {
			calls,
			onProgress: (percent: number) => calls.push(`progress ${percent}`),
			onBlob: (digest: string) => calls.push(`blob ${digest}`),
			create: vi.fn(async (payload: Record<string, unknown>) => {
				calls.push(`create ${JSON.stringify(payload)}`);
				return new Response('{"status":"success"}\n', { status: 200 });
			}),
			followCreate: vi.fn(async () => {
				calls.push('follow');
			}),
			notify: {
				error: (message: string) => calls.push(`error ${message}`),
				success: (message: string) => calls.push(`success ${message}`)
			}
		};
	};

	it('does not create the model again when the server made it (file mode)', async () => {
		const s = steps();
		await finishUpload(
			stream({ progress: 50 }, { done: true, blob: 'sha256:abc', name: 'm.gguf', model_created: 'm' }),
			'PARAMETER x 1',
			s
		);

		expect(s.calls).toEqual(['progress 50', 'blob sha256:abc', 'success Model m created']);
		expect(s.create).not.toHaveBeenCalled();
	});

	it('creates the model from the stored blob after a URL download', async () => {
		const s = steps();
		await finishUpload(stream({ done: true, blob: 'sha256:abc', name: 'm.Q4.gguf' }), 'PARAMETER x 1', s);

		expect(s.create).toHaveBeenCalledWith({
			model: 'm.Q4',
			files: { 'm.Q4.gguf': 'sha256:abc' },
			modelfile: 'FROM @sha256:abc\nPARAMETER x 1'
		});
		expect(s.calls.at(-1)).toBe('follow');
	});

	it('shows an error the stream carries, and creates nothing', async () => {
		const s = steps();
		await finishUpload(stream({ progress: 10 }, { error: 'Ollama: Could not create blob' }), '', s);

		expect(s.calls).toEqual(['progress 10', 'error Ollama: Could not create blob']);
		expect(s.create).not.toHaveBeenCalled();
	});

	it('says so when the stream ends before the blob is stored', async () => {
		const s = steps();
		await finishUpload(stream({ progress: 10 }), '', s);

		expect(s.calls.at(-1)).toBe('error The upload ended before the model was stored.');
	});

	it('shows the reason a create was refused', async () => {
		const s = steps();
		s.create.mockResolvedValueOnce(new Response('{"detail":"model exists"}', { status: 400 }));
		await finishUpload(stream({ done: true, blob: 'sha256:abc', name: 'm.gguf' }), '', s);

		expect(s.calls.at(-1)).toBe('error model exists');
		expect(s.followCreate).not.toHaveBeenCalled();
	});

	it('skips a line it cannot read and carries on', async () => {
		const s = steps();
		const body = `data: not json\n\ndata: ${JSON.stringify({ done: true, blob: 'b', name: 'n', model_created: 'n' })}\n\n`;
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await finishUpload(new Response(body, { status: 200 }), '', s);
		error.mockRestore();

		expect(s.calls.at(-1)).toBe('success Model n created');
	});
});
