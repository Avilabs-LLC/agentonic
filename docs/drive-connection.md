# Google Drive connection: live tools and knowledge sync

Owner decisions of 9 October 2026 (outstanding action N15, architecture §62). Drive is built the way Gmail is ([gmail-connection.md](gmail-connection.md)) and with the same safeguards, for two separate purposes:

- **Tools.** An agent reads the Drive files its owner picked for it and proposes Google Docs changes that the owner confirms once in chat.
- **Knowledge.** A curator imports picked files into a collection in Conocimiento, and the knowledge worker keeps them in sync.

This document is the design, the permission and execution contract, the rollout and the acceptance matrix. No live Drive has been read or changed yet.

## Decisions

| Question          | Decision                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Purpose           | Live tools and knowledge sync, in one PR.                                                                                                                                                                                                                                                        |
| Scope             | `drive.file` with Google's Picker only. Agentonic reaches only files a person picks in the Picker inside Agentonic, and files Agentonic created. There is no whole-Drive search. `drive.file` is a non-sensitive scope: it needs no restricted-scope verification or yearly security assessment. |
| Writes            | Create a Google Doc. Update a Doc the agent created or the owner picked. Each write is confirmed once in chat, or pre-authorized by a schedule, one write per run (§58). There is no deleting, moving or sharing.                                                                                |
| Google Cloud      | The same project and OAuth client as Gmail, with the same callback and test users.                                                                                                                                                                                                               |
| Knowledge imports | Started from **Conocimiento** with the curator's own Drive connection. It is separate from any agent's tools connection, as UI contract §8 requires: "A connection's knowledge-import scope and live tool permissions are separate choices."                                                     |
| Changed files     | If a running or approved version cites a file's current text, a change to that file is **held** ("Cambios en Drive sin aplicar") until the curator applies it. Other files update automatically.                                                                                                 |
| Folders           | Files only. Google does not document whether picking a folder under `drive.file` shares the files inside it, and §37.5 says not to assume it. A live check during acceptance decides whether folders follow.                                                                                     |

## Owner setup in Google Cloud

The Drive API and the Picker API are enabled (owner, 9 October). Before the live test, the owner needs to:

1. **Add the scope.** In Google Auth Platform → Data Access, add `https://www.googleapis.com/auth/drive.file`. In Testing mode it needs no review.
2. **Create the Picker's API key.** In Credentials → Create API key, name it "Agentonic Picker".
   - Website restrictions: `https://app.agentonic.avilabs.tech/*`, `http://localhost:3101/*` and `https://docs.google.com/*`. Google rejects a key without the last one.
     These restrictions match the site the browser reports. The customer app therefore sends `Referrer-Policy: strict-origin-when-cross-origin`, which gives other sites its origin only. Under `same-origin`, Google reported the key as invalid.
   - API restrictions: Google Picker API only. Agentonic calls Drive from its servers with OAuth, never with the key.
3. **Store the settings.** Put the key and the project number (Cloud console → Project info) in `.env.staging.local` as `GOOGLE_PICKER_API_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER`. The number is optional: when it is missing or not numeric (a project ID, for example), the server takes it from the OAuth client ID, which begins with it. Then run `node scripts/setup-gmail.mjs`, which copies them to the customer app; `pnpm platform:install` carries them to the VM's `customer.env`. Never put them in chat or in `NEXT_PUBLIC_*` values. The key is restricted, but it is still configuration.
4. **Prepare a test account.** Keep the account under Test users. In its Drive, create synthetic files named "Prueba Agentonic Drive …": a Doc, a Sheet, a Slides deck, a PDF and a `.md` file.

The callback URI stays the same. As with Gmail in Testing mode, consent lapses after 7 days and at most 100 test users can connect.

## Scope and experience

**Configuración → Conexiones** (one card with Gmail):

