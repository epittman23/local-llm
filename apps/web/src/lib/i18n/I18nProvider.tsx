import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18next, { initI18n } from '@/lib/i18n';

let started = false;

export function I18nProvider({ children }: { children: React.ReactNode }) {
	// initI18n() is idempotent-by-guard rather than by i18next itself, matching
	// the fetch guard in lib/auth/session.ts: React StrictMode double-invokes
	// effects/renders in dev, and re-running .init() would refetch every
	// namespace for no reason.
	const [ready] = useState(() => {
		if (!started) {
			started = true;
			initI18n();
		}
		return true;
	});

	if (!ready) return null;

	return <I18nextProvider i18n={i18next}>{children}</I18nextProvider>;
}
