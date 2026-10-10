import { toast } from 'sonner';
import { WEBUI_VERSION } from '@/lib/constants';
import { compareVersion, extractFrontmatter } from '@/lib/utils/plugins';

/**
 * True (after toasting) when a plugin's `required_open_webui_version` header
 * asks for a newer app than this one, in which case saving is refused. Shared
 * by the Tools and Functions create/edit pages.
 */
export function refusedForVersion(content: string): boolean {
	const required = extractFrontmatter(content).required_open_webui_version ?? '0.0.0';
	if (!compareVersion(required, WEBUI_VERSION)) return false;
	toast.error(`Local LLM version (v${WEBUI_VERSION}) is lower than required version (v${required})`);
	return true;
}
