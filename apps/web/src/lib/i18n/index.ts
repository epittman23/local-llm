// Ports apps/openwebui/src/lib/i18n/index.ts's i18next config verbatim (same
// detection order, same fallback map, same interpolation settings) -- only the
// Svelte-store wrapper (createI18nStore/createIsLoadingStore) is dropped, since
// react-i18next's own useTranslation()/I18nextProvider give the same reactivity
// natively. The 65 locale JSON files under ./locales are the SvelteKit app's own,
// copied verbatim.

import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';

export const initI18n = (defaultLocale?: string) => {
	const detectionOrder = defaultLocale
		? ['querystring', 'localStorage']
		: ['querystring', 'localStorage', 'navigator'];
	const fallbackDefaultLocale = defaultLocale ? [defaultLocale] : ['en-US'];

	const loadResource = (language: string, namespace: string) =>
		import(`./locales/${language}/${namespace}.json`);

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
			fallbackLng: {
				fr: ['fr-FR'],
				default: fallbackDefaultLocale
			},
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

export const getLanguages = async () => {
	const languages = (await import('./locales/languages.json')).default;
	return languages as { code: string; title: string }[];
};

export const changeLanguage = (lang: string) => {
	i18next.changeLanguage(lang);
};

export default i18next;
