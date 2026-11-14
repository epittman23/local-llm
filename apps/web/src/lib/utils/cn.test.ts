import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn', () => {
	it('keeps a colour beside a type step (the filled Button at size sm)', () => {
		expect(cn('bg-primary text-primary-foreground', 'h-7 text-dense')).toBe(
			'bg-primary text-primary-foreground h-7 text-dense'
		);
		expect(cn('text-dense', 'text-muted-foreground')).toBe('text-dense text-muted-foreground');
	});

	it('lets a later type step replace an earlier size', () => {
		expect(cn('text-sm', 'text-dense')).toBe('text-dense');
		expect(cn('text-title', 'text-heading')).toBe('text-heading');
		expect(cn('text-xs', 'text-caption')).toBe('text-caption');
	});

	it('treats the standard weights as weights', () => {
		expect(cn('font-bold', 'font-strong')).toBe('font-strong');
		expect(cn('font-title', 'font-medium')).toBe('font-medium');
		expect(cn('font-mono', 'font-strong')).toBe('font-mono font-strong');
	});

	it('treats the panel radius as a radius', () => {
		expect(cn('rounded-lg', 'rounded-panel')).toBe('rounded-panel');
	});

	it('still joins conditionals', () => {
		expect(cn('a', false && 'b', { c: true, d: false })).toBe('a c');
	});
});
