// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { addResponses, addUserMessage, emptyHistory } from './history';
import {
	completionBody,
	initialModels,
	isTemporaryChatId,
	needsWebSearchConfirm,
	newChatTemporary,
	requestFeatures,
	stopTokens,
	turnFiles,
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
		expect(turnFiles([doc], { files: [doc, img] } as any)).toEqual([doc]);
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
		chatFiles: [],
		features: {},
		variables: {}
	};

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
