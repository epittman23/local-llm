/**
 * Model-written HTML in an iframe sandboxed to `allow-scripts` and nothing
 * else: an opaque origin, so its script reaches neither the app's cookies,
 * storage nor DOM, and it cannot open windows, submit forms or navigate the
 * page. The document comes with its content-security policy already in
 * front (from the server for a sandbox output, `withHtmlPolicy` for a fenced
 * block), which blocks fetches, images, fonts and form posts, but
 * not WebRTC: CSP has no directive for it, so a script here can still reach
 * the network through a STUN or TURN host it names, and leak what the model
 * wrote, what the user types into the frame, and the user's IP. The owner
 * accepted that (Q23 in docs/plans/sandbox-implementation.md), so scripts
 * run as soon as the reply shows. Nor does the policy stop the frame
 * navigating itself, which only the desktop app denies (docs/guides/sandbox.md,
 * "Outputs"). Never a `blob:` URL or a new window, which would give it an
 * origin of its own to run in.
 *
 * The frame sits on the theme's surface with an edge (CNV-5), so nothing white
 * shows before the page paints; the page's own colours are left as written.
 */
export function SandboxedHtmlFrame({ html, title }: { html: string; title: string }) {
	return (
		<iframe
			srcDoc={html}
			sandbox="allow-scripts"
			title={title}
			referrerPolicy="no-referrer"
			className="bg-surface-1 border-border size-full rounded-lg border"
		/>
	);
}
