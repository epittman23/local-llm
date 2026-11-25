# Interface standard

The rules every page of `apps/web` (and the desktop app's own windows) is
built and checked against. They exist so that a change can be verified, so
that the same mistake is not made on a ninth page after being fixed on
eight, and so that two pages doing the same job look and behave the same.

- **See it:** `/ui` in the running app (`apps/web/src/routes/ui/`) shows the
  rules on the real shared components, in dark, black and light. Each of its
  sections lists the rules it shows; rules about whole pages, words and
  behaviour over time (for example NAV-1 and most WRD rules) are not
  shown there and are checked on the page being changed. Its Canvas section
  shows a design whose viewer (Phases 1 and 2) is built and whose editor is
  planned (see "Canvas").
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
chosen a theme gets dark (`DEFAULT_THEME` in `apps/web/src/lib/theme.ts`)
until the account's saved theme, if any, arrives with its settings and
replaces it, and the desktop app's own windows are always dark. A chosen
theme is saved with the account and cached in the browser for the first
paint.

What that did and did not change:

- Everything built from the shared components and the token names
  (`bg-background`, `text-muted-foreground`, `Button`, `Input`, ...) took the
  standard's colours, type, focus indicator, edges and sizes at once.
- Code that bypasses them did not: a colour class from Tailwind's palette, a
  one-off size, a hand-styled `<button>`. The ratchet (below, "The ratchet")
  counts every one, per file, and only lets the counts fall. They were
  replaced on 2026-11-14 and the count is at its floor: one accepted
  exception. The review's wider issues are indexed in #1116.
- A bypass stays only as an **exception the owner has accepted**, recorded
  with its reason in `apps/web/ui-standard-baseline.json`. Nobody else adds
  one: propose it to the owner with the justification.

Section by section, the review's issues are being fixed against the rules
below. The workspace (Models, Knowledge, Prompts, Skills, Tools, Admin >
Functions, and their editors) was brought to the standard on 2026-11-15.
Admin (Users and Groups, Evaluations, Analytics, Functions, and the server's
settings, which are now pages under Admin > Settings) was brought to it on
2026-11-16. Notes, Calendar, Automations, Channels and the Playground were
brought to it on 2026-11-16 too, and so was Benchmarks (Serve, Live, Tests,
Answers, Report, Compare, Tune and Pre-screen).

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
| `--important` | The Important callout in a rendered answer. Not a status |
| `--canvas` | The inside of a frame showing a page the app did not write. White in every theme |
| `--on-scrim` | An icon or word drawn over `--scrim` |
| `--highlight` / `--highlight-foreground` | Text the writer highlighted (`<mark>`, a note's Highlight), and the words on it. Not a status |
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
Danger: it failed, is invalid, or will destroy something. (The five callouts
in a rendered answer use these three, brand for Note, and `--important` for
Important, which is a callout colour and not a status.) A status is never
shown by colour alone: it is a word, with an icon where space allows (`/ui`,
"Status"). Brand blue is not a status.

**COL-4. Anything that carries meaning without being text is at least 3:1**
against what is next to it: the edge of a field, checkbox or switch, the
focus indicator, an icon that is the only label, a chart series.
A pressed toggle in a toggle group (an automation's weekdays) is the brand
fill (`Button` `default` with `aria-pressed="true"`); an unpressed one is the
outline `Button`.

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
chart reads the tokens. Benchmarks' report figures are drawn by the server
in the theme the page asks for, the dark palette taken from the tokens
(`--surface-1`, `--foreground-strong` and `--foreground-muted`,
`--border-divider`, `--series-1` and `--series-5`); a report made before
that keeps its light figures, which sit framed (CNT-4). The theme is chosen in Settings > General or the user
menu's Theme submenu, both through `useThemeChoice`
(`lib/settings/useThemeChoice.ts`): it applies at once, is cached in
localStorage for the first paint and is saved as `theme` in the account's `ui`
settings.

**COL-7. Brand blue marks what you can act on.** One filled brand button per
view (ACT-1), links, the selected item, the focus indicator. It is not used
for decoration, headings or emphasis.

**COL-8. Charts use the series colours in order**, starting at `--series-1`.
Axes, gridlines, tick labels and legends use `--foreground-muted` and
`--border-divider`. A series is also told apart by something other than
colour when there are more than three: a label at the line's end, a marker
shape or a dash pattern. A chart has a legend naming each series' colour, a
titled y axis with round ticks, and a 'Show as table' toggle that gives every
value to the keyboard and to a screen reader (A11Y-4); the drawing is
`role="img"` with a label summarising it, and a hover tooltip opens away from
the nearer edge so it stays inside the chart. Examples:
`routes/admin/analytics/ChartLine.tsx` (`axisTop` picks the round top) and
`routes/admin/evaluations/ModelActivityChart.tsx`.

A sparkline is the one exception, and only on these terms: it is a single
series inside a key-figure tile, named by the tile, drawn from zero in a
series colour, `role="img"` with a label giving its range and latest value,
and every value it draws is in a table on the same page. Then it may go
without a legend, an axis and Show as table. A key-figure tile is a
`--surface-1` panel with the figure's name, the figure with its unit
(WRD-5), a line saying what it means (headroom, the busy share), and the
sparkline under them (`Kpi` and `Sparkline` in
`routes/benchmarks/LivePage.tsx`). A process's log is a bordered panel: a
header with its state, Follow and Copy over a named scroll region the
keyboard can scroll (DAT-6); lines wrap, warnings and errors are tinted in
their status colours (COL-3), and Follow keeps the newest line in view until
the person scrolls up (`routes/benchmarks/ServeLog.tsx`).

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
when one is focused. `standard.css` applies this to every field on a coarse
pointer (`font-size: max(16px, 1em)`); a field set larger on purpose
(`text-title` and up) keeps its size.

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
touch**, including the space that belongs to it. `Checkbox` and `Switch` reach
44 by 44 on touch through their `::after` hit area, and so does a `Button` of
size `chip` (a value changed in place, such as a user's role), which keeps its
24 px pill and dense type on touch; `CheckboxMark` is a
checkbox's picture for a row that is itself `role="checkbox"`. A `Textarea`'s
least height is its `rows`, in lines, on every pointer and never under 44 px
on touch; set `rows`, not a `min-h-*` class, to make one taller.
Calendar chips and '+N more' are 24 px tall, 44 on touch.

**LAY-4. Every page works at 390 px wide.** The page itself never scrolls
sideways. A side panel is `components/layout/SidePanel.tsx`: a resizable
column where the space holds it and 24 rem of content, otherwise a
full-screen sheet over the page (always below `md`); it never squeezes the
content beside it (CNV-2). On a phone a page's own header buttons go in the
app bar (`ShellBarPortal`, `components/layout/ShellBarSlot.tsx`), so the
phone has one header row; on a short screen they float at the top right,
like the menu button at the left (A11Y-5). A bar of tabs that does not fit scrolls, shows
that it scrolls, and keeps the open tab in view. Nothing is reachable only by
hover (A11Y-4). Section tabs are `components/layout/SectionTabs.tsx`: a strip
that does not fit scrolls sideways, fades at an edge only while tabs are
hidden past it, and scrolls the open tab into view on arrival, on a change of
tab and when a tab changes size.
At 390 a list row keeps only its menu and switch beside it: secondary actions
(New chat, Copy prompt) move into the menu, and the time moves to line 2. An
editor page (a model, skill, tool or prompt) does not repeat its section's
header and tabs below `sm`; its own header has Back, and the app bar names
the page.

**LAY-5. Every page opens the same way:** an `h1` with the page's name, one
sentence saying what the page is for, and the page's primary action at the
right (`/ui`, "Page header and tabs"). The browser tab reads
`<Page> · local-llm`. The header is `components/ui/page-header.tsx`
(`PageHeader`): the h1, the sentence, and the primary action in its `action`
slot, wrapping below the text on a phone. A page that lists things may say
how many there are in its `count` slot: a secondary badge after the h1, never
a bare number and never inside the heading, holding the whole count (a filter
does not change it; the list says '3 of 6', DAT-2), with its noun read aloud
('12 automations'), and left out while it loads. In a section (Workspace, Admin,
Benchmarks, Playground) the h1 is the section's name and a page's own title is
an h2. The tab title comes from each route's `handle.title` in
`AppRouter.tsx`, written by `RootLayout`; a page whose name is only known once
it loads (a chat, a note) sets it with `useDocumentTitle(name)`. Nothing
writes `document.title` directly.

**LAY-6. Widths.** Reading text 72 characters; a form 40 rem; a table the full
width of its container. A settings tab's column is the form width, 40 rem; the
control sits beside its label and wraps under it when narrow.

**LAY-7. Regions scroll, the page does not move sideways.** A list inside a
panel scrolls inside the panel, so what sits below it (the user menu, a save
bar) stays reachable. A table's header stays visible while its body scrolls.
The sidebar is exactly as tall as the window: its header, New chat and
Search, the destinations and the user row stay put, and only the chat list
between them scrolls, never sideways. Nothing in a scrolling region is wider
than the region, since focus can scroll even an `overflow-x: hidden` box.
From 768 px the sidebar starts open and is remembered per browser once opened
or closed. Closed, it is a 48 px rail (`SidebarRail` in
`components/layout/Sidebar.tsx`): Open sidebar, New chat and Search at the top
and the account menu at the foot, each an icon named by its tooltip, so
closing the sidebar loses none of them. Close sidebar and Open sidebar hand
focus to each other. Phones have the drawer instead, wide enough (20 rem, or
85% of a narrower screen) that each destination's name fits beside its icon,
since touch has no tooltips (OVL-4).

**SHP-1. A corner says what kind of thing something is.** 4 px (`rounded`):
checkboxes, inline code. 8 px (`rounded-lg`): buttons, fields, menu items.
12 px (`rounded-panel`): panels, dialogs, menus. Full: badges, avatars (`ProfileAvatar`),
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
Discarding typed work is destructive too: 'Discard changes?' confirms with a
danger button, in the editors and in Settings alike.

**ACT-4. An icon on its own has a name**: an `aria-label`, shown as a tooltip
on hover and on focus. The icon is `aria-hidden`.

**ACT-5. Every control shows five states:** resting, hover, focus (A11Y-1),
busy and disabled. A busy button says what it is doing ("Saving…"), shows a
spinner, sets `aria-busy` and cannot be pressed twice. A disabled control stays
readable and the reason it is disabled is stated next to it or in its
tooltip. An action that cannot work is not offered as if it could.
A choice whose feature is off on this install stays listed and disabled, and
its help line says where to turn it on ('Image generation is off in Admin >
Settings > Images.'). A disabled switch, by its own `disabled` or a disabled
fieldset around it, keeps showing its state: a divider edge, and the on track
or the off knob in the disabled grey.
A whole tab or page whose feature is off is hidden instead, as the
Ollama-only parameters are (S3-D3): the Playground's Images tab shows only
while image generation is on, and a direct link to it says 'Image generation
is off', says where to turn it on, and disables Run.

**ACT-6. Use the shared `Button`.** No `<button>` with its own classes. A new
kind of button is a new variant of the shared component, added here first.
A value that opens its own menu beside a name (a user's role in Admin >
Users) is a `secondary` button of size `chip` (LAY-3).

**ACT-7. A whole row that opens something is a `RowButton`**
(`components/ui/row-button.tsx`): a list entry with an image or icon, a name
and a second line. It is full width, highlights on hover, and marks the open
or selected row with `aria-current`. `Button` is for single-line controls
and is not stretched into a row.

**ACT-8. A picture you press is an `ImageButton`**
(`components/ui/image-button.tsx`): a profile image that opens an upload. The
picture fills it; an icon appears over a scrim on hover and on focus; it has
an `aria-label`.

**Profile pictures.** A model's or user's picture is the shared
`ProfileAvatar` (`components/ui/avatar.tsx`), always round. Without a picture
of its own (none, a stored default such as `/user.png`, or one that fails to
load) it shows the name's initials, first and last word, on `--surface-3` in
`--foreground-strong`: never a stock image. It is decorative (hidden from
assistive technology) because the name is beside it; pass `label` when it
stands alone. A stored default is never fetched, and the picture endpoints
answer 404 for one.

## Forms

**FRM-1. A field has a visible edge (`--border-control`) and a fill
(`--surface-1`).** Its label is above it and always visible. A placeholder is
an example, never the label, and meets COL-2.

**FRM-2. Help is below the field. An error replaces the help**, in the danger
colour with an icon, tied to the field with `aria-describedby`, and the field
is `aria-invalid`. An error says what is wrong and how to put it right
("Enter a whole number of tokens between 512 and 32768"). A field's error is
never only a toast. Validate when the person leaves the field or submits, not
on every keystroke before they have finished. A required choice is never
left empty by the person: adding a model opens its picker at once, and leaving
the picker without a choice removes the empty slot. A slot that arrives empty
(an old saved chat, or no model available) is `aria-invalid`, with the help
line 'Choose a model or remove this one' under it, and sending opens that
picker instead of a toast. The line under a field is
`components/ui/field-message.tsx` (`FieldMessage`, with `fieldProps(id,
{ error, help })` for the field's `aria-describedby` and `aria-invalid`).
A form is `noValidate` and never shows the browser's bubbles; one without
validation of its own uses `lib/ui/useFieldErrors(problems, order)`, which
shows a field's error once it is left or the form submitted, clears it when
put right, and on submit focuses the first wrong field. A settings tab checks
on Save with `useSettingErrors(problems)` (`components/settings/controls.tsx`,
problems by the field's element id) and passes its `errors` to
`SettingsForm`: `SettingField`, or `SettingRow` with `fieldId`, shows the
error in place of the help and the control is `aria-invalid`. A wrong field
that is not on the page (another engine's) is said in a toast instead. A
field the API does not require is marked '(optional)', never `required`.
A schedule says its next runs under itself ('Next: …' with the time zone),
and a rule the scheduler refuses is said there in words, with an example. In
a dialog, `useFieldErrors(problems, order, { inDialog: true })` shows a left
field's error once focus has moved on, so the dialog's focus trap does not
send Tab past the next field.

**FRM-3. A view saves in one of two ways and says which.** *On request:* a
Save button that is disabled until something changed, a line that reads
"Unsaved changes" or "All changes saved", a Discard changes button, and a
guard that asks before navigation loses changes. *At once:* each control
applies when changed and a line beside it confirms it. A view never mixes the
two without labelling the instant ones. Implemented by
`components/ui/save-bar.tsx` (`SaveBar`): the status line, Discard changes and
Save. On a create page (`creating`) nothing exists until Save, so before the
first change the line reads "Nothing to save yet", never "All changes saved". In Settings, `SettingsForm` takes `dirty`/`onDiscard` and the dialog
asks 'Discard changes?' before a tab switch, close, Escape or Back loses
them; an at-once tab passes `savesAtOnce` and confirms each control with
`SavedNote`. An at-once tab that passes `saving` holds its controls (a
disabled fieldset) and says "Saving…" under its heading while a save is in
flight, so a second change never overlaps the first; focus goes back to the
control that had it. Every Admin settings tab is one or the other: Connections and
Integrations save each change at once (one toast, or `toastFailure` with the
old value put back, holding the tab while each saves); the rest show the `SaveBar` (Pipelines for the selected
pipeline's valves), except Database, which has nothing to save. On an Admin settings page
the page's one guard (`SettingsPageHost`) asks before another tab or any
navigation; a tab reports through `useSettingsHost().setDirty`, and anything
it embeds with its own guard turns that off while hosted. The model editor,
embedded in Admin > Models, reports through `onDirtyChange` and asks from its
own Back through `useConfirmLeave`, which is `useUnsavedChanges` without the
router blocker (a router obeys one blocker, the last registered). In a
settings tab, lists edited in a dialog (arena models) change the draft and are
sent with the tab's Save.
On a page, `lib/ui/useUnsavedChanges(dirty, { message })` is the guard. It
asks 'Discard changes?' ('Keep editing' / 'Discard changes') before in-app
navigation, the browser's Back or Forward, or a change of `?id=` would lose
changes (not a change of `?settings=` alone: the Settings dialog opening or
closing over the page leaves nothing), and has the browser ask before a reload or tab close (not in the
desktop app). `dirty` compares values against a baseline; it never counts
change events. Render its `dialog`. Call `allowNext()` only after a save has
resolved, immediately before navigating away; set before the save, a failed
save would let the next leave through unasked. A way out that is not a
navigation (Admin > Models swaps the model editor out for its list in place)
goes through `confirmLeave(action)`: it runs `action` at once while nothing is
unsaved and asks the same question first otherwise; an `action` that
navigates is let through, so it never asks twice. An editor that a page may
swap out in place (the model editor) calls it from its own Back.
A form dialog holds a draft the same way: Escape, the scrim, × and Cancel
close it through `confirmLeave`, which asks while the dialog's values differ
from what it opened with; a save or a delete closes it without asking.
Admin's connection, tool server, terminal, user, group and arena model
dialogs use `useConfirmLeave` (their pages already have a guard), the
workspace's create dialogs `useUnsavedChanges`.

**FRM-4. Use the shared `Select`, `Checkbox`, `Switch`, `Input` and
`Textarea`.** A name that may be long (a tool's, a skill's) is
`LineTextarea`: one line that wraps to show the whole name, growing to as
many lines as it takes, where Enter does what it does in an input (submits through the form's
default button, unless that is disabled) and no line break gets in; an
`Input` would clip it.
A native control is allowed only where the shared one cannot do the job (a date), and then it relies on COL-6. A native `<select>` that
remains gets the field's edge, fill, `rounded-lg` and least height
(`--control-compact`, 44 px on touch) from `standard.css`, so it needs no
classes of its own; Radix's hidden form select, list boxes and a select inside
a composite field are skipped.
`SelectField` (`components/settings/formFields.tsx`) maps an empty-string
option to a stand-in value for Radix and back, so the stand-in never reaches
stored data.
Two to five mutually exclusive choices that apply at once are a
`SegmentedControl` (`components/ui/segmented-control.tsx`): words with
optional line icons, a radio group, arrow keys to move and choose; on a phone
the segments share one row. It may also hold a required choice with nothing
preselected that a separate action confirms (the Share dialog's 'Who can open
the link', then Create and copy link): a value no option has leaves every
segment unchosen. A disabled segment gives its reason in the help line under
the control (ACT-5).

**FRM-5. A switch is for a setting that applies at once; a checkbox is for a
value in a form that is saved.** The label names the setting ("Name new chats
automatically"), not its current state, and does not change when toggled.
A group's permissions are checkboxes, since the group is saved
(`routes/admin/users/Permissions.tsx`): the box, then the label and a
one-line description, the label toggling the box. A switch's help is static
and says what turning it on does, with its trade-off; it never narrates the
current state. A warning that depends on a change (reindex after a new
embedding model) shows only once that change is made.

**FRM-6. Mark the optional fields**, not the required ones. Group long forms
under headings, most used first; put rarely used settings behind
"Advanced", closed. Example: the model editor, with the sections Identity,
Behaviour, Knowledge and tools, Capabilities, and Advanced (closed), and a
`SaveBar` footer.
A folded group is the one disclosure row, `Disclosure` in
`components/settings/formFields.tsx`: a full-width row with the group's
name, an optional second line, optional meta (a count, a 'changed' badge)
and a chevron that turns while open; it is named by all it shows, title
first, so its name holds its visible label (WCAG 2.5.3), and sets
`aria-expanded` and `aria-controls`. Opened, its panel
grows in the scroller around it inside a `rounded-lg border p-3` frame,
never an inner max-height, and a click that opens it brings the row and
panel into view (`scrollIntoView({ block: 'nearest' })`, `scroll-mt-3` so the
focus outline shows, no smooth scrolling); opened by its holder (a filter, a
form opening Advanced at an error) it keeps the scroll where it is. A long
list of settings in one form folds into named groups; each group's heading
shows how many it holds and how many differ from the defaults, and a filter
box finds a setting by its label or description and opens the groups that
hold one (a group's permissions).

## Pages and navigation

**NAV-1. What is shown is in the address.** The open tab, the selected item,
a filter, a sort: reloading the page or pressing Back restores them. A dialog
that is a destination (settings) has an address. Settings keeps
`?settings=<tab>` in the address while it is open: a tab change replaces it,
opening from the app adds a history entry, closing removes it, Back closes the
dialog.

**NAV-2. Sibling views are tabs**, built with the shared `Tabs`. The open tab
is unmistakable, in both themes. The first step of a workflow is the first
tab. A vertical tab list (Settings) is `components/settings/SettingsNav.tsx`:
one tablist, roving focus (Up, Down, Home, End; Enter opens), captions hidden
from assistive technology, a repeated name carrying its group ('Server:
General'). Below 768 px it becomes two levels: the list with search, then the
tab with a way back. A section's sub-tabs (Admin > Users, Evaluations) are a
strip above the content (`SubTabs`, the `SectionTabs` look), a navigation
landmark, with counts as secondary badges. A show/hide toggle is not a menu trigger: when expanded
it keeps the ghost button's resting look (`aria-expanded:bg-transparent`).
A section whose tabs are steps of one workflow groups them in that order:
`SectionTabs` takes a `group` per tab and draws a divider line, hidden from
assistive technology, between groups (Benchmarks: Pre-screen, Tune | Serve,
Live, Tests | Compare, Answers, Report). Such a section may end its strip
with a status chip that says what is running, in order of precedence, and
links to the page that owns it: a success `Badge` with an icon ('Serving
qwen38 · c98ef02c', the id in mono), or a secondary 'Nothing running' that
is not a link. It is a `role="status"` region, polls every 10 s, and on a
narrow screen wraps above the strip (`StatusChip` in
`routes/benchmarks/BenchmarksLayout.tsx`).

**NAV-3. A link to something that no longer exists says so, in place:** "This
chat no longer exists", with a way onward. It never silently opens something
else. `components/common/Gone` is the in-place panel: what is gone as a
heading, why it may be, and ways onward, with the tab saying so too ("Chat not
found"). It is for a definite answer that nothing is there (the server's
NOT_FOUND detail, `isNotFound`); a failure to load is `LoadFailed` instead
(STA-4).

**NAV-4. Escape closes the topmost layer only.** When a layer closes, focus
returns to what opened it. The shared `DialogContent`, `AlertDialogContent`
and `SheetContent` return focus to the element that had it when they opened
(or to a menu's trigger, when a menu item opened them), so a dialog opened
from state needs no `DialogTrigger`. Settings ignores an Escape while focus is
in a layer above it. A side panel shown as a column is not a layer: Escape
closes it only while focus is inside it and nothing inside it took the key
first, so the page's own Escape and the layers above it are left alone.
Opening it moves focus to its heading; closing it returns focus to what
opened it (a menu's trigger, when a menu item did).

**NAV-5. Everything can be done from the keyboard.** A list of choices
(search results, a model picker, a command palette) moves with the arrow keys
and chooses with Enter. A shortcut exists for the main action of a
keyboard-heavy view and is listed in the shortcuts dialog. Lists you choose
from by keyboard are `components/ui/command.tsx` (cmdk): the field keeps
focus, the arrow keys move a highlight, Enter chooses, and the first item is
highlighted whenever the list fills, also when its items come from the server.
The model picker is `routes/chat/ModelSelector.tsx` on `Command`: rows are
left aligned, the model's name over a muted second line (its description, or
a workspace entry's base model in mono), and the current one is checked.
Ctrl+Shift+M (Open model selector) opens the picker on screen;
`openModelPicker()` opens it from code.
A toolbar of tools (the note editor's formatting bar) is one tab stop: the
arrow keys, Home and End move between tools, Escape returns to the text it
acts on, and each tool's name and shortcut are in its Tip ("Bold, Ctrl+B").
`lib/ui/useToolbarKeys` does the keys for any `role="toolbar"`.
A grid of days (the calendar's month and mini month) is one tab stop: the
arrow keys move a day or a week, Home and End go to the ends of the week,
and moving past the edge pages the month (`useRovingDays` in
`routes/calendar/CalendarViews`). Event chips sit beside the day's button,
never inside it. `/ui` shows both under Pages and navigation.

## Tables and figures

**DAT-1. Use the shared `Table`.** Column headings are `th scope="col"`. Text
is left-aligned; figures are right-aligned. A sortable heading is a button.

**DAT-2. Figures.** Tabular numerals; one precision per column; the unit in
the column heading ("Peak VRAM, MiB"), not repeated in every cell; thousands
separated; a missing value is an en dash, never blank and never `0`.
Headings are words, not field names ("Peak VRAM, MiB", not `peak_vram_mib`).
A page that renders columns from an API keeps a header map from each key to
its words, unit after a comma, and its one format (`compareFormat.ts`'s
`columnSpec`), with the key title-cased only as a fallback.
While a search or filter narrows a list, the tab keeps the whole count and
the list says '3 of 6 <things>' (`ListMatchCount` in
`components/common/ListChrome`).

**DAT-3. A status in a table is a status badge** (COL-3): the same word and
colour for the same state on every page. The status badge is the shared
`Badge` with `variant="success" | "warning" | "danger"` (the status colour on
`--surface-3`) and an icon marked `data-icon="inline-start"`; a neutral state
is `variant="secondary"` with no icon. A list row's state (Hidden, Off, Read
only) is a `Badge variant="secondary"` on its first line, never opacity on the
row or its picture (COL-2). Admin's lists show theirs the same way (Hidden,
Off, Default, Pinned, Pipelines, OpenAPI, MCP); with one account the Pinned
badge is hidden. A benchmark item's graded outcome is `OutcomeBadge`
(`routes/benchmarks/OutcomeBadge.tsx`), one word per outcome on Tests,
Answers and Compare: `pass` is a success "passed"; `fail_assert` "assert
failed", `fail_error` "error", `fail_timeout` "timed out" and `no_code` "no
code" are danger; `skipped` is a secondary "skipped".

**DAT-4. An identifier is monospaced, can be copied, and links to the thing it
identifies** when that thing has a page.

**DAT-5. A time is shown relative when recent ("3 minutes ago") with the
exact time available on hover or focus**, and absolute (`2026-11-14 10:24`)
when it is a record.

**DAT-6. On a narrow screen a table scrolls inside its own frame**, or its
rows become stacked label and value pairs. The page does not scroll sideways
(LAY-4). The shared `Table` scrolls inside its own frame and shades the edge
that hides columns. Give it `aria-label`: the scrolling container becomes a
named region and, while it overflows, a tab stop the arrow keys scroll.
`stickyFirstColumn` keeps the first column in view; its cells are opaque in
`--table-surface` (set it if the table does not sit on `--page`) and take
the row's hover tint. A sortable column's heading is `TableSortHead`: the
shared sort button, with `aria-sort` on the open sort's heading only. A row
that opens something is `TableRow onOpen`: a click anywhere on it opens it,
except on a control in it (a button, link, field or a menu item portalled
out of it), and its name cell holds a button calling the same open, which
is the keyboard's way in (NAV-5); when what it opens is another page, that
cell is a link to it instead (Compare > Failures opens the item in Answers).
`stickyHeader` keeps the column headings in view while the rows scroll
(LAY-7): the frame is then at most `maxHeight` tall (`70dvh` unless given),
and never taller than the area the page scrolls in (but at least 12rem), so
the whole frame fits on screen and reaching its last rows never scrolls its
headings away. It scrolls both ways, since a frame that scrolls sideways
stops the page's own scroll from holding a heading. Its focus ring (A11Y-1)
is drawn on an overlay above the sticky headings and first column, which
would cover an outline on the region itself. The headings are opaque in
`--table-surface` with their rule drawn on them; with `stickyFirstColumn`
the corner heading stays above both. Rows hidden below make the named region
a tab stop too. Use it on a table long enough to scroll its headings out of
view (Compare > Failures, Tune's rounds and candidates, Pre-screen's
candidates and points). Tables in rendered answers use it too,
with Copy table (tab-separated, so it pastes as cells) and Download CSV in an
always-visible toolbar above the table, never over a heading (A11Y-4). A
scroll region outside `Table` (a code listing, an equation) uses
`useScrollEdges` with the `scroll-edges` frame and `scroll-region` scroller
in standard.css: the same shaded edges, a thin scrollbar where the platform
allows, focus drawn inside.

**DAT-7. A time grid** (Calendar week and day) places each event by its
start and end on the local clock: its height is its length, never under
24 px (44 on touch). Events that overlap share the width in columns. Today's
column is `--surface-1` with a 2 px `--brand` now-line. The grid opens at
7 AM, or an hour before now when today is shown, and the day names and the
all-day band stay in view above the hours. All-day and multi-day events are
bars in that band, or across their days in a month. An automation's runs on
one day are one item with a count ('Daily digest ×24', read as '24 runs'),
listed after your own events. The layout is `layoutDay` in
`routes/calendar/calendarModel.ts` (`/ui`, "A time grid").

## Feedback

**FBK-1. A message appears where the thing it is about is.** A lost live
connection is `components/layout/ConnectionBanner`: a fixed pill at the top,
below the phone's top band (FBK-2), while the socket is down for more than
2 s, then one 'Reconnected' toast.
Every reconnect refetches what is on screen.
A save error in an editor stays inline above its footer, never a toast over
Save (`components/common/EditorError.tsx`).
A connection's URL field has Test connection beside it
(`ConnectionUrlField` in `components/settings/formFields.tsx`). It checks for
http:// or https:// first, then says under the URL what it found: 'Reachable:
N models' in the success colour, or the server's reason in the danger colour
with the field `aria-invalid`. An edit clears the result.
A long job's progress is a header over its output, where the job is (Tests'
suite run): a progress bar, 'i of n' items, the pass rate so far, skips,
the elapsed time and an estimate of the time left, and a link to the result
(the suite run in Answers). Its log follows new items unless the person has
scrolled up.

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
("3 files uploaded"), not one each. Implemented once in
`components/ui/sonner.tsx`: position follows the width live (bottom-right from
768 px, top-centre below). Below 768 px toasts start 8 px under the top band
and under the connection banner while it shows, so they cover neither. The top
band reaches down to the lowest of the app bar (or its floating menu button
where the bar folds) and the visible part of the page's own header, marked
`data-page-top` (the shared `PageHeader` at `h1`, the chat's model row): a
toast is never over the control just used, and those rows hold the controls a
page starts with. A header scrolled out of view stops counting.
`components/layout/topBand.ts` keeps it in `--top-band-bottom` (0 from 768 px,
where nothing is watched) and ConnectionBanner its height in
`--connection-banner-space`. On a wide screen toasts rise above any
`data-composite-field` (the message box) or `data-keep-clear` element (the
SaveBar, so a failure never covers Save) whose top edge is in the lower half
of the viewport, with 8 px clear. Every toast has a close button with a 24 px hit area (44 px
on touch). A toast's action (Undo, Open) is drawn as the small outline button
(ACT-1), by the conformance layer in `standard.css`, not as sonner's filled
pill. `toast.error` and `toast.warning` default to no time limit and an
id taken from the message, so a repeated failure updates one toast. A caller's
`duration` or `id` still wins. Once a session has expired, failure toasts are
held back until the next sign-in; the sign-in page's inline message explains
them.
Several results of one action are worded: 'Added "<name>"' for one; '4 files
added'; '3 added, 1 failed'; '2 files couldn't be added'; 'N already here' for
skipped duplicates. A failure toast's description points to the rows that
say why ('The list shows why each one failed, with Retry.').

**FBK-3. Every action answers.** Something visible changes within 100 ms of a
press (the pressed or busy state), and the result is confirmed: "Copied",
"Saved", the new row appears. An action that fails says so. A copy control
uses `useCopy` (`lib/ui/useCopy.ts`): it says "Copied" for 1.5 s, and a copy
the browser refuses says so in a toast.

**FBK-4. An error says what happened, why if that is known, and what to do.**
It is written for the person using the app: no exception text, no status code
alone, no internal identifier as the message. The technical detail may be
offered behind "Details". It does not apologise and does not blame. A failed
reply is `routes/chat/ErrorReply.tsx`: the heading 'The model didn't answer',
the provider's own words, a next step for the causes it recognises (a refused
API key: Admin > Settings > Connections; an error naming the local server's
port, 127.0.0.1:8090: Benchmarks > Serve), and Retry and Try another model. An error-only reply offers no Copy,
Edit, Read aloud or rating. Run on a host without the sandbox says "The code
sandbox isn't set up on this machine", what it needs, and links the guide;
Run is then disabled for the session with that reason (ACT-5).
A failure toast is `toastFailure(message, error)` in
`components/common/failureToast.tsx`: the message says what failed, and the
server's own words (`errorText`) sit behind a closed 'Details'
(`ErrorDetails`), never as the toast's visible text.
The Playground shows a failed run with the same `ErrorReply`, under the
message that caused it, with Retry; no toast.

## Loading, empty and failed

**STA-1. Anything that shows data is designed in four states:** loading,
empty, failed and full. All four are checked.

**STA-2. Loading** that lasts longer than about 300 ms shows a skeleton in the
shape of what is coming (a table's is `components/common/TableSkeleton`). A spinner is for inside a button. Loading is never
shown as an empty state or as zeros. While the app starts, the boot splash
(the name on the page colour, a spinner after 400 ms, 'Still waiting for the
server… Retry' after 8 s) stands in for the page, never a bare 'Loading…'.

**STA-3. Empty says what belongs here and offers the first step** ("No prompts
yet. A prompt is text you reuse. [New prompt]"). "Nothing matches your
search" is a different message, names the search, and offers to clear it. A
fresh install never says "Try adjusting your search". Implemented by
`components/common/ListChrome`'s `ListEmptyState`. With nothing searched or
filtered it shows 'No <things> yet', one line saying what a thing is, and the
first step (`action`). With a search it shows 'Nothing matches "<q>"' and
Clear search; with only filters, 'Nothing matches these filters' and Clear
filters. Either one clears the search and the filters.

**STA-4. Failed is shown in place, with a way to try again.** A failure is
never shown as an empty list, a `0` or a spinner that does not end. Use
`components/common/LoadFailed` (`what`, `error`, `onRetry`, `retrying`). It is
shown in place of the list and says 'Couldn't load <what>'. The cause is in
plain words (offline, no answer, or an error from the server), the server's
own message sits behind 'Details', and it offers 'Try again'.
A single row that failed (an upload) stays in place: a danger icon, its name,
the reason in plain words, the server's text behind Details, and Retry and
Dismiss; Dismiss alone when retrying cannot help (duplicate content). It is
kept for the visit, not across a reload. At 390 its buttons wrap under the
reason. Example: `routes/workspace/knowledge/KnowledgeFileList.tsx`.
A section's state (a service it depends on: ready, checking, not ready, the
check failed) is a `StatusNotice` (`components/ui/status-notice.tsx`) at the
top of the section: an icon and a title in its status colour (COL-3), what it
means and what to do as sentences, one action ('Check again'), and the
server's own words behind 'Details'. It is not help text and never shares
help text's grey. Example: Admin > Settings > Code Execution's sandbox.

## Overlays

**OVL-1. A dialog has a title, and is one of three widths:** 24 rem for a
confirmation, 32 rem for a short form, 48 rem for a large one. A two-pane
dialog, a tab list beside a 40 rem form (Settings), is 64 rem. Anything bigger
is a page (NAV-1). A dialog is never taller than the viewport less 1 rem each
side; content taller than that scrolls inside it. A tall form puts its fields
in `DialogBody`, so the header and the footer's buttons stay pinned; a
`<form>` may hold the body and its buttons (Admin's connection, tool server,
terminal and knowledge source dialogs), so Enter still submits it.

**OVL-2. Dialogs and menus sit on `--surface-2` with an edge and a shadow**,
over `--scrim`. Focus is trapped inside a dialog and returns on close (NAV-4).

**OVL-3. A menu holds actions on one thing:** at most about seven, grouped,
each a verb, with the destructive one last (ACT-3). Its labels do not wrap.
A reply's More actions menu: Edit, Read aloud, Continue, the model's own
actions, a separator, then Delete. A menu entry that is a setting is a
checkbox item: a fixed label, a one-line description, a check while on
(Admin > Models' row menu).

**OVL-4. A tooltip names an icon or shows text that was truncated.** It never
holds information that is not available some other way, because it does not
exist on touch.

## Answers: prose, mathematics and code

**CNT-1. Rendered text looks the same wherever it appears:** chat, notes, the
playground, reports, a knowledge preview. One implementation of rendered
Markdown and one set of prose styles (`.rich-text`), at `text-reading` and
within TYP-5.
A highlight (`<mark>`) is `--highlight` under `--highlight-foreground` in
every theme, held by the contrast test to 7:1, the same promise as body text.

**CNT-2. Code blocks have one theme, built from the tokens, in both app
themes.** Code is highlighted by highlight.js and coloured by the `.hljs-*`
rules in `standard.css`; no highlight.js stylesheet supplies colours. The block sits on `--surface-1` with an edge; its header names the
language and offers Wrap lines (one setting for every block, remembered),
Download (named by the language) and Copy; Collapse appears only for a block
over 25 lines, and a collapsed block shows 25 lines and ends in "Show all N
lines". Where the block is narrower than 28 rem the header's actions are
named icons with tooltips (ACT-4). Long lines scroll inside the block, which
is a figure named "<language> code", a tab stop while it overflows, with the
edge that hides content shaded (`scroll-edges`, DAT-6).
Inline code is the monospaced face on `--surface-3`.
The code editor (`components/common/CodeEditor`) is a field: the control edge
on `--surface-1`, a visible label that also names its content ("Tool code"),
and the help line 'Tab indents. Press Esc, then Tab, to leave the editor.'
tied with `aria-describedby`. Code that isn't valid Python is not saved: its
line is tinted, its number turns danger, it scrolls into view, and 'Line N,
column M: this line isn't valid Python.' replaces the help line, with the
parser's message behind Details. Code from elsewhere (a clone, a link or a
file) is acknowledged once, in one sentence naming its source
(`components/common/codeSource.ts`); code written in the editor is not.

**CNT-3. Mathematics inherits the text colour.** Black or white written by
the model (`\color{black}`) is drawn in the text colour where it would
vanish (`--math-black` in dark and black, `--math-white` in light). A display
equation wider than the column scrolls inside its own box, shades the edge
that hides the rest (`scroll-edges`, DAT-6), and is a tab stop while it
overflows; on its own line it is a figure named "Equation".
In the note editor a formula is typeset over its source and the source
returns while the caret is in it; the stored text is never converted.

**CNT-4. Output the app did not write** (an HTML preview, a sandbox's file, a
generated figure) sits in a frame that belongs to the theme (COL-6). The
inside of a frame showing a page is `bg-canvas`, white in every theme: a page
with no background of its own assumes white, and a dark one would put its
black text on dark. The white is the page's, so it is framed (an edge, the
themed surround) and never fills a panel edge to edge. A generated raster
figure (a benchmark report's plots) is drawn per theme by the server; one
made before that sits framed the same way (COL-6). An HTML preview loads nothing from the
network (CNV-5).

**CNT-5. A reply shows its steps where they happened.** Between the texts a
model writes, each step it took (a thought, a command, a file written, a
search, a question) is one line on a divider rule that says what it did: the
command, "Wrote /path", "Thought" with how long. A fact follows the title
("11 s", "exit 1"), and the step's state is a word where it is not plainly
done (COL-3): Running, Queued, Failed, Waiting for approval, Waiting for
your answer, No answer, No result, Denied. A line with nothing more to show
is text, not a disabled control. Otherwise it opens to the reasoning, what
the step was given and what came back (output and errors apart, a file in
its language, inline images in a frame, CNT-4). Two or more steps in a row
are one chain, collapsed to a line naming the step it is at (the running
one, else one waiting on the person, else the last) with how many steps it
holds; a chain with a call to approve stays open. While the reply is
written, its spinner is one 20 px thinking orb (`thinking-orbs`) below
everything shown so far, animated by what the reply is doing and named for
it ("Running a command"), a still frame under reduced motion (MOT-2), and
gone while the reply waits on the person. *Awaiting the owner's decision:*
the orb is an exception to MOT-1 (as the reply's spinner) and to COL-1 (it
draws its own monochrome ink for the theme, not a token); until that is
settled, neither exception is part of the standard.

## Canvas

The panel beside a chat that shows a document: a file the model produced, a
page it wrote, a file that was uploaded. Shown on `/ui`. **The design is
decided. Phase 1, the side-panel shell (`components/layout/SidePanel.tsx`),
and Phase 2, the viewer (`routes/chat/canvas/`), are built; editing (Phase
3, CNV-6) is not, and `/ui` mocks it.** Its plan is
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
width. Phase 1, built: the panel is `components/layout/SidePanel.tsx`. It is
a column when the space beside the sidebar holds the panel's minimum width
plus 24 rem of chat; otherwise, and always below `md`, it is the shared
`Sheet`, full screen (768 px with the sidebar open gives a sheet; with the
rail, or at 1024 px, a column). Each occupant has its own default and
minimum width, remembered per occupant: Controls 20 rem (minimum 18 rem),
the preview 28 rem (minimum 20 rem). The separator takes a pointer drag,
ArrowLeft and ArrowRight (16 px, 64 px with Shift), Home for the widest and
End for the narrowest, and states its width. The canvas starts at half the space (`SidePanel`'s `defaultWidth`
takes a function of the space), and its Expand button gives it all the space
beside the sidebar (`expanded`, which has no separator; the chat stays
mounted, hidden). `focusOnOpen` is false when the canvas opens by itself.

**CNV-3. One header, the same for every kind**, left to right: the Preview /
Source switch when the kind has both; the document's name and kind; then the
file list (when the chat has more than one document), Copy with its menu
(Copy, Download), Reload for a live page, Expand, Close. Every icon has a
name (ACT-4). Below `md` everything but the switch and Close folds into one
menu.

**CNV-4. A kind has one renderer**, the same one wherever that kind is shown.
A page of HTML, and an `svg` code block: a sandboxed frame that loads nothing from the network (CNV-5). Markdown: the
chat's rendering, at reading width (TYP-5). Text and code: the standard's code block with line numbers
(CNT-2). CSV: the standard's table (DAT-1, DAT-2). Image (an SVG file
included, always as an image) and PDF: fitted to the canvas. Anything else: its name, its size and a Download button.

**CNV-5. A page the model wrote runs in a sandboxed frame and sits in a
themed surround.** The frame has `allow-scripts` and nothing else, is filled
through `srcdoc`, and is never a `blob:` URL or a new window. The surround is
`--surface-1` with an edge and is what shows before the page paints; it is
never white in dark. The page's own colours are the page's business and are
not altered. The page runs under a content-security policy (a sandbox output
gets it from the server, a fenced block in the browser through
`lib/chat/htmlPolicy.ts`), so a preview loads nothing from the network: a CDN
script, style or font does not arrive, and a form, `alert`, `confirm` or
`prompt` does nothing.

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
no jargon inherited from the fork ("valves", "toolkits", "arena"): a tool's
or function's valves are its "Settings". Model
parameters are named in words with the API name beside them in mono, hidden
from the accessible name: 'Max tokens · `max_tokens`', 'Layers on the GPU ·
`num_gpu`'.

**WRD-3. The product is "local-llm"**, written that way everywhere: the tab
title, the sidebar, the sign-in page, the desktop app. Nothing in the
interface names or links to Open WebUI except the notices the licence
requires. The mark is `components/ui/app-mark.tsx` (`AppMark`): the ll of
the name in `--foreground-strong` followed by a block cursor in `--brand`,
on a `--surface-1` squircle, the favicon's shape, at 20, 24 or 32 px. It
appears in the sidebar header, the phone bar, the boot splash (Base.astro
repeats the same SVG), the sign-in page and the shared page. The favicon and
the desktop app's `static/mark.svg` draw the same shapes in the dark theme's
colours as hex; `app-mark.test.tsx` fails if a copy drifts.

**WRD-4. There is one owner.** No "users", "admins", "contact your
administrator", "shared with you". Features that only make sense with several
people are not offered in the interface.

**WRD-5. Numbers carry their unit**, with a space ("5,571 MiB", "7.6
tokens/s"), and dates are unambiguous (`2026-11-14`, or "14 Nov 2026").

**WRD-6. Icons come from `lucide-react`.** An emoji is never an icon or a
label.

## Accessibility

**A11Y-1. One focus indicator, on everything, for focus that came from the
keyboard:** a 2 px solid `--focus` outline, offset 2 px (flush on fields,
whose edge also turns `--focus`). It appears when focus was moved with Tab
and not otherwise: a field that was clicked, tapped or focused by the app
shows its caret and no outline, and a button that was clicked shows nothing.
`apps/web/src/lib/ui/focusSource.ts` marks `<html>` with
`data-focus="keyboard"` from a Tab press until the next pointer press, and
the outline is drawn only under that mark. No `outline-none`, and no
translucent ring. A box that draws the edge around a bare text field (the
chat's message box) is a composite field: it carries `data-composite-field`
and shows the focus on the box, as a field does: the same 2 px `--focus`
outline, flush. One exception: the canvas's
editor (CNV-6) shows its caret and no outline. A scrolling region cuts off
what is drawn outside its box, so a list that scrolls keeps 4 px of room
inside its edge (`p-1`: the outline's 2 px and its 2 px offset), with a
matching negative margin where its rows must line up with what is around it;
a region that takes focus itself draws its outline inside instead (DAT-6).
Components transition colour, background and border only, never the outline.

**A11Y-2. Every control has a name** a screen reader will read: a visible
label tied to it, or an `aria-label` (ACT-4). A list row's accessible name is
its name, its state badges and its second line; the id, the time and the
owner are `aria-hidden`. A switch is named for its row ('Enable <name>'), not
for its state. A filter is named for what it filters, then its value
('Source: All sources').

**A11Y-3. A page has one `h1`, headings in order, and landmarks:** `header`,
`nav`, `main`. The shell's first tab stop is a 'Skip to content' link that
moves focus to `<main id="content">`. The sidebar is `nav aria-label="Main"`,
a section's tab strip is a `nav` named after the section, and the shell's
aside is named 'Sidebar'. A route whose visible heading is not text (a chat, a
folder) gets a visually hidden h1 with its name (`handle.heading: 'sr'`).

**A11Y-4. Nothing is available only on hover.** What appears on hover also
appears on focus and is reachable by touch: on touch devices a row's actions
are always shown or are in a menu. On touch, a row's menu button is always
shown. Elsewhere it is transparent, not removed, until the row is hovered or
focused, so focus can return to it when its menu closes (NAV-4). A message's
actions are always shown: muted (`--foreground-muted`) at rest and
`--foreground-strong` while the message is hovered or holds focus, never
`opacity-0` until hover.
A channel message's actions are its own: on touch they are in its
'Message actions' menu, a 44 px ⋯ always shown; on a pointer its toolbar is
transparent and inert until the message is hovered or holds focus.

**A11Y-5. The page works at 200% zoom and reflows at 320 CSS px** without
losing content or the main action. On a phone screen under 520 px tall, routes
with `handle.foldsBar` fold the phone bar into a floating menu button; their
first row starts at `--shell-menu-inset`.

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
app. They use the standard's type, Atkinson Hyperlegible Next and Mono (the
latin woff2 files bundled in `apps/desktop/static/fonts/` with their OFL
licences, loaded under the page's own `font-src 'self'`), and its words
(WRD-3: "local-llm"). Content never overflows the fixed window: the progress
view is a grid whose log row scrolls inside itself, and the buttons sit on
their own opaque row with a top divider; once something needs an answer, the
finished steps fold into one line.

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
counts, in every source file outside `components/ui`, nine patterns the
standard forbids:

| Pattern | Rule | What it catches |
|---|---|---|
| `palette-colour` | COL-1 | `bg-white`, `text-gray-500`, `border-red-400`, ... |
| `text-colour-opacity` | COL-2 | `text-muted-foreground/60`, `text-foreground/50` |
| `arbitrary-text-size` | TYP-2 | `text-[11px]`, `text-[0.8rem]` |
| `outline-removed` | A11Y-1 | `outline-none`, `outline-hidden` |
| `raw-button` | ACT-6 | `<button` instead of the shared `Button` |
| `dark-one-off` | COL-1 | `dark:` variants, which tokens make unnecessary |
| `text-opacity` | COL-2 | `opacity-50`, `disabled:opacity-60`, `opacity-[0.6]`: any partial opacity (not `opacity-0` or `opacity-100`). The source cannot show whether the element holds text, so a dimmed picture or decoration is counted too |
| `native-select` | FRM-4 | `<select` instead of the shared `Select` |
| `raw-input` | FRM-4 | `<input` instead of the shared `Input`, `Checkbox` or `Switch`, a color or range input included. A file input and a hidden input are not counted: no shared component replaces them |

It compares the counts with `apps/web/ui-standard-baseline.json`:

- a file with **more** than its baseline fails, so new code meets the rule;
- a file with **fewer** also fails until the baseline is lowered, so progress
  is recorded. Lower it with
  `cd apps/web && UPDATE_UI_BASELINE=1 bunx vitest run src/styles/standard.ratchet.test.ts`,
  which refuses to raise any count, and commit the smaller file.

The baseline also lists the patterns it has counted (`patterns`). A pattern
added to the test is new until the baseline lists it: the update records its
counts as they stand, the one time a count may start above zero, and lists
it, so a listed pattern is never recorded from scratch again. Adding a
pattern therefore needs the owner's acceptance of its starting counts. The
owner accepted `text-opacity`, `native-select` and `raw-input` on 2026-11-14,
starting from the counts at the end of the UX review's cross-cutting section
(#1116): 43 in 33 files, 51 in 30 files and 126 in 50 files.

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
