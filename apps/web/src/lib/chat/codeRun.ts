import { type CodeRunResult, executeCode } from '@/lib/apis/utils';
import type { BackendConfig } from '@/lib/stores/configStore';

/** Runs a chat's code block: the code and the chat it is in. */
export type CodeRunner = (code: string, chatId: string) => Promise<CodeRunResult>;

/**
 * The Run button's runner for this server, or undefined when code blocks have none.
 *
 * Code execution must be on (`features.enable_code_execution`) with the
 * `sandbox` engine: the code runs in its chat's sandbox (the endpoint needs
 * the chat id, owner decision Q2). The other engines get no button: Jupyter
 * stays as it was until it is removed (T40), and Pyodide ran in the browser,
 * which this app has no runner for.
 */
export function codeRunner(
	config: BackendConfig | null,
	token: string,
	run: typeof executeCode = executeCode
): CodeRunner | undefined {
	if (!config?.features?.enable_code_execution) return undefined;
	const engine = (config.code as { engine?: unknown } | undefined)?.engine;
	return engine === 'sandbox' ? (code, chatId) => run(token, code, chatId) : undefined;
}
