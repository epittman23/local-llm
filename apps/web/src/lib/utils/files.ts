// Small helpers the workspace file/knowledge surfaces share. Ported from
// apps/openwebui/src/lib/utils/index.ts.

/** 1536 -> "1.5 KB". */
export const formatFileSize = (size: number | null | undefined): string => {
	if (size == null) return 'Unknown size';
	if (typeof size !== 'number' || size < 0) return 'Invalid size';
	if (size === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}
	return `${size.toFixed(1)} ${units[unitIndex]}`;
};

export const isValidHttpUrl = (value: string): boolean => {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
};

export const blobToFile = (blob: Blob, fileName: string): File => new File([blob], fileName, { type: blob.type });
