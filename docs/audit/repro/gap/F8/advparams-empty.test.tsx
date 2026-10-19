import { fireEvent, render } from '../../../../../apps/web/node_modules/@testing-library/react';
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import { TooltipProvider } from '@/components/ui/tooltip';
import { completionBody } from '@/lib/chat/request';

it('clearing a Custom number box leaves "" in params, and the chat request carries it', () => {
	const onChange = vi.fn();
	const { getByLabelText } = render(<TooltipProvider><AdvancedParams params={{ temperature: 0.8, seed: 0 }} onChange={onChange} /></TooltipProvider>);
	fireEvent.change(getByLabelText('Temperature'), { target: { value: '' } });
	const afterTemp = onChange.mock.calls.at(-1)[0];
	fireEvent.change(getByLabelText('Seed'), { target: { value: '' } });
	const afterSeed = onChange.mock.calls.at(-1)[0];
	expect(afterTemp.temperature).toBe('');
	expect(afterSeed.seed).toBe('');
	const body = completionBody({
		history: { messages: { r: { id: 'r', parentId: 'u', role: 'assistant', content: '', childrenIds: [] }, u: { id: 'u', parentId: null, role: 'user', content: 'hi', childrenIds: ['r'] } }, currentId: 'r' } as never,
		responseId: 'r',
		model: { id: 'm' } as never,
		chatId: 'c',
		temporary: false,
		params: { temperature: '', seed: '' },
		settings: { params: { temperature: 0.2 } },
		chatFiles: [],
		features: {},
		variables: {}
	});
	writeFileSync('/tmp/audit-F8-advparams-empty.out',
		JSON.stringify({ afterTemp, afterSeed, requestParams: body.params }, null, 1));
	expect(body.params.temperature).toBe(''); // overrides the user's saved 0.2 with ""
});
