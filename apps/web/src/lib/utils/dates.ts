import dayjs from 'dayjs';
import isToday from 'dayjs/plugin/isToday';
import isYesterday from 'dayjs/plugin/isYesterday';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(isToday);
dayjs.extend(isYesterday);
dayjs.extend(localizedFormat);
dayjs.extend(relativeTime);

export { dayjs };

/**
 * "Today at 3:04 PM" / "Yesterday at 3:04 PM" / "9/19/2026 at 3:04 PM" for a
 * timestamp in *seconds*. The SvelteKit app splits this into `formatDate`
 * (returns an i18n template with {{LOCALIZED_TIME}} placeholders) plus a
 * `$i18n.t(...)` call at each use; this app's pages render English strings for
 * now (see the migration plan's notes on i18n), so it is one function.
 */
export function formatSecondsTimestamp(seconds: number): string {
	const date = dayjs(seconds * 1000);
	const time = date.format('LT');
	if (date.isToday()) return `Today at ${time}`;
	if (date.isYesterday()) return `Yesterday at ${time}`;
	return `${date.format('L')} at ${time}`;
}
