import { expect, it } from 'vitest';
import { mergeModels, togglePlan, upsertPlan } from '@/routes/admin/settings/models/adminModels';

it('after hiding a record-less connection model, every later change still plans a create', () => {
	// A connection model the app serves, with no stored record (getBaseModels returned nothing for it).
	const served = [{ id: 'qwen/qwen3.6-27b', name: 'Qwen', owned_by: 'openai' }];
	const recordIds = new Set<string>(); // AdminModels only refreshes this in init()
	const [model] = mergeModels(served, [], [], '');

	const first = upsertPlan(model, { meta: { ...model.meta, hidden: true } }, recordIds);
	console.log('1st hide  ->', first.action);
	// AdminModels.toggleHidden then only patches meta locally (no init()).
	const patched = { ...model, meta: { ...model.meta, hidden: true } };
	const second = upsertPlan(patched, { meta: { ...patched.meta, hidden: false } }, recordIds);
	console.log('2nd click ->', second.action);
	const toggle = togglePlan(patched, false);
	console.log('enable switch ->', toggle.action);
	expect([first.action, second.action, toggle.action]).toEqual(['create', 'create', 'create']);
});
