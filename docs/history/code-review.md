# Code review: the frontend refactor (2026-09-28)

A review of the whole Svelte-to-React refactor on
`claude/monorepo-frontend-refactor-gh12a2` at commit `8db1cb8`. It follows
`docs/bug-review-2026-09-27.md` (which reviewed the branch one day earlier;
its fixes have all landed) and looks for what that review did not find. Each
finding says where it is, what goes wrong, how it was confirmed, and a
suggested fix, so a later session can act on it without re-deriving it.

## Status: fixed (2026-09-28)

Every finding below has been addressed; the body is kept as the record of
what was wrong. Where a fix differs from the suggestion, it says so here.
Tests marked ✔ were run against the old code as well as the fix, and fail on
the old code.

| # | Fix | Test |
|---|---|---|
| H1 | Channel messages and shared chats render through the chat `Markdown` component, which shows raw HTML as text; mention tags become chips through its mention token. `SafeMarkdown` (descriptions) sanitizes with `SAFE_MARKDOWN_PURIFY`. **Differs:** `class` and `id` are forbidden as well as `style`, because the app's own utility classes (`fixed inset-0 z-50`) build the same overlay | `SafeMarkdown.test.tsx`, `Markdown.test.tsx`; e2e `channels.spec.ts` "a member's HTML shows as text", `public.spec.ts` "a shared chat shows HTML in a message as text" |
| M1 | A new chat starts from `newChatTemporary(...)` (enforced, or the user's default where allowed), again whenever the route returns to a new chat | `request.test.ts`; e2e `chat-settings.spec.ts` |
| M2 | A confirm dialog with the admin's text before the first prompt with web search on, once per chat (kept when a new chat gets its id; reset on moving to another chat or turning search off). Cancel keeps the prompt in the input. **Differs:** asked at send time only; Svelte also asked when the switch was turned on | `request.test.ts`; e2e `chat-settings.spec.ts` |
| M3 | Mentions sharing a label take its occurrences in insertion order; the composer now keeps one entry per insertion. The remaining limit (deleting the first of two leaves the second with the first's id) is stated in `encodeMentions` | `channelModel.test.ts` |
| M4 | A character from a script written without spaces (Han, Kana, Thai, Lao, Khmer, Myanmar) never continues a name, before or after it | `channelModel.test.ts` |
| M5 | The five `.catch` handlers return `null`; a refused Connections save puts the previous values back | ✔ e2e `admin-settings.spec.ts` "a failed Verify…", "a refused save…" |
| M6 | Action buttons render under replies (icon or a sparkle), and `runAction` ports `chatActionHandler`: the conversation up to the reply is posted, returned messages replace theirs with `originalContent` kept, and a saved chat is saved | e2e `chat-actions.spec.ts` |
| M7 | 18 are now used: `temporaryChatByDefault`, `webSearch` (Always: new chats start with search on), `chatBubble`, `showUsername`, `widescreenMode`, `chatDirection`, `renderMarkdownInUserMessages`, `renderMarkdownInAssistantMessages`, `keepFollowUpPrompts`, `insertSuggestionPrompt`, `insertFollowUpPrompt`, `regenerateMenu`, `scrollOnResponseGeneration`, `scrollOnBranchChange`, `showChatTitleInTab`, `largeTextAsFile`, `responseAutoPlayback`, `notificationSound` (the sound restored to `apps/web/public/audio/`). The other 26 Interface rows are marked `unported` with a reason in `interfaceSettingDefs.ts` and not offered; the Audio tab drops the voice-input engine and auto-send rows. **Also found while fixing:** the saved UI scale and font were applied only while changed in Settings, never on load (now in `AppShell`), and the chat background image was never shown (now behind the chat) | `interfaceSettingDefs.test.ts` (a test that fails if any offered row has no reader), `prefs.test.ts`; e2e `chat-settings.spec.ts` (8 tests), `admin-settings.spec.ts` updated |
| L1 | `mentionsToText` for the reply preview and notifications | `channelModel.test.ts` |
| L2 | `codeRanges` finds fences and code spans; mentions inside are left alone | `channelModel.test.ts` |
| L3 | Neighbouring characters are read as code points | `channelModel.test.ts` |
| L4 | `replace_all_mentions` in `utils/channels.py` turns `<#C:id\|label>` into `#label` for the model prompt and thread history | `tests/test_channel_mentions.py` (run in a minimal virtualenv; the full backend suite was not run) |
| L5 | The POST response is filled in with the author, quote and reactions that were sent | ✔ e2e `channels.spec.ts` "…when the response beats the echo" |
| L6 | Events that arrive during the first page load are buffered and applied to it | ✔ e2e `channels.spec.ts` "…while the channel is still loading" |
| L7 | Deleting the root from its thread calls `onRootDeleted` | ✔ e2e `channels.spec.ts` "deleting the root from inside its thread…" |
| L8 | The typing timer skips the viewer's own echo and returns the same array when the user is gone | none: not observable from a test; checked by reading |
| L9 | `safeRedirect` accepts only a path starting with a single `/` | `redirect.test.ts`; e2e `public.spec.ts` "a redirect that would leave the app…" |
| L10 | The attachment is listed as uploading before an image is read or scaled; a scaled image is labelled PNG | ✔ `useAttachments.test.tsx` |
| L11 | The chat input is disabled while `session.loading` | e2e `chat.spec.ts` "the message box waits while a chat loads…" |
| L12 | "Session expired. Please sign in again." on expiry; "Connection lost. Reconnecting..." after 2 s without the socket (once per outage) and "Reconnected" after it. `e2e/fake-socket.ts` gained `drop()`/`restore()` | e2e `chat.spec.ts` (2 tests) |
| L13 | `make backend` binds `LLLM_BACKEND_HOST`, default `127.0.0.1`; `make backend LLLM_BACKEND_HOST=0.0.0.0` restores LAN access | checked with `make -n backend` |

Suites after the fixes: 587 Vitest (+22), 347 Playwright (+20), `astro check`
0 errors, and the new backend test (4 cases) in a minimal virtualenv; the
full backend pytest suite was not run, as this environment has no backend
virtualenv.

Behaviour a user will notice: user messages render Markdown by default (as
in the Svelte app); channel messages use the chat renderer, so their mention
chips and code blocks look like chat's; the Settings modal no longer offers
switches for features the app does not have; and the dev backend is no
longer reachable from other machines unless asked.

Severity is the reviewer's judgment of user impact: **High** means a security
or privacy problem, or data reaching the wrong place; **Medium** means a
feature that silently does the wrong thing; **Low** means a narrow race, an
edge case, or cosmetic damage.

## Scope and method

- **Frontend:** all of `apps/web/src` (about 70,000 lines of TypeScript), read
  by risk rather than line by line:
  - Read in full: the chat core (`routes/chat/useChatSession.ts`,
    `ChatPage.tsx`, `ChatInput.tsx`, `useAttachments.ts`; `lib/chat/history.ts`,
    `request.ts`, `attachments.ts`), auth and session (`lib/auth/*`,
    `lib/stores/authStore.ts`), `lib/socket/SocketProvider.tsx`,
    `components/layout/AppShell.tsx`, `routes/AppRouter.tsx`, every raw-HTML
    sink, and the channel rules and feed (`channelModel.ts`,
    `useMessageFeed.ts`, `useChannels.ts`, `MessageList.tsx`).
  - Read in part: `routes/public/AuthPage.tsx` (sign-in and redirects), the
    channel page, composer and message view, the notes editor, the model
    editor's payload builder, `components/common/AccessControl.tsx`, and the
    admin Documents, Audio and Connections tabs.
  - The rest (workspace, admin, settings, benchmarks UI) was checked with
    targeted searches for known bug classes: settings saved but never read,
    success shown after a failure, query strings built without encoding,
    unguarded routes, and partial config payloads.
- **Backend:** only where the frontend depends on its behaviour: the chat
  completion entry point in `main.py`, the channel and note routers and
  models, mention parsing (`utils/channels.py`), SPA static serving, and the
  benchmark routers (`routers/benchmarks/*`, `benchmarks/serving/launcher.py`).
- **Infra:** `Makefile` and `infra/docker-compose.yml`.
- **Baseline for "regression":** the deleted SvelteKit app, read from git
  at `6e402af^` (the commit before it was removed).

Every finding was confirmed by one of these, as each one says:

- reading the code;
- a throwaway Vitest probe running the real module;
- a throwaway Playwright probe in Chromium against the dev server with a
  mocked backend.

The probes were deleted afterwards; none are part of this commit.

### Checks run

| Check | Result |
|---|---|
| `bunx vitest run` (apps/web) | 565/565 pass |
| `astro check` | 0 errors |
| Playwright (full suite, pre-installed Chromium) | 327/327 pass (7.6 min) |
| Backend pytest | not run: this environment has no backend virtualenv |

## Summary

| # | Sev. | Area | Finding |
|---|---|---|---|
| H1 | High | Channels, shared chats | Any channel member (or a chat's sharer) can inject live HTML: page-wide `<style>`, forms posting off-site, full-screen overlays |
| M1 | Med | Chat | "Temporary Chat by Default" is ignored, so chats the user expects to be temporary are saved |
| M2 | Med | Chat | The admin's "web search confirmation" is never asked for; prompts go to web search without it |
| M3 | Med | Channels | Two users or models with the same display name: every mention goes to the first one picked |
| M4 | Med | Channels | A mention followed directly by CJK text is silently dropped, so the model never replies |
| M5 | Med | Admin | Connection saves and "Verify" report success after a failure |
| M6 | Med | Chat | Model "Action" functions are never shown under replies |
| M7 | Med | Settings | 44 personal settings are saved but never read |
| L1–L13 | Low | various | See "Low severity" |

---

## High

### H1. Channel messages and shared chats render user-authored HTML live

**Where**
- `components/common/SafeMarkdown.tsx:13` renders with
  `DOMPurify.sanitize(marked.parse(text))` using DOMPurify's default
  configuration.
- Used for content other users write:
  - channel messages: `routes/channels/ChannelMessageView.tsx:270`, visible
    to every member;
  - shared chats: `routes/public/SharedChatPage.tsx:105`, visible to anyone
    with the link and served on the app's own origin;
  - model descriptions (`routes/chat/ChatPlaceholder.tsx:31`,
    `routes/admin/settings/models/ModelRow.tsx:110`), written by any user
    with workspace model access;
  - tool and knowledge descriptions (`routes/workspace/models/EditorPickers.tsx:40`)
    and valve descriptions (`components/common/Valves.tsx:244`).

**What goes wrong.** DOMPurify's defaults remove script, but they keep:
- `<style>` elements, which apply to the whole document;
- `<form action="https://...">`, `<input type="password">` and `<button>`;
- inline `style` attributes, including `position:fixed`.

So a message can restyle or hide the entire app for everyone viewing the
channel, or cover the app with a fake "session expired, sign in" form that
posts to another host. The shared-chat page is worse because it is a link
anyone can be sent, on the trusted origin.

**Regression** for channel messages and shared chats. The Svelte app
rendered both through the chat Markdown components
(`channel/Messages/Message.svelte` and `routes/s/[id]/+page.svelte` import
them). Its `HTMLToken.svelte` (at `6e402af^`) turned `<video>`,
`<audio>`, YouTube `<iframe>`, `<status>` and `<br>` into safe elements, and
printed every other HTML token as text (`{token.text}`). The React chat
renderer does the same (`components/chat/markdown/Tokens.tsx:44-73`), but
channels and shared chats don't use it.

**Confirmed** in Chromium: a Playwright probe loaded `/channels/c1` with one
mocked message from another member containing `<style>`, a `<form>` and a
fixed `<div>`. In the rendered page:
- `form[action*="evil.example"]` existed;
- the body's background was the colour the message's `<style>` set;
- `document.elementFromPoint(10, 10)` was the overlay's text.

**Fix.** Render channel messages and shared chats with the chat `Markdown`
component (the same token renderer, which shows unknown HTML as text). For
the remaining descriptions, pass a restrictive DOMPurify config to
`SafeMarkdown`: `FORBID_TAGS: ['style', 'form', 'input', 'button',
'textarea', 'select', 'iframe']` and `FORBID_ATTR: ['style']`.

**Test to add.** A unit test on `SafeMarkdown` asserting that none of those
survive, and an e2e check that a channel message's `<style>` and `<form>`
are not in the DOM.

---

## Medium

### M1. "Temporary Chat by Default" is ignored

**Where.** The setting is saved by `components/settings/interfaceSettingDefs.ts:75`.
Nothing outside `components/settings/` reads it. A new chat's temporary state
starts from `routes/chat/ChatPage.tsx:59`, which reads only the
`temporary_enforced` permission and `?temporary-chat=`.

**What goes wrong.** A user who turned this on expects new chats not to be
stored. They are stored, like any other chat. The Svelte app applied the
setting on every new chat (`Chat.svelte:2007` at `6e402af^`).

**Confirmed** by reading. The header's temporary-chat button does show the
real state, which is why this is Medium rather than High.

**Fix.** Initialise `temporary` from
`settings.temporaryChatByDefault && temporaryAllowed` for new chats. Apply
it again when the route returns to `/` (a new chat), as Svelte did.

### M2. The web search confirmation is never asked for

**Where.** The backend sends `features.enable_web_search_confirmation` and
`web_search_confirmation_content` (`apps/server/backend/open_webui/main.py:2327-2328`,
set with `ENABLE_WEB_SEARCH_CONFIRMATION`). Nothing in `apps/web/src` reads
either one.

**What goes wrong.** An admin who requires users to confirm before a prompt
is sent to an external search engine gets no confirmation. The React chat
sends the prompt with `web_search: true` as soon as the toggle is on. The
Svelte app blocked the send and showed the configured text first
(`Chat.svelte:349-355` and `3126-3133` at `6e402af^`).

**Confirmed** by reading, and with a search: the key appears nowhere in
`apps/web/src`.

**Fix.** Before `session.submit` with web search on, show a confirm dialog
with `web_search_confirmation_content`. Remember the consent for the chat,
as `webSearchConfirmed` did.

### M3. Mentions of two people (or models) with the same name all go to the first

**Where.** `routes/channels/channelModel.ts:223-235` (`encodeMentions`).

**What goes wrong.** Mentions are claimed longest label first, and the first
mention claims every whole-word occurrence of its text. A second chosen
mention with the same label finds nothing left to claim. The composer keeps
one entry per id, so two different users named "John Smith", or two models
named "llama3" from different connections, are two entries with one label.

**Confirmed** by Vitest probe:
`encodeMentions('@John Smith and @John Smith', [john-a, john-b])` returns
`<@U:john-a|John Smith> and <@U:john-a|John Smith>`. `john-b` is never
mentioned, and with models only one of them replies.

**Fix.** When several chosen mentions share a label, assign that label's
occurrences to them in the order they were inserted. Only a mention whose
label is unique should claim every occurrence.

### M4. A mention followed directly by CJK text is dropped

**Where.** `routes/channels/channelModel.ts:214` (`CONTINUES_NAME`).

**What goes wrong.** The whole-word rule treats any letter after the label
as part of a longer name. That's right for `@Sam` inside `@Samantha`, but
Chinese and Japanese text follows a name without a space. The mention is
left as plain text, so a model mention triggers no reply.

**Confirmed** by Vitest probe: `encodeMentions('@GPT-4o帮我翻译一下', [GPT-4o])`
returns the text unchanged.

**Fix.** Only treat a following character as part of the name when it is in
the same script as the label's last character (or is an ASCII letter or
digit after an ASCII label). Add the case to `channelModel.test.ts`.

### M5. Connection saves and "Verify" report success after a failure

**Where**
- `components/settings/AddConnectionModal.tsx:105` and `:111` (Verify
  connection)
- `routes/admin/settings/Connections.tsx:185`, `:199` and `:208` (save
  OpenAI, save Ollama, save the direct-connections switch)

**What goes wrong.** Each call does
`const res = await request().catch((error) => toast.error(...))`, then
`if (res) toast.success(...)`. The arrow function returns sonner's toast id,
which counts up from 1, so `res` is truthy after a failure. The admin then
sees:
- after a failed Verify: the error, then "Server connection verified";
- after a failed save: the error, then "... settings updated". The models
  list is also refreshed, and (for the direct-connections switch) the
  config is marked saved. The form already shows the new values, because
  `setOpenAI`/`setOllama`/`setDirect` run before the request.

**Confirmed** by Vitest probe: a rejected promise with that `.catch` returned
`1`. In sonner's source (`node_modules/sonner/dist/index.mjs:126-134`) ids
come from `toastsCounter++`.

**Fix.** Use a block body (`.catch((e) => { toast.error(...); return null; })`)
at all five sites. On failure, restore the previous form values.

### M6. Model "Action" functions are never shown under replies

**Where.** `lib/apis/index.ts:271` defines `chatAction`, and nothing calls
it. Nothing renders `model.actions`.

**What goes wrong.** Admins can still install Action functions and attach
them to models (Admin, Functions and the model editor's Actions picker both
work). In the Svelte app each action became a button under the model's
replies (`ResponseMessage.svelte:1469` at `6e402af^`), which ran
`chatActionHandler`. In the React chat they don't exist, and
`docs/CLAUDE.md`'s list of deliberate Phase 10 gaps doesn't mention them.

**Confirmed** by reading and by searching for `actions`/`chatAction` in
`routes/chat`.

**Fix.** Port the buttons and `chatActionHandler` (POST, merge the returned
messages, save), or add the gap to `docs/CLAUDE.md` and hide the Actions
picker until they are ported.

### M7. 44 personal settings are saved but never read

**Where.** `components/settings/interfaceSettingDefs.ts`,
`components/settings/personal/Audio.tsx:92` and
`components/settings/personal/Notifications.tsx:78`.

**What goes wrong.** For each key the Settings modal writes, a search of
`apps/web/src` outside `components/settings/` and the tests finds no reader
for:

- **Interface:** `chatBubble`, `chatDirection`, `widescreenMode`,
  `showChatTitleInTab`, `landingPageMode`, `showUsername`,
  `scrollOnResponseGeneration`, `scrollOnBranchChange`,
  `renderMarkdownInUserMessages`, `renderMarkdownInAssistantMessages`,
  `renderMarkdownInPreviews`, `regenerateMenu`, `insertSuggestionPrompt`,
  `insertFollowUpPrompt`, `keepFollowUpPrompts`, `largeTextAsFile`,
  `displayMultiModelResponsesInTabs`, `chatHoverPreview`, `highContrastMode`,
  `iframeSandboxAllowScripts`, `iframeSandboxAllowForms`,
  `iframeSandboxAllowDownloads`, `iframeSandboxAllowSameOrigin`,
  `imageCompressionInChannels`, `detectArtifacts`, `copyFormatted`,
  `hapticFeedback`, `showUpdateToast`, `showChangelog`, `richTextInput`,
  `promptAutocomplete`, `showFormattingToolbar`, `insertPromptAsRichText`,
  `stylizedPdfExport`, `showFloatingActionButtons`, `terminalFileDisplay`,
  `showFilesOnTerminalSelect`, `terminalPreviewAllowSameOrigin`,
  `voiceInterruption`, `showEmojiInCall`, `webSearch` ("Always"), and
  `temporaryChatByDefault` (M1): 42 in all.
- **Audio:** `responseAutoPlayback` (Svelte clicked the reply's speak button
  when a reply finished, `Chat.svelte:2822`).
- **Notifications:** `notificationSound`.

A few belong to gaps that `docs/CLAUDE.md` documents (the rich-text composer,
voice and call mode, PDF export), but the Settings modal still offers all of
them as working switches. `docs/bug-review-2026-09-27.md` M9 named only
three (tool servers, terminals, location); this is the same problem at
larger scale.

**Confirmed** by a script searching `apps/web/src` for each key. Spot-checked
by hand for `widescreen`, `temporaryChatByDefault`, `chatBubble`,
`iframeSandbox`, `landingPage` and `renderMarkdownIn`.

**Fix.** Either wire them up or hide the rows (the settings table already
supports a `visible` predicate), so the modal only offers what the app does.
The iframe-sandbox switches in particular should not suggest they loosen the
artifact sandbox, which is fixed on purpose (`ArtifactPanel.tsx:34`).

---

## Low severity

- **L1. Two views still use the old mention regex.** The reply-to preview
  (`routes/channels/ChannelMessageView.tsx:190`) and the toast and desktop
  notification body (`routes/channels/useChannels.ts:91`) only match
  `<@X:id|label>`. Since `8db1cb8`, channel mentions are stored as
  `<#C:id|label>` and a tag can have no label, so these show the raw tag.
  Fix: a shared `mentionsToText` beside `renderMentions` with the same
  pattern.
- **L2. Mentions inside code are encoded.** `encodeMentions` also rewrites
  `@Sam` inside `` `...` `` and fenced code. `renderMentions` then turns it
  into a `<span>`, which the code span shows as literal markup (confirmed by
  probe). Fix: skip code spans and fences when claiming occurrences.
- **L3. Astral characters before `@`.** The preceding-character check reads
  one UTF-16 unit (`text[at - 1]`). A character outside the Basic
  Multilingual Plane (a rare CJK character, an emoji) counts as a boundary,
  so `𠀀@Sam` is encoded (confirmed by probe). Fix: a Unicode-aware
  lookbehind, `(?<![\p{L}\p{N}\p{M}_])`.
- **L4. Channel mentions reach model prompts as raw tags.**
  `utils/channels.py` `replace_mentions` is only called with the `@`
  trigger, so `<#C:c1|general>` reaches the model unchanged. This matches
  the Svelte app, and the backend would need a second call with `#` to
  change it.
- **L5. A channel message sent over HTTP loses its author until the socket
  echo.** `routes/channels/useMessageFeed.ts:124` applies the POST response
  when it beats the echo. That response is a bare `MessageModel`
  (`routers/channels.py:1223`): no `user`, `reply_to_message` or
  `reactions`. The message shows "Unknown User" and loses its quote until the
  echo replaces it; with no socket, until reload. Fix: merge the response
  into the optimistic copy.
- **L6. Events that arrive during the first page load are dropped.**
  `useMessageFeed.ts:87` ignores events while `messages` is null. A message
  created in that window (a model reply into a thread being opened) is
  missing until the panel is reopened.
- **L7. Deleting a thread's root from inside the thread doesn't close it**
  without the socket echo. The local `onDelete` (`useMessageFeed.ts:129`)
  never calls `onRootDeleted`.
- **L8. The typing-expiry timer re-renders for nothing.**
  `useMessageFeed.ts:81` arms a timer for the viewer's own echoed typing
  events too. It always returns a new array, so the channel view re-renders
  five seconds after each burst of typing.
- **L9. A non-path `?redirect=` leaves a signed-in user on `/auth`.**
  `routes/public/AuthPage.tsx:79` and `:153` pass `?redirect=` to
  `navigate()`. For `https://…`, `//host/…` or `javascript:…`, react-router
  8 throws "External navigation is not allowed", an uncaught error. The
  sign-in succeeded but the page stays on the form. Confirmed in Chromium.
  This is not an open redirect, because the router refuses. Fix: accept only
  values starting with a single `/`.
- **L10. An image can miss the message it was attached for.**
  `routes/chat/useAttachments.ts:74-96` reads and scales an image before it
  adds the placeholder that blocks Send. A quick Enter sends the text
  without the image, which then attaches to the next message. A scaled image
  (always PNG) is also re-wrapped with the original MIME type (line 82).
- **L11. Sending while another chat is still loading.** Switching chats keeps
  the previous chat's history until `loadChat` resolves
  (`routes/chat/useChatSession.ts:137-153`). Meanwhile the input stays live
  (`ChatPage.tsx:314` renders `ChatInput` during loading), so a message sent
  in that window is built on the old chat's tree but posted with the new
  chat's id. Fix: disable the input while `session.loading`.
- **L12. Session expiry and connection loss are silent.**
  `lib/auth/session.ts:6-8` and `lib/socket/SocketProvider.tsx:4-12` dropped
  the toasts because "there is no toast system". There is one now
  (`sonner`); an expired session only logs to the console before the
  redirect.
- **L13. The dev backend listens on every interface.** `make backend` runs
  uvicorn with `--host 0.0.0.0` (`Makefile:102`), so the login page and the
  admin API, which can start processes on this machine, are reachable from
  the LAN. That may be intended; if not, bind to `127.0.0.1`.

## Checked and fine

These looked risky and turned out to be fine:

- **The chat Markdown renderer** prints unknown HTML tokens as text, like
  Svelte did. Only the `SafeMarkdown` path (H1) doesn't.
- **Other HTML sinks.** The Report and Tune pages, the login footer and the
  admin license block all pass through DOMPurify. They show text written by
  admins or by the backend, so the default config is acceptable there.
- **Open redirect after sign-in:** blocked by react-router 8 (see L9).
- **SPA static serving** (`main.py:293-305`, `:3029-3034`): Starlette's
  `StaticFiles` rejects path traversal. Only a 404 falls back to
  `index.html`, and `.js` 404s stay 404s.
- **Benchmark routers:** every route in `routers/benchmarks/*.py` depends on
  `get_admin_user` (checked by parsing each file's route signatures). The
  `/serve/start` lock (M5 of the previous review) and the drain-task cleanup
  (M3) are in place.
- **The Socket.IO client** re-joins its rooms on every reconnect, stops its
  heartbeat on disconnect, and is torn down when the token clears.
- **API query strings:** the unencoded interpolations in `lib/apis` are
  numbers or ids, apart from `utils/gravatar?email=`
  (`lib/apis/utils/index.ts:6`). A `+` in that address becomes a space; the
  Svelte helper did the same.
- **Admin config payloads** keep the loaded config (Documents spreads it;
  Audio's key lists match the backend's required fields), so a save doesn't
  reset fields the form doesn't show.
- **The model editor** builds its payload from a copy of the loaded model,
  so `meta` and `params` keys the form doesn't show survive a save.
- **Notes autosave:** the backend merges `data`, so a title-only save
  (`data: {}`) keeps the body. The access-grant fix (H1 of the previous
  review) is in place in `models/notes.py:358-364`.
- **The chat's new-chat flow** relies on the backend creating the chat when
  `parent_id` is null and there is no `chat_id` (`main.py:1185`, `:1271`),
  and it does.

## Relationship to the 2026-09-27 review

That review listed Channels as reviewed. It missed the event-scoping,
typing, mention and pinning defects in `channelModel.ts` that `8db1cb8`
fixed, and H1 above. Its M9 also covered only three of the unread settings
in M7. Its other conclusions held up where this review re-checked them.

## Tests to add along with the fixes

1. Unit: `SafeMarkdown` removes `<style>`, `<form>`, `<input>` and `style`
   attributes (H1); e2e: a channel message and a shared chat with that
   payload render no live form or stylesheet.
2. e2e: with `temporaryChatByDefault` on, a new chat starts temporary and
   its first message has no `chat_id` saved (M1).
3. e2e: with `enable_web_search_confirmation` on, sending with web search
   on asks first, and cancelling sends nothing (M2).
4. Unit: `encodeMentions` with two same-label mentions, and with a CJK
   character straight after the label (M3, M4).
5. Unit or e2e: a failed Verify or Connections save shows no success toast
   (M5).
6. Unit: a table test asserting every key in `interfaceSettingDefs.ts` is
   either read somewhere or hidden (M7), so this can't regress silently.
