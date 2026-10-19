import { fireEvent, render } from '../../../../../apps/web/node_modules/@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Valves } from '@/components/common/Valves';

it('numeric enum valve: picking an option hands back a string', () => {
	const onChange = vi.fn();
	// Exactly what pydantic emits for `n: Literal[1, 2, 3] = 1`.
	const spec = { properties: { n: { default: 1, enum: [1, 2, 3], title: 'N', type: 'integer' } } } as never;
	const { container } = render(<Valves spec={spec} valves={{ n: 1 }} onChange={onChange} />);
	const select = container.querySelector('select')!;
	fireEvent.change(select, { target: { value: '2' } });
	const sent = onChange.mock.calls[0][0];
	expect(sent).toEqual({ n: '2' }); // string, not 2
	expect(typeof sent.n).toBe('string');
});
