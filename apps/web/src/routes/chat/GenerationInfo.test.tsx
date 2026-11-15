import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { GenerationInfo, generationInfo } from './GenerationInfo';

afterEach(cleanup);

describe('generationInfo (#994)', () => {
	it('counts tokens once, in words, though the server adds aliases', () => {
		expect(
			generationInfo({
				prompt_tokens: 42,
				completion_tokens: 255,
				total_tokens: 297,
				input_tokens: 42,
				output_tokens: 255
			})
		).toEqual({
			tokens: '42 prompt + 255 completion',
			reasoning: null,
			speed: null,
			promptSpeed: null,
			total: null
		});
	});

	it('reads llama-server’s timings as speeds and a total time, with thousands separated', () => {
		expect(
			generationInfo({
				prompt_n: 1200,
				predicted_n: 255,
				input_tokens: 1200,
				output_tokens: 255,
				prompt_per_second: 74.04,
				predicted_per_second: 31.2,
				prompt_ms: 16200,
				predicted_ms: 8170
			})
		).toMatchObject({
			tokens: '1,200 prompt + 255 completion',
			speed: '31.2 tokens/s',
			promptSpeed: '74.0 tokens/s',
			total: '24.4 s'
		});
	});

	it('names reasoning tokens where the provider reports them, and leaves out what is missing', () => {
		expect(
			generationInfo({ completion_tokens: '90', completion_tokens_details: { reasoning_tokens: 60 } })
		).toMatchObject({
			tokens: '90 completion',
			reasoning: '60 tokens'
		});
		expect(generationInfo({ output_tokens_details: { reasoning_tokens: 3 }, predicted_ms: 500 })).toMatchObject({
			tokens: null,
			reasoning: '3 tokens',
			total: '0.5 s'
		});
		expect(generationInfo({ prompt_tokens: 'many' }).tokens).toBeNull();
	});
});

describe('GenerationInfo', () => {
	const open = (usage: Record<string, unknown>) => {
		render(
			<TooltipProvider>
				<GenerationInfo usage={usage} />
			</TooltipProvider>
		);
		const trigger = screen.getByRole('button', { name: 'Generation info' });
		fireEvent.click(trigger);
		return screen.findByRole('dialog');
	};

	it('opens by click, not hover, and says when the provider reports no speed', async () => {
		const dialog = await open({ prompt_tokens: 42, completion_tokens: 255 });
		expect(dialog.textContent).toContain('42 prompt + 255 completion');
		expect(dialog.textContent).toContain('Speed not reported by this provider');
	});

	it('lists the speed and time when the reply holds them', async () => {
		const dialog = await open({ predicted_n: 10, predicted_per_second: 12.5, predicted_ms: 800 });
		expect(dialog.textContent).toContain('12.5 tokens/s');
		expect(dialog.textContent).toContain('Total time0.8 s');
		expect(dialog.textContent).not.toContain('Speed not reported');
	});
});