- The "Google Drive" button (accessible name "Conectar Google Drive", with Drive's mark) explains `drive.file` before Google asks.
- Each account's frame shows Drive's logo, the account and its state, and the agent's files, with each file's type and "Creado por el agente" where it applies.
- "Elegir archivos" opens Google's Picker, which offers files only, in the supported formats, at most 25 per account. The page stays where it was while the Picker is open; Google focuses its dialog after opening, which used to scroll a long page to its end.
- Each file has "Quitar"; the frame has "Desconectar".

**Herramientas.** Drive's account tabs show the tools on (`x/4`), with four tools: Ver archivos elegidos, Leer archivos, Crear documento and Editar documento. As with Gmail, an agent uses one Drive account at a time.

**Chats and Probar agente.** A Drive action card appears with "Revisar acción".

- For a new Doc, the dialog shows the account, the title and the content (Vista previa and Texto).
- For an update, it shows the Doc's current text beside the proposed text, and says that a change made in Drive after the proposal stops the update.
- After success, the card links to the Doc.

**Conocimiento → Google Drive.** A card beside "Subir documento" shows the curator's Drive account, a collection to import into and "Elegir archivos".

- Each import shows its name, linked to Drive, with its type; its collection; its sync state as the row's one badge (Sincronizado, Sincronización pendiente, Sincronizando, Cambios en Drive sin aplicar, Sin acceso en Drive, No se pudo sincronizar); and when it was last checked.
- Its actions are "Sincronizar ahora", "Aplicar cambios" (for a held change, after a confirmation naming the agents that will stop) and "Quitar de Conocimiento".
- Readers of the collection see imports without the curator's account; only curators manage them.

**Programaciones.** Automatic actions are grouped as Gmail and Google Drive. A schedule may pre-authorize Crear documento or Editar documento, one action per run, as with Gmail.

**Admin.** The review and receipt's "Herramientas solicitadas" lists each Drive grant's operations without the account.

## Formats and limits

| Drive file     | Read as                                 | Notes                                                                                           |
| -------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Google Doc     | Markdown (`files.export text/markdown`) | Created and updated from Markdown when Drive's import formats allow; otherwise from plain text. |
| Google Sheet   | CSV                                     | Google exports the first sheet.                                                                 |
| Google Slides  | Plain text                              |                                                                                                 |
| PDF            | Existing parser (`pdf-parse-2.4.5`)     |                                                                                                 |
| Text, Markdown | As they are                             | Knowledge requires valid UTF-8.                                                                 |

- **Size.** Every download or export is capped at 10 MB, and Google's own export cap is 10 MB too.
- **Tools.** A read returns at most 20,000 characters, marked untrusted. A turn may make three Drive calls. A list shows only the agent's files and costs no Drive call.
- **Files.** A tools account holds at most 25 files and a knowledge account at most 50.
- **Unsupported files.** Refused when picked, with a reason: an unsupported format, over 10 MB, in the trash, or no access.

## Permission and execution contract

**OAuth**

- The flow reuses Gmail's: a same-origin POST start, ten-minute single-use state bound to the member, workspace and purpose (and the agent for tools), PKCE S256, and an encrypted HttpOnly cookie of its own (`agentonic-google-drive-oauth`).
- The single registered callback reads the cookie that matches the state.
- Only `drive.file` is requested, and `include_granted_scopes` is never set, so the token carries none of Gmail's scopes.
- A missing refresh token or a missing `drive.file` fails the connection.
- The account comes from Drive's `about.get`, never from a form or the model.
- Connecting the same account again revives its connection with its files, operations and imports, so a weekly Testing-mode expiry costs only a reconnect.

**Picker**

- The browser needs a short-lived access token for Google's Picker. The server mints one from the stored refresh token, only for the connection's own member, and refuses unless Google granted it `drive.file` and nothing broader.
- This is the one exception to "no tokens in the browser". It is bounded to `drive.file`, about an hour, that member's session and `no-store` responses.
- Picked file IDs are checked with Drive through the connection before they are kept. Names and types come from Drive, never from the browser.
- Google requires the person to be signed in to Google in that browser while the Picker is open. Without a Google session, the Picker shows Google's own "Debes iniciar sesión" page instead of the files. The Drive shown should be the connected account's, since only that account's token can read the picked files.
- When the Picker's frame cannot see the Google session, Google's frame page decides what to show (read from its script, 9 October). Where the browser offers the Storage Access API and access is not yet granted, it asks for that access. Otherwise it shows "Iniciar sesión".
  - That button opens a Google sign-in window. The frame then checks its own cookies every second for Google's sign-in cookies; once it sees them, it closes the window and reloads itself.
  - Brave does not share Google's cookies with the frame, so the frame never sees the sign-in. If the person is already signed in, the window shows a standalone Picker whose "Seleccionar" and "Cancelar" reach nothing.
  - Allowing cross-site cookies in Brave's Shields did not help in the owner's test.
  - So in Brave, Safari and every iPhone or iPad browser, "Elegir archivos" picks on Google's own consent page instead; see the next item.
- **Picking on Google's page.** Agentonic starts the usual Drive consent with Google's file chooser turned on: `trigger_onepick=true`, `allow_multiple=true`, `mimetypes` limited to the supported formats, and `login_hint` naming the connected account.
  - Google documents this for desktop and mobile apps. A live check on 9 October showed it also works for this web client: Google said "For the files you're about to pick…" and offered the files.
  - Google returns `picked_file_ids` to the usual callback. The callback renews the connection's sealed credential, as on any reconnect. It then checks each file with Drive and keeps it exactly as a Picker pick: for the agent, or in the collection chosen before leaving.
  - Back in Agentonic, one notification reports how many files were added and refused.
  - Choosing another account on Google's page connects that account as its own connection.
  - There is no frame, no popup and no third-party cookie, so neither Brave's nor Safari's cookie rules matter.
  - The customer app sends `Cross-Origin-Opener-Policy: same-origin-allow-popups` so that Google's frame keeps a handle on the window it opened and can close it. Under `same-origin`, browsers open that window without an opener. Admin keeps `same-origin`.
- Google positions the Picker from the window's scroll position. The shared stylesheet keeps `.picker-dialog` fixed and centred in the viewport, and the window fits the screen within Google's size limits.

**Connections, grants and files**

- A tools connection grants zero operations until the owner enables them.
- Frozen versions pin the connection and the operations (`drive-v1` code tools, registered for runtimes with `driveContract`). A version with Drive tools needs a runtime that declares the contract and staff review.
- The agent's files (`drive_files`) are live: picking or removing a file needs no new version.
- Google's `drive.file` grant covers the whole project for that person. Agentonic's per-agent and per-import lists keep application access narrower than OAuth, as with Gmail.

**Reads**

- Each read is checked before and after the provider call (`drive-read`, then `drive-check` with the file ID before anything reaches the model).
- A model-supplied ID outside the agent's files reaches nothing and returns `not_in_agent_files`.
- Content is untrusted: it can never authorize an action.

**Writes**

- Gmail's contract applies:
  - encrypted, immutable arguments and a SHA-256 digest are stored before any side effect;
  - one confirmation within 10 minutes, consumed once and bound to the arguments, the actor and the conversation or preview;
  - one provider attempt, and an uncertain outcome is never retried;
  - a proposal ends the turn.
- An update names its file in the clear (an ID, never content). It is checked against the agent's files when proposed, inspected, confirmed and pre-authorized. It is bound to the Doc's name and Drive version seen when proposed, and refused (`changed`) if Drive shows another version when it runs. The check and the write are separate calls, so an edit made in between can still be overwritten.
- A created Doc joins the agent's files. The stored result keeps only an outcome code, the file ID and its link.

**Revocation**

- Google's revocation "removes all OAuth 2.0 scopes previously granted to a project… for all clients registered under that project". Revoking one connection would therefore end every other Gmail or Drive connection of the same Google account.
- On disconnect, both Gmail and Drive now ask `google_account_shared` and revoke only when no other Agentonic connection holds that account. Otherwise only Agentonic's credential is erased.
- A failed Drive connect never revokes.

**Secrets.** Credentials, arguments and verifiers are sealed like Gmail's (`drive:<id>`, `invocation:<id>`, `oauth:<state>`), and `pnpm connections:rotate-key` re-seals them too. Agent services, the runtime, the model and the browser never see a refresh token. Agent copies reach Drive through the host gateway (`drive_staging`, provider call `drive`).

**Lifecycle**

- Closing a chat or ending a preview cancels pending proposals and erases their arguments.
- The 15-minute retention sweep expires them. A write still executing is spared 15 minutes past its window.
- Offboarding disconnects every Drive account of the member, which also removes their imports.

## Knowledge sync

**Records**

- Each imported file is a knowledge source of kind `google_drive` with one document.
- The source's definition hash covers the kind, the file, the collection and the connection, never the content. A frozen version therefore keeps its sources while their text refreshes, and it sees a new import only from its next version, as with uploads.
- Versions keep no stored object: the text lives in Drive and only chunks are kept.

**The hourly check**

- The knowledge worker's tick queues each file due for its hourly check; "Sincronizar ahora" queues one at once. A sync runs in the documents lane with the curator's own connection, and only while that connection is connected and the curator still curates the collection.
- The worker reads the file's metadata first. An unchanged version costs nothing.
- When the version changed, it downloads or exports the file and hashes it. The same text only advances the version.
- New text is parsed, chunked and embedded on the Voyage ledger, attributed to the source's ingestion, then published.

**Hold rule.** A change is held when the current text's chunks are cited:

- by the evidence of a deployment that is not revoked or expired; or
- by the evaluation behind a standing approval.

Without the hold, publishing would stop those versions (`deployment_authorized` checks cited evidence, §59). The held state keeps no new content. "Aplicar cambios" asks for confirmation, then re-queues the sync with apply. Publishing then stops the citing versions, as replacing an upload would.

**Lost access**

- A file Drive no longer shares (deleted, trashed, no access, unsupported or too large) leaves the index at once. Its row stays as "Sin acceso en Drive", and it is checked again every 6 hours.
- A refused token marks the account for reconnection. Syncing pauses, but the imported text stays usable.
- Disconnecting removes the account's sources and everything derived from them. The confirmation names how many files go and warns that citing versions stop.

**Spend.** Embedding uses the platform ledger as uploads do; Drive's own API calls cost nothing.

## Evaluation

- Versions with Drive tools get platform cases on synthetic fixtures (`fixtures.drive`):
  - `platform-drive-injection`: a Doc with a hidden instruction; the agent summarizes it and does not follow the instruction;
  - `platform-drive-write`: the agent proposes a Doc for confirmation and does not claim it was created.
- The cases are added only while the Azure evaluator advertises `driveFixtures: 1`, which `deploy-evaluation-staging.mjs` now sets.
- Fixture providers answer every Drive call and never reach the live Drive. A dataset may now hold 19 cases.

## Rollout

Every step needs the owner's OK.

1. Merge, then apply migration `202610090065_google_drive` with `pnpm db:migrate`.
2. Run `pnpm platform:install --azure --release=<tag>`, carrying the Picker settings.
3. Run `pnpm runtime:install` for runtime 0.6.0, which declares `driveContract`. Runtimes 0.3.0–0.5.0 keep running unchanged; brokers send them no Drive keys.
4. Run `install-staging`, so the broker and gateway know the `drive_staging` call and the `drive` provider call.
5. Install the evaluator with `driveFixtures`, then run `pnpm staging:reverify`.
6. Do the live acceptance below with the owner clicking consent and confirmations.

### Rollout checkpoint — 9 October 2026

All six steps ran in this order:

| Step           | Result                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration      | `202610090065_google_drive` applied; the Drive functions carry the intended grants and no application role reads the Drive tables.                         |
| Evaluator      | `7fb7104a` registered with `driveFixtures: 1` and rubric 6 for runtimes 0.3.0, 0.4.0, 0.5.0 and 0.6.0, replacing `7dee5f53` (no evaluation was running).   |
| Staging broker | `ec30c590` with its gateway; the one running deployment's copy moved to it without stopping.                                                               |
| Platform       | `platform-0.34.0-4b9f84b0e427`: knowledge worker, customer app and Admin each passed their health gate. The customer configuration carries the Picker key. |
| Runtime        | 0.6.0 published as `0.6.0-preview-4b9f84b0` (artifact `d972b626…`, commit `4b9f84b`) with the four `drive-v1` tools, installed on the host.                |
| Checks         | `staging:reverify --verify` and `pnpm hosted:check` passed; the hosted CSP shows `frame-src https://docs.google.com https://drive.google.com`.             |

The configured `GOOGLE_CLOUD_PROJECT_NUMBER` held the project ID, so the server takes the number from the OAuth client ID, which begins with it.

No Drive account has been connected, and no file read or written. The live acceptance below is next.

**First live attempt, 9 October.** The owner connected a Drive account on an agent's Conexiones. "Elegir archivos" then only blurred the page: Google had placed the Picker 1,337 px above the visible screen of the scrolled page, leaving only its backdrop. `platform-0.34.1-ca88840bfe2a` (PR #80), installed the same day with every service healthy and the hosted check passing, keeps the Picker in view.

In Brave, the Picker then asked "Debes iniciar sesión" and, after "Iniciar sesión", opened as a popup that listed "No hay documentos". Brave withholds Google's cookies from the frame, so Google falls back to the popup. Under the app's `same-origin` opener policy, that popup had no link back (checked locally in Chrome and Brave). Platform 0.34.2 lets it keep that link.

- The first connected account's Drive was empty, which explains "No hay documentos".
- With an account that has files, the popup listed them. Before 0.34.2, choosing files, "Seleccionar" and "Cancelar" did nothing, and the frame stayed on "Iniciar sesión": these are the symptoms of the missing link.
- `platform-0.34.2-53b1360fad4e` (PR #82) was installed the same day, with every service healthy and `hosted:check` passing.
- The connected account must be the one whose files are picked, since each picked file is checked through that connection.

Still on 0.34.2, Chrome showed "La clave de desarrollador de la API no es válida". The key's website restrictions need the browser to report the app's site, and `Referrer-Policy: same-origin` reported nothing. With `strict-origin-when-cross-origin` set in the owner's Chrome for one page load, the Picker listed the account's files in the page, and "Cancelar" returned to the app. Platform 0.34.3 sends that policy from the customer app. Brave's popup path still needs a retest, since its frame may have failed the same key check.

`platform-0.34.3-1e7276f89821` (PR #84) was installed the same day, with every service healthy and `hosted:check` passing. In the owner's Chrome, with nothing added to the page, the Picker listed the account's files and "Cancelar" closed it. Picking a file and the rest of the acceptance matrix are next.

- The owner then picked three files in Chrome, and they appear under "Archivos del agente".
- `platform-0.35.0-ee0f65b4f024` (0.34.4's changes plus migration 66), installed the same day, keeps the page still while the Picker is open, shows the "Gmail" and "Google Drive" buttons with their marks, and tells Brave users about Shields.
- Brave with cross-site cookies allowed in Shields still failed. Picking on Google's page (above) replaces that advice in 0.35.3.
- `platform-0.35.3-e06be8c1b375` was installed the same day with every service healthy and `hosted:check` passing. The owner's pick in Brave is next.

## Acceptance matrix

| Boundary           | Required evidence                                                                                                                                                | Synthetic evidence (this PR)                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth              | Connect through the hosted callback with `drive.file` only; reconnect the same account; refuse a wrong browser or state.                                         | State replay, expiry, wrong actor and workspace, revive by account, target mismatch (`tests/drive-database.test.ts`).                         |
| Picker             | The Picker opens under the production CSP; only picked files are kept; an unsupported file is refused with its reason.                                           | The token is refused when its scope is wider; picked IDs are checked with Drive (`tests/drive.test.ts`).                                      |
| Authorization      | Zero operations at connect; files outside the agent's list never read; disconnect stops tools; Gmail on the same account keeps working after a Drive disconnect. | The allowlist, frozen and live scope, staff and other members refused, `google_account_shared`.                                               |
| Write confirmation | Create a Doc once; update it once; a stale update refused after an edit in Drive; cancel; a refused second confirmation.                                         | Hash binding, one-time approval, expiry, cancellation, uncertain outcome never retried, version check before update.                          |
| Knowledge          | Import a Doc, a Sheet, a PDF; answer from them with citations; edit in Drive and see a sync; a held change with Aplicar cambios; trash a file; disconnect.       | Import, hourly tick, unchanged versus changed text, held versus applied, gone, reconnect, purge on disconnect, spend attributed to ingestion. |
| Schedules          | A schedule pre-authorizes Crear documento and its run creates one Doc.                                                                                           | One automatic write per run; a lapsed authority cancels it; deletion cancels a pending one.                                                   |
| Evaluation         | A Drive version's evaluation includes the Drive cases.                                                                                                           | Case selection, fixture answers, no live Drive.                                                                                               |
| Folders            | Pick a folder in a test and record whether its files are reachable under `drive.file`.                                                                           | Not applicable: v1 picks files only.                                                                                                          |

## Not covered

- **Folders**: until the live check.
- **Sharing, moving, deleting**: none, and none of other people's comments or revisions.
- **Shared drives**: work only as far as `drive.file` and `supportsAllDrives` allow; not tested.
- **Concurrent edits**: only Drive's version number guards an update; a merge is not attempted.
- **Admin's agent lists**: flag Gmail but not Drive yet.
- **Google verification**: `drive.file` needs only brand verification. That waits for the same project decision as Gmail (B5), because one project holds both.
