import { FileText, X } from 'lucide-react';
import { AdvancedParams } from '@/components/common/AdvancedParams';

type Params = Record<string, any>;
type ChatFile = { id?: string | null; name?: string; type?: string; file?: { filename?: string } };

/**
 * A reduced port of chat/ChatControls.svelte + Controls.svelte: the files
 * attached to this chat (removable), its system prompt and its advanced
 * parameters. What is edited here is the chat's own `params` -- sent with
 * every request and saved with the chat -- layered over the user's defaults
 * from Settings > General. Function valves are not ported.
 */
export function ChatControls({
	params,
	onParams,
	files,
	onRemoveFile,
	onClose,
	admin
}: {
	params: Params;
	onParams: (p: Params) => void;
	files: ChatFile[];
	onRemoveFile: (index: number) => void;
	onClose: () => void;
	admin: boolean;
}) {
	return (
		<aside className="flex min-h-0 w-full flex-col border-l md:w-80" aria-label="Controls">
			<div className="flex items-center px-3 py-2">
				<span className="text-sm font-medium">Controls</span>
				<button
					type="button"
					aria-label="Close controls"
					className="text-muted-foreground hover:bg-muted ml-auto rounded-lg p-1.5"
					onClick={onClose}
				>
					<X className="size-4" />
				</button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 text-sm">
				{files.length > 0 && (
					<section>
						<h3 className="mb-1 text-xs font-medium">Files</h3>
						<ul className="flex flex-col gap-1" aria-label="Chat files">
							{files.map((f, i) => (
								<li key={f.id ?? i} className="flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs">
									<FileText className="text-muted-foreground size-3.5 shrink-0" />
									<span className="truncate">{f.name ?? f.file?.filename ?? f.id}</span>
									<button
										type="button"
										aria-label={`Remove ${f.name ?? 'file'}`}
										className="text-muted-foreground hover:text-foreground ml-auto"
										onClick={() => onRemoveFile(i)}
									>
										<X className="size-3" />
									</button>
								</li>
							))}
						</ul>
					</section>
				)}
				<section>
					<label htmlFor="chat-system-prompt" className="mb-1 block text-xs font-medium">
						System Prompt
					</label>
					<textarea
						id="chat-system-prompt"
						rows={4}
						className="bg-muted/40 focus:border-ring w-full resize-y rounded-lg border px-2 py-1.5 text-xs outline-hidden"
						placeholder="Enter system prompt"
						value={params.system ?? ''}
						onChange={(e) => onParams({ ...params, system: e.target.value || undefined })}
					/>
				</section>
				<section>
					<h3 className="mb-1 text-xs font-medium">Advanced Params</h3>
					<AdvancedParams params={params} onChange={(p) => onParams({ ...p, system: params.system })} admin={admin} />
				</section>
			</div>
		</aside>
	);
}
