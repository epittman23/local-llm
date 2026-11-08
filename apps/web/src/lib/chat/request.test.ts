// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addResponses, addUserMessage, emptyHistory, messagesList } from './history';
import {
	completionBody,
	initialModels,
	isTemporaryChatId,
	needsWebSearchConfirm,
	newChatTemporary,
	pathFiles,
	promptVariables,
	requestFeatures,
	stopTokens,
	webSearchConfirmText
} from './request';

const models = [{ id: 'a' }, { id: 'b' }, { id: 'hidden', info: { meta: { hidden: true } } }];

describe('initialModels', () => {
	it('prefers the URL, then the folder, then the user, then the defaults', () => {
		expect(initialModels({ url: 'b,zzz', userModels: ['a'], models })).toEqual(['b']);
		expect(initialModels({ folderModels: ['b'], userModels: ['a'], models })).toEqual(['b']);
		expect(initialModels({ userModels: ['a'], defaults: 'b', models })).toEqual(['a']);
		expect(initialModels({ defaults: 'b', models })).toEqual(['b']);
	});
	it('drops hidden models and falls back to the first available', () => {
		expect(initialModels({ userModels: ['hidden'], models })).toEqual(['a']);
		expect(initialModels({ models: [] })).toEqual(['']);
	});
});

describe('request pieces', () => {
	it('decodes stop tokens', () => {
		expect(stopTokens('\\n, END')).toEqual(['\n', 'END']);
		expect(stopTokens(['\\t\\u0041', 'say \\"hi\\"', 'C:\\\\dir'])).toEqual(['\tA', 'say "hi"', 'C:\\dir']);
		// A trailing or unknown backslash is kept, and the rest still decodes.
		expect(stopTokens(['end\\', '\\n\\q'])).toEqual(['end\\', '\n\\q']);
		expect(stopTokens('100%')).toEqual(['100%']);
		expect(stopTokens(undefined)).toBeUndefined();
	});
	it('only enables features the server and permissions allow', () => {
		const t = { webSearch: true, imageGeneration: true, codeInterpreter: true };
		const user = { id: 'u', role: 'user', permissions: { features: { image_generation: true } } } as any;
		expect(
			requestFeatures(
				t,
				user,
				{ features: { enable_image_generation: true, enable_code_interpreter: true } } as any,
				{}
			)
		).toEqual({ voice: false, image_generation: true, code_interpreter: false, web_search: true });
	});
	it('sends documents but not images as files, once', () => {
		const doc = { type: 'file', id: 'd', content_type: 'application/pdf' };
		const img = { type: 'image', url: 'data:x' };
		expect(
			pathFiles([
				{ role: 'user', files: [doc] },
				{ role: 'user', files: [doc, img] }
			] as never)
		).toEqual([doc]);
	});
	it("reads a branch's documents from its user messages only, one copy of each (#160)", () => {
		const doc = { type: 'file', id: 'd', content_type: 'application/pdf', status: 'uploaded' };
		const kb = { type: 'collection', id: 'kb', name: 'KB' };
		const page = { type: 'text', name: 'Page', content: 'a' };
		const path = [
			{ role: 'user', files: [doc, kb, page] },
			// A model's own file (an image tool's output) is never context.
			{ role: 'assistant', files: [{ type: 'file', id: 'out', content_type: 'text/csv' }] },
			// The same file and base attached again, their stored copies differing in a field.
			{
				role: 'user',
				files: [
					{ ...doc, status: 'processed' },
					{ ...kb, files: [] },
					{ ...page, content: 'b' }
				]
			}
		];
		// A web page has no id: two different ones are two documents.
		expect(pathFiles(path as never)).toEqual([doc, kb, page, { ...page, content: 'b' }]);
	});
	it('recognises temporary chat ids', () => {
		expect(isTemporaryChatId('temporary:s1')).toBe(true);
		expect(isTemporaryChatId('abc')).toBe(false);
	});
});

