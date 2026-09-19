export { cn } from "cn"

// Ports apps/openwebui/src/lib/utils/index.ts's `formatNumber` (workspace tab
// counts): 1234 -> "1.2k".
export const formatNumber = (num: number): string =>
	new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
		.format(num)
		.toLowerCase();
