# Interface standard

The rules every page of `apps/web` (and the desktop app's own windows) is
built and checked against. They exist so that a change can be verified, so
that the same mistake is not made on a ninth page after being fixed on
eight, and so that two pages doing the same job look and behave the same.

- **See it:** `/ui` in the running app (`apps/web/src/routes/ui/`) shows the
  rules on the real shared components, in dark, black and light. Each of its
  sections lists the rules it shows; rules about whole pages, words and
  behaviour over time (for example NAV-1, NAV-3, the WRD rules) are not
  shown there and are checked on the page being changed. Its Canvas section
  shows a design that is planned, not built (see "Canvas").
- **Tokens:** `apps/web/src/styles/standard.css`.
- **Automated checks:** `apps/web/src/styles/standard.contrast.test.ts`
  fails when a token breaks a colour promise, in dark, black or light, and
  `standard.ratchet.test.ts` fails when a file gains a pattern the standard
  forbids (see "The ratchet"). Both are part of `make test-web`.
- **Where it came from:** the UX/UI review of 2026-11-14, issues #901 to
  #1115, indexed in #1116. Most rules exist because that review found the
  opposite on several pages.

Rules have identifiers (`COL-2`, `FRM-3`). Cite them in issues, pull
requests and review comments. "Must" and "never" are requirements; "prefer"
is a default that a pull request may depart from by saying why.

## Status: the app's theme; the pages are being brought to it

Since 2026-11-14 the standard's tokens are the app's theme on every page, in
dark, black and light, and **dark is the default**: a browser that has never
chosen a theme gets dark (`DEFAULT_THEME` in `apps/web/src/lib/theme.ts`),
and the desktop app's own windows are always dark.

What that did and did not change:

- Everything built from the shared components and the token names
  (`bg-background`, `text-muted-foreground`, `Button`, `Input`, ...) took the
  standard's colours, type, focus indicator, edges and sizes at once.
- Code that bypasses them did not: a colour class from Tailwind's palette, a
  one-off size, a hand-styled `<button>`. The ratchet (below, "The ratchet")
  counts every one, per file, and only lets the counts fall. Bringing them to
  zero, area by area, is under way and not finished; the review's issues are
  indexed in #1116.
- A bypass stays only as an **exception the owner has accepted**, recorded
  with its reason in `apps/web/ui-standard-baseline.json`. Nobody else adds
  one: propose it to the owner with the justification.

The rules below apply to every new or changed piece of interface.

## The product this is for

One person uses this app, mostly in dark mode, to work on mathematics,
statistics, data and code, and to measure local models. Four consequences
shape every rule:

- **Dark is the primary theme.** Every change is built and checked in dark
  first. Light must also be correct.
- **The content is the point.** Answers, equations, code and measurements get
  the most legible treatment; the interface around them stays quiet.
- **Characters must be unambiguous.** The app is full of identifiers, flags,
  hashes and figures.
- **There is one owner.** No rule or copy assumes other users, roles or an
  administrator who is someone else.

The visual identity follows from the subject: a blackboard in dark (green-grey
slate, chalk-coloured text, one chalk blue) and a whiteboard in light (warm
paper, marker ink). It is deliberately not the stock shadcn neutral theme and
carries nothing of Open WebUI's.

## Colour

Tokens, by role. Values are in `standard.css`; hex values are shown on `/ui`.

| Token | Role |
|---|---|
| `--page` | The page background |
| `--surface-1` | Panels, the sidebar, cards, the fill of fields |
| `--surface-2` | Floating layers: dialogs, menus, popovers, toasts |
| `--surface-3` | Hover, selection, disabled fills, skeletons |
| `--border-divider` | Lines that separate. Decorative |
| `--border-control` | The edge of anything you type in, tick or switch |
| `--foreground-strong` | Body text and headings |
| `--foreground-muted` | Secondary text, placeholders, help text |
| `--foreground-disabled` | Text of a disabled control. Nothing else |
| `--brand` / `--brand-foreground` | Chalk blue: the primary action, links, selection |
| `--success`, `--warning`, `--danger` | Status, as text, icon or edge |
| `--danger-fill` / `--danger-fill-foreground` | The filled destructive button |
| `--focus` | The focus indicator |
| `--series-1` to `--series-6` | Chart series, in order |
| `--scrim` | The layer behind a dialog |

The shared components read the older shadcn names (`--background`,
`--primary`, `--muted-foreground`, ...). Under the standard those names point
at the tokens above, so `bg-background` and `bg-page` mean the same thing
everywhere. New code prefers the names in this table.

**COL-1. Only tokens.** No colour literal (`#fff`, `rgb()`, `oklch()`) and no
Tailwind palette colour (`bg-white`, `text-gray-500`, `bg-neutral-950`,
`bg-yellow-200`) in a component. If no token fits, the standard is missing
one: add it here and to `standard.css`, in both themes.

**COL-2. Text is at least 4.5:1 on the surface it sits on**, and body text at
least 7:1. This includes muted text, placeholders, help text, counts and
timestamps. Never lower the contrast of text to make it secondary: no opacity
modifier on a text colour (`text-muted-foreground/50`), no `opacity-60` on
text. Hierarchy comes from `--foreground-muted`, size and weight.

**COL-3. Status has three colours and each means one thing.** Success: it
worked, passed, is running normally. Warning: it works but needs attention.
Danger: it failed, is invalid, or will destroy something. A status is never
shown by colour alone: it is a word, with an icon where space allows (`/ui`,
"Status"). Brand blue is not a status.

**COL-4. Anything that carries meaning without being text is at least 3:1**
against what is next to it: the edge of a field, checkbox or switch, the
focus indicator, an icon that is the only label, a chart series.

**COL-5. Surfaces are a ladder, and each step has one job** (the table
above). Two neighbouring surfaces differ in fill and are separated by a
divider. A shadow is never the only thing that separates two surfaces: in
dark it cannot be seen.

**COL-6. Dark is the default, and the page declares its colour scheme.**
Nothing chooses light for someone who has not asked for it: the theme
default is dark, and a surface that cannot read the theme (the desktop app's
own windows) is dark. `color-scheme` is `dark`
under `.dark` and `light` otherwise, so native controls, scrollbars, date
pickers and validation bubbles match. Anything the app does not draw itself
is given a dark treatment explicitly: an embedded frame gets a themed
container, a generated image or figure is generated per theme or framed, a
chart reads the tokens.

**COL-7. Brand blue marks what you can act on.** One filled brand button per
view (ACT-1), links, the selected item, the focus indicator. It is not used
for decoration, headings or emphasis.

**COL-8. Charts use the series colours in order**, starting at `--series-1`.
Axes, gridlines, tick labels and legends use `--foreground-muted` and
`--border-divider`. A series is also told apart by something other than
colour when there are more than three: a label at the line's end, a marker
shape or a dash pattern.

**How it is checked.** `standard.contrast.test.ts` parses `standard.css` and
asserts every pair COL-2, COL-4 and COL-5 promise, in both themes (the list is
`CONTRAST_RULES` in `apps/web/src/lib/ui/contrast.ts`). `/ui` prints the same
ratios measured in the browser. For a page: in dark, look for anything that is
white, anything you have to lean in to read, and any panel whose edge you
cannot find.

## Type

**TYP-1. Two families.** Atkinson Hyperlegible Next for the interface and
Atkinson Hyperlegible Mono for code, identifiers and anything that must align
by character. Both are self-hosted (`@fontsource-variable`); nothing is
fetched from a font service. They were chosen because 0/O, 1/l/I, 5/S and
rn/m cannot be mistaken for one another. Mathematics is KaTeX's own faces. No
third family.

**TYP-2. Seven sizes, and no others.**

| Utility | Size / line | Used for |
|---|---|---|
| `text-display` | 28 / 34 | The name of a page that has nothing above it |
| `text-heading` | 22 / 28 | Page title, section heading |
| `text-title` | 18 / 24 | Dialog title, card title, subsection |
| `text-reading` | 16 / 26 | Chat messages, notes, reports; fields on phones |
| `text-body` | 14 / 20 | The interface: labels, buttons, menus, fields |
| `text-dense` | 13 / 18 | Table cells, help text, compact toolbars |
| `text-caption` | 12 / 16 | Timestamps, counts, badges |

No arbitrary size (`text-[11px]`, `text-[0.8rem]`). Nothing is smaller than
12 px.

**TYP-3. Three weights.** 400 for text, 550 for labels and controls
(`font-strong`), 650 for headings (`font-title`). Headings at `text-title` and above are set with `tracking-tight`.
No italics for emphasis in the interface; bold is for the one thing in a
sentence that must not be missed.

**TYP-4. Fields are 16 px on touch devices**, so iOS does not zoom the page
when one is focused.

**TYP-5. Long-form text is set at `text-reading` and no wider than 72
characters** (`max-w-[72ch]`). This is what a model writes, a note, a report,
a paragraph of explanation. Interface text may run wider.

**TYP-6. Figures in a table or beside one another use tabular numerals**
(`tabular-nums`, or the `data-numeric` attribute). See DAT-2.

**TYP-7. Sentence case, everywhere.** No all-capitals labels, no title case.
Text that does not fit is truncated with an ellipsis and the full text is
available (a `title`, a tooltip, or the row expands); it is never clipped
without one. An identifier is shortened from the end or shown whole, never
with the middle removed from a group of characters someone has to compare.

## Space, shape and size

**LAY-1. Seven distances between things:** 4, 8, 12, 16, 24, 32 and 48 px
(Tailwind `1`, `2`, `3`, `4`, `6`, `8`, `12`). What each is for is on `/ui`.
Inside a single control or a single line of text (a button's padding, the
gap between an icon and its label, a caption under its heading) 2, 6 and
10 px are also allowed. No arbitrary spacing value.

**LAY-2. Three control heights.** 36 px (`--control`) for every button, field
and select. 28 px (`--control-compact`) in dense toolbars and table rows, and
only where a pointer is in use. 44 px (`--control-touch`) on touch devices,
applied by the `pointer: coarse` rule in `standard.css`. A row of controls
has one height.

**LAY-3. A target is at least 24 by 24 px with a pointer and 44 by 44 px on
touch**, including the space that belongs to it.

**LAY-4. Every page works at 390 px wide.** The page itself never scrolls
sideways. A side panel becomes a sheet over the page below `md`; it never
squeezes the content beside it. A bar of tabs that does not fit scrolls, shows
that it scrolls, and keeps the open tab in view. Nothing is reachable only by
hover (A11Y-4).

**LAY-5. Every page opens the same way:** an `h1` with the page's name, one
sentence saying what the page is for, and the page's primary action at the
right (`/ui`, "Page header and tabs"). The browser tab reads
`<Page> · local-llm`.

**LAY-6. Widths.** Reading text 72 characters; a form 40 rem; a table the full
width of its container.

**LAY-7. Regions scroll, the page does not move sideways.** A list inside a
panel scrolls inside the panel, so what sits below it (the user menu, a save
bar) stays reachable. A table's header stays visible while its body scrolls.

**SHP-1. A corner says what kind of thing something is.** 4 px (`rounded`):
checkboxes, inline code. 8 px (`rounded-lg`): buttons, fields, menu items.
12 px (`rounded-panel`): panels, dialogs, menus. Full: badges, avatars,
switches. Not one radius on everything.

**SHP-2. Two shadows, only on floating layers** (menus and popovers; dialogs),
and always together with an edge (COL-5). Panels and cards have no shadow.

## Actions

**ACT-1. One filled brand button per view:** the thing the person most likely
came to do. Other actions are secondary (outlined), quiet (ghost) or links.
A dialog has its own single primary.

**ACT-2. A label says what will happen, as a verb and its object:** "Save
profile", "Delete collection", not "OK", "Submit" or "Confirm". The same words
follow the action through: the button "Rename chat" opens a dialog titled
"Rename chat" whose button is "Rename chat" and whose toast is "Chat renamed".

**ACT-3. Destroying something.** Prefer undo to a confirmation when the
action can be reversed (archive, remove from a list). When it cannot: the
button is filled in the danger colour; a confirmation names the thing and
says what is lost ("Delete “Course notes”? Its 3 files are removed ..."); the
confirming button repeats the action ("Delete collection"), never "OK"; focus
starts on Cancel. In a menu the destructive item is last, below a separator.

**ACT-4. An icon on its own has a name**: an `aria-label`, shown as a tooltip
on hover and on focus. The icon is `aria-hidden`.

**ACT-5. Every control shows five states:** resting, hover, focus (A11Y-1),
busy and disabled. A busy button says what it is doing ("Saving…"), shows a
spinner, sets `aria-busy` and cannot be pressed twice. A disabled control stays
readable and the reason it is disabled is stated next to it or in its
tooltip. An action that cannot work is not offered as if it could.

**ACT-6. Use the shared `Button`.** No `<button>` with its own classes. A new
kind of button is a new variant of the shared component, added here first.

## Forms

**FRM-1. A field has a visible edge (`--border-control`) and a fill
(`--surface-1`).** Its label is above it and always visible. A placeholder is
an example, never the label, and meets COL-2.

**FRM-2. Help is below the field. An error replaces the help**, in the danger
colour with an icon, tied to the field with `aria-describedby`, and the field
is `aria-invalid`. An error says what is wrong and how to put it right
("Enter a whole number of tokens between 512 and 32768"). A field's error is
never only a toast. Validate when the person leaves the field or submits, not
on every keystroke before they have finished.

**FRM-3. A view saves in one of two ways and says which.** *On request:* a
Save button that is disabled until something changed, a line that reads
"Unsaved changes" or "All changes saved", a Discard changes button, and a
guard that asks before navigation loses changes. *At once:* each control
applies when changed and a line beside it confirms it. A view never mixes the
two without labelling the instant ones.

**FRM-4. Use the shared `Select`, `Checkbox`, `Switch`, `Input` and
`Textarea`.** A native control is allowed only where the shared one cannot do
the job (a date), and then it relies on COL-6.

**FRM-5. A switch is for a setting that applies at once; a checkbox is for a
value in a form that is saved.** The label names the setting ("Name new chats
automatically"), not its current state, and does not change when toggled.

**FRM-6. Mark the optional fields**, not the required ones. Group long forms
under headings, most used first; put rarely used settings behind
"Advanced", closed.

## Pages and navigation

**NAV-1. What is shown is in the address.** The open tab, the selected item,
a filter, a sort: reloading the page or pressing Back restores them. A dialog
that is a destination (settings) has an address.

**NAV-2. Sibling views are tabs**, built with the shared `Tabs`. The open tab
is unmistakable, in both themes. The first step of a workflow is the first
tab.

**NAV-3. A link to something that no longer exists says so, in place:** "This
chat no longer exists", with a way onward. It never silently opens something
else.

**NAV-4. Escape closes the topmost layer only.** When a layer closes, focus
returns to what opened it. Dialogs and menus are opened through their trigger
components (`DialogTrigger`, `DropdownMenuTrigger`), which is what makes that
work.

**NAV-5. Everything can be done from the keyboard.** A list of choices
(search results, a model picker, a command palette) moves with the arrow keys
and chooses with Enter. A shortcut exists for the main action of a
keyboard-heavy view and is listed in the shortcuts dialog.

## Tables and figures

**DAT-1. Use the shared `Table`.** Column headings are `th scope="col"`. Text
is left-aligned; figures are right-aligned. A sortable heading is a button.

**DAT-2. Figures.** Tabular numerals; one precision per column; the unit in
the column heading ("Peak VRAM, MiB"), not repeated in every cell; thousands
separated; a missing value is an en dash, never blank and never `0`.
Headings are words, not field names ("Peak VRAM, MiB", not `peak_vram_mib`).

**DAT-3. A status in a table is a status badge** (COL-3): the same word and
colour for the same state on every page.

**DAT-4. An identifier is monospaced, can be copied, and links to the thing it
identifies** when that thing has a page.

**DAT-5. A time is shown relative when recent ("3 minutes ago") with the
exact time available on hover or focus**, and absolute (`2026-11-14 10:24`)
when it is a record.

**DAT-6. On a narrow screen a table scrolls inside its own frame**, or its
rows become stacked label and value pairs. The page does not scroll sideways
(LAY-4).

## Feedback

**FBK-1. A message appears where the thing it is about is.**

| Situation | Where |
|---|---|
| A field is wrong | Under the field (FRM-2) |
| A section failed to load or to act | In that section (STA-4) |
| A condition that lasts (something is off, unreachable, degraded) | An inline message in the page |
| Something the person did has finished | A toast |
| A decision is needed | A dialog |

**FBK-2. Toasts.** Bottom right on a wide screen, top on a phone, and never
over the control that was just used or the message box. A confirmation leaves
after 4 seconds. A failure stays until dismissed, says what failed and why,
and offers the next step. Several results of one action are one toast
("3 files uploaded"), not one each.

**FBK-3. Every action answers.** Something visible changes within 100 ms of a
press (the pressed or busy state), and the result is confirmed: "Copied",
"Saved", the new row appears. An action that fails says so.

**FBK-4. An error says what happened, why if that is known, and what to do.**
It is written for the person using the app: no exception text, no status code
alone, no internal identifier as the message. The technical detail may be
offered behind "Details". It does not apologise and does not blame.

## Loading, empty and failed

**STA-1. Anything that shows data is designed in four states:** loading,
empty, failed and full. All four are checked.

**STA-2. Loading** that lasts longer than about 300 ms shows a skeleton in the
shape of what is coming. A spinner is for inside a button. Loading is never
shown as an empty state or as zeros.

**STA-3. Empty says what belongs here and offers the first step** ("No prompts
yet. A prompt is text you reuse. [New prompt]"). "Nothing matches your
search" is a different message, names the search, and offers to clear it. A
fresh install never says "Try adjusting your search".

**STA-4. Failed is shown in place, with a way to try again.** A failure is
never shown as an empty list, a `0` or a spinner that does not end.

## Overlays

**OVL-1. A dialog has a title, and is one of three widths:** 24 rem for a
confirmation, 32 rem for a short form, 48 rem for a large one. Anything bigger
is a page (NAV-1).

**OVL-2. Dialogs and menus sit on `--surface-2` with an edge and a shadow**,
over `--scrim`. Focus is trapped inside a dialog and returns on close (NAV-4).

**OVL-3. A menu holds actions on one thing:** at most about seven, grouped,
each a verb, with the destructive one last (ACT-3). Its labels do not wrap.

**OVL-4. A tooltip names an icon or shows text that was truncated.** It never
holds information that is not available some other way, because it does not
exist on touch.

## Answers: prose, mathematics and code

**CNT-1. Rendered text looks the same wherever it appears:** chat, notes, the
playground, reports, a knowledge preview. One implementation of rendered
Markdown and one set of prose styles (`.rich-text`), at `text-reading` and
within TYP-5.

**CNT-2. Code blocks have one theme, built from the tokens, in both app
themes.** Code is highlighted by highlight.js and coloured by the `.hljs-*`
rules in `standard.css`; no highlight.js stylesheet supplies colours. The block sits on `--surface-1` with an edge; its header names the
language and offers Copy and Wrap lines. Long lines scroll inside the block.
Inline code is the monospaced face on `--surface-3`.

**CNT-3. Mathematics inherits the text colour.** A display equation wider than
the column scrolls inside its own box and shows that it does.

**CNT-4. Output the app did not write** (an HTML preview, a sandbox's file, a
generated figure) sits in a frame that belongs to the theme (COL-6).

## Canvas

The panel beside a chat that shows a document: a file the model produced, a
page it wrote, a file that was uploaded. Shown on `/ui`. **The design is
decided; the feature is not built.** Its plan is
[docs/plans/canvas.md](../plans/canvas.md).

**CNV-1. What a model provides is a card in the reply and a document in the
canvas, not inline content.** A file, or a page of HTML or SVG, appears in
the reply as a card (an icon for its kind, its name, its kind and size) that
is a button opening the canvas. The card of the open document is marked. An
image keeps a thumbnail on its card.

**CNV-2. The canvas is a column from `md` up and a full-screen sheet below
it.** It never squeezes the chat (LAY-4). As a column it starts at half the
space beside the sidebar, is resized with a separator that also works from
the keyboard, never leaves the chat narrower than 24 rem, and remembers its
width.

**CNV-3. One header, the same for every kind**, left to right: the Preview /
Source switch when the kind has both; the document's name and kind; then the
file list (when the chat has more than one document), Copy with its menu
(Copy, Download), Reload for a live page, Expand, Close. Every icon has a
name (ACT-4). Below `md` everything but the switch and Close folds into one
menu.

**CNV-4. A kind has one renderer**, the same one wherever that kind is shown.
A page of HTML, and an `svg` code block: a sandboxed frame. Markdown: the
chat's rendering, at reading width (TYP-5). Text and code: the standard's code block with line numbers
(CNT-2). CSV: the standard's table (DAT-1, DAT-2). Image (an SVG file
included, always as an image) and PDF: fitted to the canvas. Anything else: its name, its size and a Download button.

**CNV-5. A page the model wrote runs in a sandboxed frame and sits in a
themed surround.** The frame has `allow-scripts` and nothing else, is filled
through `srcdoc`, and is never a `blob:` URL or a new window. The surround is
`--surface-1` with an edge and is what shows before the page paints; it is
never white in dark. The page's own colours are the page's business and are
not altered.

**CNV-6. Editing is a mode of Source and saves on request** (FRM-3): Edit
document, then a bar with "Unsaved changes", Discard changes and Save
document. The editor is the Source view with a caret: the same face, size,
line numbers and highlighting, updated as you type, so nothing moves or
changes colour when editing starts. It has no focus outline: the caret, and
the bar that appears below it, show that it has focus. Entering the editor moves focus into it; saving or discarding
moves focus back to the document's heading. Closing the canvas, switching
document or leaving the chat with unsaved changes asks first.

**CNV-7. The open document is in the address** (NAV-1). A document that is no
longer in the chat says so in the canvas (NAV-3).

**CNV-8. Escape closes the canvas when nothing inside it is open, and focus
returns to the card that opened it** (NAV-4). Opening a document moves focus
to the canvas's heading. While focus is inside a page's frame the keys
belong to the page, so Close is always one Tab away from the frame.

## Words

**WRD-1. Sentence case; plain verbs; no filler.** One job per sentence.

**WRD-2. Name things as the person using them would.** No field names
(`n_gpu_layers` becomes "Layers on the GPU"), no internal ids in a sentence,
no jargon inherited from the fork ("valves", "toolkits", "arena").

**WRD-3. The product is "local-llm"**, written that way everywhere: the tab
title, the sidebar, the sign-in page, the desktop app. Nothing in the
interface names or links to Open WebUI except the notices the licence
requires.

**WRD-4. There is one owner.** No "users", "admins", "contact your
administrator", "shared with you". Features that only make sense with several
people are not offered in the interface.

**WRD-5. Numbers carry their unit**, with a space ("5,571 MiB", "7.6
tokens/s"), and dates are unambiguous (`2026-11-14`, or "14 Nov 2026").

**WRD-6. Icons come from `lucide-react`.** An emoji is never an icon or a
label.

## Accessibility

**A11Y-1. One focus indicator, on everything, never removed:** a 2 px solid
`--focus` outline, offset 2 px (flush on fields, whose edge also turns
`--focus`). No `outline-none` without it; no translucent ring. One
exception: the canvas's editor (CNV-6) shows its caret and no outline.

**A11Y-2. Every control has a name** a screen reader will read: a visible
label tied to it, or an `aria-label` (ACT-4).

**A11Y-3. A page has one `h1`, headings in order, and landmarks:** `header`,
`nav`, `main`.

**A11Y-4. Nothing is available only on hover.** What appears on hover also
appears on focus and is reachable by touch: on touch devices a row's actions
are always shown or are in a menu.

**A11Y-5. The page works at 200% zoom and reflows at 320 CSS px** without
losing content or the main action.

**A11Y-6. Motion is small and answers an action** (MOT-1), and is removed
under `prefers-reduced-motion`.

## Motion

**MOT-1. Two durations:** 120 ms for a change of state (hover, press, a
switch), 200 ms for something that opens or closes. Ease out. Nothing moves
unless the person did something, with two exceptions: a skeleton's pulse and
a spinner.

**MOT-2. `prefers-reduced-motion: reduce` removes transitions and
animations.**

## The desktop app's own windows

The Electron shell loads the server's pages, so the rules above reach it
through `apps/web`. Its own windows (the progress and error dialogs in
`apps/desktop`) are separate HTML. They are always dark, in the standard's
dark colours (`apps/desktop/static/status.css`, as hex, since the two builds
share nothing), because such a window cannot read the theme chosen in the
app. They must also use the standard's type and words (WRD-3) and never let
content overflow a fixed window; they do not yet (#926, #1115).

## Verifying a change

For any pull request that changes what a page looks like or how it behaves:

1. **Look at it in dark first**, then light, at 1440 px and 390 px wide.
   Compare each control with its counterpart on `/ui`.
2. **Use it from the keyboard only**: Tab reaches everything, the focus
   indicator is always visible, Escape closes one layer, focus comes back.
3. **See all four states** of anything that shows data (STA-1), and the error
   state of anything that can fail.
4. **Read every word** against the Words rules.
5. **Run `make test-web`**, which includes the contrast test and the ratchet.
   If the ratchet says a count fell, lower the baseline (see "The ratchet").
6. **Say which rules the change was checked against** in the pull request,
   with dark screenshots. If a rule was departed from, say which and why.

The `ui-standard` project skill (`.claude/skills/ui-standard/`) is this
procedure for an agent, and the `reviewer` agent checks it.

A change that needs something the standard does not have (a colour, a size, a
component, a pattern) adds it **here, in `standard.css` and on `/ui` in the
same pull request**. The three stay in step; `/ui` is how the owner sees what
was decided.

## The ratchet

`apps/web/src/styles/standard.ratchet.test.ts` (part of `make test-web`)
counts, in every source file outside `components/ui`, six patterns the
standard forbids:

| Pattern | Rule | What it catches |
|---|---|---|
| `palette-colour` | COL-1 | `bg-white`, `text-gray-500`, `border-red-400`, ... |
| `text-colour-opacity` | COL-2 | `text-muted-foreground/60`, `text-foreground/50` |
| `arbitrary-text-size` | TYP-2 | `text-[11px]`, `text-[0.8rem]` |
| `outline-removed` | A11Y-1 | `outline-none`, `outline-hidden` |
| `raw-button` | ACT-6 | `<button` instead of the shared `Button` |
| `dark-one-off` | COL-1 | `dark:` variants, which tokens make unnecessary |

It compares the counts with `apps/web/ui-standard-baseline.json`:

- a file with **more** than its baseline fails, so new code meets the rule;
- a file with **fewer** also fails until the baseline is lowered, so progress
  is recorded. Lower it with
  `cd apps/web && UPDATE_UI_BASELINE=1 bunx vitest run src/styles/standard.ratchet.test.ts`,
  which refuses to raise any count, and commit the smaller file.

The aim is zero. A count that stays above zero for good is an exception: an
entry under `exceptions` in the baseline naming the file, the pattern, the
count and the reason, which the test checks still matches the code. **Only
the owner accepts an exception.** When replacing a bypass seems wrong, stop
and put the case to the owner with the justification; do not add the entry
yourself.

## Planned checks

Not built yet:

- An accessibility scan (axe) of `/ui` and the main pages in the Playwright
  suite, in dark and light.
- Screenshot comparison of `/ui` in the Playwright suite, so a change to a
  shared component shows up as a diff.
