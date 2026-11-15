import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/constants', () => ({ WEBUI_VERSION: '1.2.0' }));

import { refusedForVersion } from './pluginVersion';

const plugin = (required: string) => `"""\ntitle: A tool\nrequired_open_webui_version: ${required}\n"""\nimport os`;

describe('refusedForVersion', () => {
	beforeEach(() => vi.mocked(toast.error).mockClear());

	it('refuses a plugin that needs a newer app, naming the product as local-llm (WRD-3)', () => {
		expect(refusedForVersion(plugin('9.0.0'))).toBe(true);
		expect(toast.error).toHaveBeenCalledWith('local-llm version (v1.2.0) is lower than required version (v9.0.0)');
	});

	it('accepts a plugin this version satisfies, without a message', () => {
		expect(refusedForVersion(plugin('1.0.0'))).toBe(false);
		expect(refusedForVersion('import os')).toBe(false);
		expect(toast.error).not.toHaveBeenCalled();
	});
});
