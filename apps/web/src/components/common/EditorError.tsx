import { CircleAlertIcon } from 'lucide-react';
import type { CodeParseError } from '@/components/common/CodeEditor';
import { failureCause } from '@/components/common/LoadFailed';

/** What went wrong in an editor, in words, with the server's or Black's own words behind Details. */
export type EditorProblem = { message: string; detail: string | null };

/** Black's parse error, located: "Line 30, column 12: this line isn't valid Python." */
export const parseProblem = (error: CodeParseError): EditorProblem => ({
	message: `Line ${error.line}, column ${error.column}: this line isn't valid Python.`,
	detail: error.detail
});

const ID_TAKEN = /^Uh-oh! This id is already registered/;
const SERVER_ERROR = /^\[ERROR: (.*)\]$/s;
const LOAD_FAILED = /^Error (creating|updating) /;

/**
 * Why saving a tool, function or skill failed (FBK-4), from what its API helper threw.
 * The server words a failure to load the code as "[ERROR: Error updating
 * tool]", so that becomes what it means; a taken id says so; a server that did
 * not answer says that; anything else keeps the server's message.
 */
export function saveProblem(error: unknown, what: 'tool' | 'function' | 'skill'): EditorProblem {
	const text = typeof error === 'string' ? error.trim() : '';
	if (ID_TAKEN.test(text))
		return { message: `This ID is already used by another ${what}. Choose another.`, detail: null };
	const { cause, detail } = failureCause(error);
	if (!detail) return { message: `Couldn't save the ${what}. ${cause}`, detail: null };
	const inner = SERVER_ERROR.exec(detail)?.[1]?.trim() ?? detail;
	if (what !== 'skill' && LOAD_FAILED.test(inner)) {
		return {
			message: `Couldn't save the ${what}. The server couldn't load its code; check that it runs.`,
			detail: inner
		};
	}
	return { message: `Couldn't save the ${what}. ${inner}`, detail: null };
}

/**
 * A code editor's error, in place of its help line and above its footer
 * (FRM-2, FBK-1): never a toast over Save. `id` is the help line's, so the
 * editor's `aria-describedby` reads the error while it shows.
 */
export function EditorError({ id, problem }: { id: string; problem: EditorProblem }) {
	return (
		<div id={id} role="alert" className="text-danger text-dense flex items-start gap-1.5 px-1 pt-1.5">
			<CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
			<div className="min-w-0">
				<p>{problem.message}</p>
				{problem.detail && (
					<details className="text-foreground-muted">
						<summary className="cursor-pointer">Details</summary>
						<pre className="font-mono text-caption mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">
							{problem.detail}
						</pre>
					</details>
				)}
			</div>
		</div>
	);
}