describe('completionBody', () => {
	const setup = () => {
		const u = addUserMessage(emptyHistory(), null, { content: 'hello' });
		const r = addResponses(u.history, u.id, [{ id: 'a' }]);
		return { history: r.history, responseId: r.targets[0].message_id, targets: r.targets };
	};
	const base = {
		model: { id: 'a' },
		sessionId: 's1',
		params: {},
		settings: {},
		features: {},
		variables: {}
	};

	it("sends the documents of the branch being answered, and none of a sibling branch's (#160)", () => {
		const doc = { type: 'file', id: 'd1', content_type: 'application/pdf' };
		// q0 -> a0 -> q1 (attaches d1) -> a1, then a0 regenerated as a sibling, a0'.
		const q0 = addUserMessage(emptyHistory(), null, { content: 'hi' });
		const a0 = addResponses(q0.history, q0.id, [{ id: 'a' }]);
		const q1 = addUserMessage(a0.history, a0.targets[0].message_id, { content: 'read this', files: [doc] });
		const a1 = addResponses(q1.history, q1.id, [{ id: 'a' }]);
		const regen = addResponses(a1.history, q0.id, [{ id: 'a' }]);
		const h = regen.history;
		const files = (responseId: string, messages?: Parameters<typeof completionBody>[0]['messages']) =>
			completionBody({ ...base, history: h, responseId, chatId: 'c1', temporary: false, messages }).files;

		expect(files(regen.targets[0].message_id)).toBeUndefined();
		// Back on the first branch, a follow-up or a continue still reads d1.
		const q2 = addUserMessage(h, a1.targets[0].message_id, { content: 'and?' });
		const a2 = addResponses(q2.history, q2.id, [{ id: 'a' }]);
		expect(
			completionBody({
				...base,
				history: a2.history,
				responseId: a2.targets[0].message_id,
				chatId: 'c1',
				temporary: false
			}).files
		).toEqual([doc]);
		expect(files(a1.targets[0].message_id)).toEqual([doc]);
		// A regeneration with a suggestion reads the path it was given.
		expect(files(regen.targets[0].message_id, messagesList(h, a1.targets[0].message_id))).toEqual([doc]);
	});

	it('a number cleared in chat controls means Default, not an empty value sent upstream (#200)', () => {
		const body = completionBody({
			...setup(),
			...base,
			chatId: 'c1',
			temporary: false,
			params: { temperature: '', max_tokens: 512, seed: null },
			settings: { params: { temperature: 0.3, top_p: '' } }
		});
		expect(body.params).toMatchObject({ temperature: 0.3, max_tokens: 512 });
		expect(body.params).not.toHaveProperty('top_p');
		expect(body.params).not.toHaveProperty('seed');
	});
	it('zero and false are values; a cleared stop sequence or a Default (null) falls back to the setting', () => {
		const body = completionBody({
			...setup(),
			...base,
			chatId: 'c1',
			temporary: false,
			params: { temperature: 0, stream_response: false, seed: null, stop: '' },
			settings: { params: { temperature: 0.7, seed: 42, stop: ['END'] } }
		});
		expect(body.params).toMatchObject({ temperature: 0, stream_response: false, seed: 42 });
		expect(body.params.stop).toEqual(['END']);
	});
	it('asks the server to create a new chat, with title and tags', () => {
		const body = completionBody({ ...setup(), ...base, chatId: null, temporary: false });
		expect(body).toMatchObject({
			model: 'a',
			session_id: 's1',
			chat_id: undefined,
			parent_id: null,
			background_tasks: { title_generation: true, tags_generation: true, follow_up_generation: true }
		});
		expect(body.messages).toBeUndefined();
		expect(body.user_message?.content).toBe('hello');
	});
	it('sends the conversation only for a temporary chat, after the system prompt', () => {
		const body = completionBody({
			...setup(),
			...base,
			params: { system: 'Be brief' },
			chatId: 'temporary:s1',
			temporary: true
		});
		expect(body.messages).toEqual([
			{ role: 'system', content: 'Be brief' },
			{ role: 'user', content: 'hello' }
		]);
		expect(body.background_tasks).toEqual({ follow_up_generation: true });
	});
	it('merges parameters with the chat winning over the user settings', () => {
		const body = completionBody({
			...setup(),
			...base,
			settings: { params: { temperature: 1, top_k: 5 } },
			params: { temperature: 0.2 },
			chatId: 'c1',
			temporary: false
		});
		expect(body.params).toEqual({ temperature: 0.2, top_k: 5, stop: undefined });
		expect(body.chat_id).toBe('c1');
	});
});

describe('temporary chats and web search confirmation', () => {
	it('a new chat is temporary when enforced, or by the user default where allowed', () => {
		expect(newChatTemporary({ enforced: true, allowed: false, byDefault: false })).toBe(true);
		expect(newChatTemporary({ enforced: false, allowed: true, byDefault: true })).toBe(true);
		expect(newChatTemporary({ enforced: false, allowed: false, byDefault: true })).toBe(false);
		expect(newChatTemporary({ enforced: false, allowed: true, byDefault: false })).toBe(false);
	});
	it('asks before the first prompt with web search on, only when the admin requires it', () => {
		const on = { features: { enable_web_search_confirmation: true } };
		expect(needsWebSearchConfirm(on, true, false)).toBe(true);
		expect(needsWebSearchConfirm(on, true, true)).toBe(false);
		expect(needsWebSearchConfirm(on, false, false)).toBe(false);
		expect(needsWebSearchConfirm({ features: {} }, true, false)).toBe(false);
		expect(needsWebSearchConfirm(null, true, false)).toBe(false);
	});
	it("shows the admin's text, or a default", () => {
		expect(webSearchConfirmText({ features: { web_search_confirmation_content: ' Searches go to **Brave**. ' } })).toBe(
			'Searches go to **Brave**.'
		);
		expect(webSearchConfirmText({ features: { web_search_confirmation_content: '  ' } })).toBe(
			'Your query will be sent to the configured web search provider.'
		);
	});
});

describe('{{USER_LANGUAGE}} (#326)', () => {
	const prefer = (languages: string[], language: string) => {
		vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
		vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
	};
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	it("is the user's first preferred language, not the interface's only locale", () => {
		prefer(['de-DE', 'en-US'], 'en-US');
		localStorage.setItem('locale', 'en-US');

		expect(promptVariables(null)['{{USER_LANGUAGE}}']).toBe('de-DE');
	});

	it("is the browser's language when it lists no preferences", () => {
		prefer([], 'fr-FR');

		expect(promptVariables(null)['{{USER_LANGUAGE}}']).toBe('fr-FR');
	});

	it('falls back to en-US when the browser names none', () => {
		prefer([], '');

		expect(promptVariables(null)['{{USER_LANGUAGE}}']).toBe('en-US');
	});
});
