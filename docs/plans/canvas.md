# Canvas: a document viewer and text editor beside the chat

> **Status: planned (2026-11-14). Nothing here is built** except the
> interface design, which is shown on `/ui` ("Canvas") and specified by the
> CNV rules in [docs/guides/ui-standard.md](../guides/ui-standard.md). This
> file is the implementation plan. The owner settled all five of its
> decisions on 2026-11-14; none is open.

## What the owner asked for

A panel on the right of a chat that shows a document, in the manner of the
side panel other assistants have:

1. When the model provides a file, show it in the panel, not inline in the
   reply.
2. When the model's output is HTML, show it in the panel, not inline.
3. The panel is a viewer and a text editor.

## What exists today

| Piece | Where | What it does | What happens to it |
|---|---|---|---|
| `ArtifactPanel` | `apps/web/src/routes/chat/ArtifactPanel.tsx` | Renders one HTML or SVG code block, after its Preview button is pressed, in a 28 rem column with a hard-coded white frame (#941). Frame: `allow-scripts allow-forms allow-modals`, no same-origin | Replaced by the canvas |
| `SandboxOutputs` | `apps/web/src/components/chat/SandboxOutputs.tsx` | Renders every file a sandbox call left in `/workspace/outputs` **inline on the reply**: images, an HTML frame (`allow-scripts` only, 360 px, with Taller/Shorter/Enlarge), PDF page images, highlighted text, a CSV table, or a download link | Its renderers move into the canvas; the reply keeps a card per file |
| `GET /api/v1/sandbox/outputs/{id}/html` | `apps/server/local_llm/routers/sandbox.py` | The only way an HTML output is ever shown: JSON for a sandboxed frame's `srcdoc`, behind a Content-Security-Policy | Kept exactly; the canvas calls it |
| `Attachments` | `routes/chat/ChatMessages.tsx` | Files the owner uploaded: an image inline, anything else as a chip | A chip, or the image, opens the file in the canvas |
| `ChatControls` | `routes/chat/ChatControls.tsx` | The other occupant of the right-hand slot. On a phone it squeezes the chat to a sliver (#901) | Shares the canvas's new side-panel shell, which fixes #901 for both |
| Chat files list | `useChatSession().chatFiles` | Every file on the current branch of the chat | Feeds the canvas's file list |

The security properties of the two frames are deliberate and are kept:
model-written HTML never runs on the app's origin, never in a `blob:` URL or
a new window, and a sandbox output's frame has `allow-scripts` and nothing
else (`docs/guides/sandbox.md`, "Outputs").

## The design

The interface is specified by CNV-1 to CNV-8 in the standard and shown on
`/ui`. In short:

```
┌─────────┬───────────────────────────────┬──────────────────────────────────┐
│ sidebar │ chat                          │ canvas                           │
│         │                               │ [Preview|Source] name · kind     │
│         │  …reply text…                 │        [files ▾] [Copy ▾] ⟳ ⤢ ✕ │
│         │  ┌───────────────────────┐    ├──────────────────────────────────┤
│         │  │ ▣ Variance explorer   │◀───│                                  │
│         │  │   HTML · 14 kB        │    │   the document                   │
│         │  └───────────────────────┘    │                                  │
│         │  [ message box ]              │                                  │
└─────────┴───────────────────────────────┴──────────────────────────────────┘
        below md: the canvas is a full-screen sheet over the chat
```

- **A card in the reply stands for each document** (CNV-1): name, kind and
  size, and it is a button that opens the canvas. The card of the open
  document is marked. Nothing a model provided is rendered inline, with one
  exception: an image keeps a thumbnail on its card.
- **The canvas header** (CNV-3): a Preview / Source switch where both exist,
  the document's name and kind, a file list when the chat has more than one
  document, Copy with a menu (Copy, Download), Reload for a live page,
  Expand to the full window, Close.
- **Kinds and their renderers** (CNV-4):

  | Kind | Preview | Source | Editable |
  |---|---|---|---|
  | HTML (a sandbox output, or a fenced `html` or `svg` block) | Sandboxed frame inside a themed surround | Highlighted, line-numbered | Phase 4 |
  | HTML the owner uploaded | none: Source and Download only | Highlighted, line-numbered | No |
  | Markdown | Rendered with the chat's renderer, at reading width | Plain text | Yes |
  | Text, code, LaTeX, JSON, logs | none: Source only | Highlighted, line-numbered | Yes |
  | CSV | Table (first 200 rows, the existing limits) | Plain text | Phase 4 |
  | Image, including an SVG file | An `<img>`, fitted, on a neutral surround. An SVG file is never inlined or framed | none | No |
  | PDF | Page images (the existing previews) | none | No |
  | Anything else | Name, size and a Download button | none | No |

- **Editing** (CNV-6): Edit turns the Source view into an editor. It saves on
  request, with the standard's "Unsaved changes" bar (FRM-3). What saving
  does is open decision 2.
- **Width** (CNV-2): the canvas takes half of the space beside the sidebar by
  default, is resized with a separator that works from the keyboard, and
  remembers its width. Below `md` it is a sheet.
- **Address** (CNV-7): the open document is in the URL
  (`/c/<chat>?canvas=<file-id>`, or `?canvas=block:<message>:<n>` for a code
  block), so reload and Back restore it.

## What goes to the canvas

| Source | Today | With the canvas |
|---|---|---|
| A file a sandbox call left in `/workspace/outputs` | Rendered inline by `SandboxOutputs` | A card; opens in the canvas |
| A fenced `html` or `svg` code block in a reply | Shown as code, with a Preview button | A card in place of the block; Source is in the canvas. See open decision 1 for the threshold |
| Any other fenced code block | Shown inline | Unchanged: stays inline. A long one gets "Open in canvas" in its header |
| A file the owner uploaded | A chip | The chip opens it in the canvas |
| A knowledge file cited by a reply | The citation dialog | Unchanged in this plan |

While a reply is still streaming, an `html` block's card reads "Writing…"
and the canvas, if open on it, shows Source filling in; Preview becomes
available when the block closes. This avoids re-running a half-written page
on every token.

## Decisions

All five were settled by the owner on 2026-11-14, as written here.

1. **Which HTML goes to the canvas?** *Decided: every fenced `html` or `svg`
   block of a complete document or of more than 15 lines; shorter snippets
   stay inline as code.* The alternative is every block regardless of
   length, which hides three-line examples behind a click.
2. **What does saving an edit do?** *Decided: it saves a new version of the
   document in the app (a new `File` row linked to the same message, the
   earlier one kept), and offers "Attach to next message" so the model sees
   the edit.* It does not write into the sandbox's `/workspace`. Writing back
   into the workspace is the alternative; it needs the sandbox running and a
   new write path, so it is left to a later plan.
3. **Does the canvas open by itself?** *Decided: yes, when a reply finishes
   with exactly one new document and the window is at least `lg` wide;
   never on a phone; with a setting to turn it off.*
4. **Do images stay inline?** *Decided: an image keeps a thumbnail on its
   card and opens full size in the canvas.* A plot is often the whole answer,
   so hiding it entirely behind a card would cost a click on most
   data-analysis replies.
5. **Do `ArtifactPanel`'s wider frame permissions survive?** *Decided: no.
   One frame, `allow-scripts` only, for every HTML document that is
   previewed, as sandbox outputs have today.* A real form submission and
   `alert()`, `confirm()` and `prompt()` stop working inside a preview;
   scripts, inputs and event handlers work as before. The five unported
   "Artifacts" settings (`detectArtifacts` and the four
   `iframeSandboxAllow*`) are removed. So that models write pages that work
   under this, the system prompt gains one line (task C11a).

## Phases and tasks

Each phase is one pull request, verified against the interface standard
(`ui-standard` skill) in dark first, and each leaves the app working.

### Phase 1: the side-panel shell

Fixes #901 on its own, before any canvas exists.

- **C1.** `components/layout/SidePanel.tsx`: the right-hand region. From `md`
  up, a column with a `role="separator"` resize handle (pointer and arrow
  keys, `aria-valuenow`, width stored in `localStorage`); below `md`, the
  shared `Sheet`, full screen. Escape closes it; focus returns to what opened
  it (NAV-4).
- **C2.** `ChatPage` renders `ChatControls` inside it. `ArtifactPanel` moves
  inside it unchanged for now.
- **C3.** Tests: Vitest for the resize arithmetic and the keyboard; Playwright
  at 390 px (the chat is not squeezed; the sheet closes back to the chat) and
  at 1440 px.

### Phase 2: the canvas as a viewer

- **C4.** `lib/chat/documents.ts`: one pure function from a chat's messages to
  its documents (`{ id, name, kind, bytes, messageId, source }`), covering
  sandbox outputs, uploads and qualifying code blocks (decision 1). `kind`
  comes from the extension, then `meta.content_type`, as `SandboxOutputs`
  does today. Defensive about the shape of `message.files`, as that file is.
- **C5.** `routes/chat/canvas/`: `Canvas.tsx` (header, modes, file list) and
  one renderer per kind, moved out of `SandboxOutputs.tsx` with their limits
  (256 KiB of text, 1 MiB and 200 rows of CSV, 5 MiB of HTML) and their
  fetches. `SandboxedHtmlFrame` is reused as it is; its Taller, Shorter and
  Enlarge controls go, since the canvas gives it the height. HTML reaches
  that frame in exactly two ways, both as `srcdoc`, never as a frame `src`:
  a sandbox output through the existing route, which puts its
  Content-Security-Policy in front; and a fenced `html` or `svg` block,
  whose text is already in the message, with the same policy prepended in
  the browser as a `<meta http-equiv>` (the policy text moves to one shared
  constant so the two cannot drift). HTML the owner uploaded is not
  previewed: it has no route that serves it with the policy, so it gets
  Source and Download only. An SVG file stays an `<img>`.
- **C6.** The themed surround for a frame (COL-6, CNT-4, #941): the frame sits
  on `--surface-1` with an edge; before its document paints it shows the
  surface, not white. The document's own background is the document's
  business.
- **C7.** `DocumentCard` replaces the inline renderers on a reply and the
  `html`/`svg` blocks that qualify. `Attachments` chips open the canvas.
- **C8.** `?canvas=` in the URL (`useSearchParams`); a document id that no
  longer exists shows "This document is no longer in the chat" in the canvas
  (NAV-3).
- **C9.** Streaming: the "Writing…" card and Source-while-streaming.
- **C10.** Auto-open and its setting (decision 3), in Settings > Interface,
  replacing the five unported "Artifacts" rows.
- **C11.** Delete `ArtifactPanel.tsx` and the Preview button's plumbing
  (decision 5).
- **C11a.** The system prompt line (decision 5), added in the same pull
  request as C11, because it is only true once every preview is
  scripts-only:

  > HTML you write is previewed in a sandboxed frame that runs scripts but
  > does not submit forms or show `alert`, `confirm` or `prompt` dialogs.
  > Handle input with event listeners and show messages in the page.

  The prompt is configured in the app, not in a file: the owner adds the
  line to the system prompt of each entry under Workspace > Models (README
  "Model setup"). The same change copies it into
  `apps/server/local_llm/benchmarks/data/prompts/assistant.txt`, as AGENTS.md
  requires. That file is append-only for the PR gate and is identified by
  the sha of its bytes, so that pull request trips the gate and needs the
  owner's approval under a `## Gate changes` heading, and benchmark runs
  made after it carry a new system-prompt sha and are not comparable with
  earlier ones.
- **C12.** Tests: Vitest for `documents.ts` (every kind, hostile shapes,
  branch switches) and each renderer; the existing
  `e2e/sandbox-outputs.spec.ts` cases re-pointed at the canvas, since they
  are the security checks (an HTML output never renders on the app's origin;
  an SVG only as an image); a real-backend run with a sandbox producing an
  HTML file, a CSV and a PDF, because Playwright mocks the backend.

### Phase 3: the canvas as a text editor

- **C13.** Edit mode for Markdown, text and code. The owner's requirement
  (2026-11-14): the editor looks identical to the Source view and is
  highlighted as the chat's code blocks are. So it is not a separate editor
  component: Source and the editor are one code surface, highlighted by
  highlight.js (what `CodeBlock` uses) with the standard's token colours
  (CNT-2), with a transparent `<textarea>` laid exactly over the highlighted
  text while editing. `apps/web/src/routes/ui/CodeSurface.tsx` is the working
  model; on `/ui` screenshots of the two states are pixel-identical in dark
  and light. It moves to `components/chat/` and `CodeBlock` adopts the same
  token colours, which also retires the `github-dark` theme (#1064). Tab
  inserts indentation only after the editor has been typed in, so Tab still
  leaves it for keyboard users (Escape, then Tab, always leaves). Editing is
  offered up to the 256 KiB the Source view fetches; a larger file is
  download only. CodeMirror, already a dependency, is the fallback if
  re-highlighting on each keystroke proves slow at that size.
- **C14.** Backend, for decision 2's default: `POST
  /api/v1/files/{id}/versions` creating a new `File` row with
  `meta.version_of` and the same message link, under the same ownership check
  as the file routes; a migration only if `meta` cannot carry it (it can
  today, so none is expected). The frontend's file list groups versions under
  one document and shows "Version 2 of 2" with a way back.
- **C15.** The save bar (FRM-3): Unsaved changes, Discard changes, Save; a
  guard on closing the canvas, switching document or leaving the chat.
- **C16.** "Attach to next message": puts the saved version in the message
  box's attachments.
- **C17.** Tests: pytest for the route (ownership, a version of a version, a
  file from another chat is refused); Vitest for the dirty state and the
  guard; a real-backend run.

### Phase 4: later, not scheduled

Editing HTML with a live preview beside the source; editing a CSV as a
table; a comparison of two versions; writing an edit back into the sandbox
workspace; showing a cited knowledge file in the canvas.

## Risks and how the plan handles them

- **Security regressions when renderers move.** The frame, the HTML route and
  the "images only as `<img>`" rule move unchanged, and the Playwright cases
  that assert them move with them (C12). A fenced block's preview changes
  frame (from `ArtifactPanel`'s wider flags to `allow-scripts` only, with the
  policy added), which narrows what it can do; no HTML gains a way to render
  that it lacks today, and uploaded HTML gains none (C5).
- **A plot-heavy reply becomes click-heavy.** Decision 4's default keeps
  thumbnails; decision 3's default opens a single new document by itself.
- **Imported and old chats.** `documents.ts` reads `message.files`
  defensively and treats an unknown shape as "no document", as today.
- **The page a model wrote is light while the app is dark.** The surround is
  themed (C6); the document itself is not altered. The standard says so
  (CNT-4), and the demo on `/ui` shows it.
- **Phone width.** The canvas is a sheet, the header's secondary actions fold
  into one menu, and nothing depends on hover.

## Documentation that moves with it

Per the maintenance policy, in the pull request that makes each true:
`docs/guides/sandbox.md` "On the reply"; `docs/guides/features.md` and its
chat diagram; README "Pages and URLs" (the `?canvas=` parameter);
`MAP.md` (`routes/chat/canvas/`, `components/layout/SidePanel.tsx`);
`docs/decisions.md` and the roadmap timeline when Phase 2 replaces
`ArtifactPanel`; and this file's status line.

## Related issues

#901 (Controls on a phone), #941 (white preview panel in dark), #989
(light-only colours in frames), #1064 (four code themes; the canvas's Source
view uses the standard's one).
