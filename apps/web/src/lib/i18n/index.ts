// Ports d863707:apps/openwebui/src/lib/i18n/index.ts's i18next config (same
// detection order and interpolation settings) -- only the Svelte-store wrapper
// (createI18nStore/createIsLoadingStore) is dropped, since react-i18next's own
// useTranslation()/I18nextProvider give the same reactivity natively. Only the
// en-US locale ships (./locales/en-US), copied verbatim from the SvelteKit app;
// the other 63 were removed on 2026-10-10 because no page translates anything.

import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';

export const initI18n = (defaultLocale?: string) => {
	const detectionOrder = defaultLocale ? ['querystring', 'localStorage'] : ['querystring', 'localStorage', 'navigator'];
	const fallbackDefaultLocale = defaultLocale ? [defaultLocale] : ['en-US'];

	const loadResource = (language: string, namespace: string) => import(`./locales/${language}/${namespace}.json`);

	return i18next
		.use(resourcesToBackend(loadResource))
		.use(LanguageDetector)
		.init({
			debug: false,
			detection: {
				order: detectionOrder,
				caches: ['localStorage'],
				lookupQuerystring: 'lang',
				lookupLocalStorage: 'locale'
			},
			supportedLngs: ['en-US'],
			fallbackLng: fallbackDefaultLocale,
			ns: 'translation',
			keySeparator: false,
			nsSeparator: false,
			returnEmptyString: false,
			interpolation: {
				escapeValue: false // React escapes by default too, but kept for parity
			}
		});
};

i18next.on('languageChanged', (lang) => {
	if (typeof document !== 'undefined') {
		document.documentElement.setAttribute('lang', lang);
	}
});

export default i18next;
