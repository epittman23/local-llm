import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELFILE, isNotableStatus, modelLabel, parseStreamLines, progressPercent, sanitizeModelTag, streamError, uploadedModelfile } from './ollamaStreams';

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
