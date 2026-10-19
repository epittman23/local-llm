import { expect, it } from 'vitest';
import { formToValves, valvesToForm } from '@/routes/admin/settings/pipelineValves';

it('an unset (null) array valve round-trips to [""], not null', () => {
	const spec = { properties: { pipelines: { type: 'array', title: 'Pipelines' } } };
	const form = valvesToForm({ pipelines: null }, spec);
	console.log('FORM =', JSON.stringify(form));
	const back = formToValves(form, spec);
	console.log('SAVED =', JSON.stringify(back));
	expect(form.pipelines).toBe('');
	expect(back.pipelines).toEqual(['']);
});
