import { describe, expect, it } from 'vitest';
import { blankPolicy, buildPolicyData, buildTerminalConnection, parseLifecycle, policyFromServer, suggestPolicyId, terminalFields } from './terminalServerModel';

describe('terminalFields', () => {
	it('a new connection starts disabled; an existing one without the flag is enabled', () => {
		expect(terminalFields(null).enabled).toBe(false);
		expect(terminalFields({ url: 'http://t' }).enabled).toBe(true);
	});
	it('a policy ID implies an Orchestrator, and only then are contexts read', () => {
		const c = { url: 'http://o', policy_id: 'p', config: { contexts: { chat: false, automation: { context_id: 'automation_id' } } } };
		expect(terminalFields(c)).toMatchObject({ serverType: 'orchestrator', chatContext: 'off', automationContext: 'automation_id' });
		expect(terminalFields({ ...c, policy_id: undefined, server_type: 'terminal' })).toMatchObject({ serverType: 'terminal', chatContext: 'default', automationContext: 'default' });
	});
	it('chat uploads are filesystem only when said so', () => {
		expect(terminalFields({ config: { chat_uploads: 'filesystem' } }).chatUploads).toBe('filesystem');
		expect(terminalFields({ config: { chat_uploads: 'weird' } }).chatUploads).toBe('default');
	});
});

describe('policy', () => {
	it('reads what the Orchestrator returned, with defaults', () => {
		expect(policyFromServer(null, null)).toEqual(blankPolicy());
		expect(policyFromServer({ image: 'img', storage: '10Gi', env: { A: 1 }, idle_timeout_minutes: 5 }, { reset: { schedule: '@daily' } })).toMatchObject({
			image: 'img',
			storage: 'persistent',
			storageSize: '10Gi',
			envPairs: [{ key: 'A', value: '1' }],
			idleTimeout: 5,
			lifecycleJson: '{\n  "reset": {\n    "schedule": "@daily"\n  }\n}'
		});
	});
	it('builds the policy: blanks out, storage only when persistent, unnamed env dropped, keys trimmed', () => {
		expect(buildPolicyData({ ...blankPolicy(), cpu: '', idleTimeout: 0 })).toEqual({ memory_limit: '1Gi' });
		expect(buildPolicyData({ ...blankPolicy(), storage: 'persistent', envPairs: [{ key: ' A ', value: 'x' }, { key: ' ', value: 'y' }] })).toEqual({
			cpu_limit: '1',
			memory_limit: '1Gi',
			storage: '5Gi',
			idle_timeout_minutes: 30,
			env: { A: 'x' }
		});
	});
	it('lifecycle must be a JSON object; empty means {}', () => {
		expect(parseLifecycle('')).toEqual({ value: {} });
		expect(parseLifecycle('[]')).toEqual({ error: 'Lifecycle JSON must be a JSON object' });
		expect(parseLifecycle('{')).toEqual({ error: 'Lifecycle JSON contains invalid JSON' });
	});
	it('suggests a policy ID from the ID, else a slug of the name, else "default"', () => {
		expect(suggestPolicyId('my-id', 'Name')).toBe('my-id');
		expect(suggestPolicyId('', ' Python DS!! Box ')).toBe('python-ds-box');
		expect(suggestPolicyId('', '')).toBe('default');
	});
});

describe('buildTerminalConnection', () => {
	const base = { ...terminalFields(null), url: 'http://t/', key: ' k \n', name: 'T', enabled: true };
	it('drops the trailing slash, trims the key, and omits a blank ID', () => {
		expect(buildTerminalConnection(base, undefined, { direct: false })).toEqual({ url: 'http://t', key: 'k', name: 'T', path: '/openapi.json', auth_type: 'bearer', enabled: true, config: { access_grants: [] } });
	});
	it('keeps unknown config keys; contexts only for an Orchestrator with a non-default choice', () => {
		const f = { ...base, id: ' t1 ', serverType: 'orchestrator' as const, policyId: 'p', chatContext: 'chat_id' as const, chatUploads: 'filesystem' as const };
		expect(buildTerminalConnection(f, { extra: 1, contexts: { old: true } }, { direct: false })).toMatchObject({
			id: 't1',
			server_type: 'orchestrator',
			policy_id: 'p',
			config: { extra: 1, access_grants: [], contexts: { chat: { context_id: 'chat_id' } }, chat_uploads: 'filesystem' }
		});
		expect(buildTerminalConnection({ ...f, chatContext: 'default' }, { contexts: { old: true } }, { direct: false }).config).not.toHaveProperty('contexts');
	});
	it('a direct connection has no ID, access grants or contexts', () => {
		const out = buildTerminalConnection({ ...base, id: 'x', serverType: 'orchestrator', chatContext: 'off' }, { access_grants: [1] }, { direct: true });
		expect(out).not.toHaveProperty('id');
		expect(out.config).toEqual({});
	});
});
