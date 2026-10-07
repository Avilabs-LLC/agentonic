# Agentonic UI contract

**Owner-approved · 2026-09-15 · Applies to both admin and customer apps.**

This is the authoritative presentation contract for Agentonic. Read it before changing UI, including shared components, page layouts and loading states. [Architecture](../agentonic-architecture.md) remains authoritative for domain behavior and authorization; this contract owns presentation. Historical implementation notes and the [badge audit](../badge-audit-2026-09-15.md) do not override these rules.

## Baseline and local adaptations

Adapted from `Dev/acachuchazo-admin/docs/ui/ui-contract.md` (read in full on 2026-09-15), carrying over its Base UI composition, semantic styling, Spanish interface, page/table conventions, forms, feedback and skeleton verification. The applicable baseline had already been accepted in architecture §21; it now lives here so new UI work has one local reference.

Agentonic uses the **Nova / Neutral / Emerald / Inter preset `b1zBuS` with the default radius** (owner change on 2026-10-06; it replaced Mira / Mist / Sky / Figtree `b1GfVg2Oe`), separate apps, shared `packages/ui` components, per-app navigation and customer agent-list override. Acachuchazo's Lyra/green theme, financial widgets, KYC screens and preview overlay are not imported. The owner's badge hierarchy below supersedes the baseline's blanket status-badge and `Pronto`-badge conventions.

## 1. Preset, primitives and styling

Owner-supplied initialization command:

```sh
pnpm dlx shadcn@latest init --preset b1zBuS --template next
```

The official CLI's read-only `preset decode b1zBuS --json` resolved the preset on 2026-10-06:

| Setting | Agentonic |
|---|---|
| Style | Nova |
| Base color | Neutral |
| Theme | Emerald |
| Font | Inter; headings inherit |
| Icons | Lucide |
| Radius | Default (`--radius: 0.625rem`) |
| Chart color | Neutral |
| Menu color / accent | Default / subtle |

Preset reference: [Agentonic preset](https://ui.shadcn.com/create?preset=b1zBuS). The [official CLI documentation](https://ui.shadcn.com/docs/cli) describes initialization and preset inspection. Preserve the generated token values; the preset's default radius matches the earlier owner override, so none is needed. Do not run `init` in the monorepo: it would overwrite the customized primitives and could create a third app at the repository root. Generate a reference project with the command above (with `--base base`) and port its tokens and primitives into `packages/ui`.

**Moving from Mira to Nova (2026-10-06).** Each primitive was three-way merged: the Mira original as the base, ours, and the Nova version, so local changes survive. Kept on top of Nova: the status badge palette and `link` variants; the `link` token for clickable text (blue like the ID links, not the emerald primary); the 8px title-to-description gap in dialogs; and the dialog layout every dialog relies on (24px padding for full-bleed footers, a `max-w-lg` default that a `max-w-2xl` class overrides, and scrolling within the viewport); the Spanish "Cerrar" label; and the taller default textarea.

Retain the source contract's **Base UI** component architecture. The decoded preset does not identify a primitive library: explicitly select Base UI during initialization (the CLI supports `--base base`) and verify the generated configuration. Compose with `render`, using Base UI's actual open-state hooks (`data-popup-open` / `data-open` as applicable). A `Button` rendered as a Next.js `Link` sets `nativeButton={false}`. A `Select` with machine-readable values supplies a value-to-label `items` mapping so the trigger displays a human label.

Use shadcn components wherever an appropriate primitive exists, including buttons, fields, menus, dialogs, tables, empty states and tabs. Styling uses semantic tokens; no scattered palette classes. The new preset replaces Acachuchazo's Lyra geometry and green primary. Preserve its deliberate pill-shaped status badges, centralized status palette, blue underlined ID links and limited `text-highlight` token. The highlight remains a violet semantic token, used for at most one key value per card, never for status or a background surface; check its contrast against the new theme. Centralize these exceptions in shared components/tokens.

**Owner direction, 2026-10-06.** Clickable text uses the semantic `link` token (`text-link`): the primary blue in light mode and a lighter blue in dark mode, so it stays readable on cards, tables and dialogs. Link-style buttons show the pointer cursor. Framed object icons use the shared `IconTile`, one tone per surface so no colour repeats: emerald for versions in Activación, yellow for Nueva versión and sky for Versión actual in Configuración. They are object markers, not status signals (§9).

Shared label maps, variants and formatting helpers live in modules without `"use client"`; server components must not import non-component values from client modules. Both apps consume a shared UI package, while navigation, customer/staff actions and server authorization remain app-specific.

Carry over the source's Spanish (`es-VE`) interface and centralized `Intl` formatting as the initial language convention. All visible labels, pagination, errors and notifications use it consistently. Display operational times with an explicit applicable user/workspace timezone; do not inherit Acachuchazo's business timezone. Capitalize the word following separators such as `·` in metadata lines.

## 2. Page anatomy and navigation

Collection pages render a shared `PageHeader`: bold `text-3xl` title, formatted count appended as `Título: 1.811`, one-line muted description and right-aligned page actions. Optional statistics and filters precede the main content. Do not invent counts before data exists.

Every “Crear…” launcher includes a leading decorative Lucide plus icon. Dialog submit buttons repeat the action label without that icon (§5). Keep the Spanish text as its accessible name and preserve pending/disabled behavior.

Each app has one typed navigation registry providing its sidebar, breadcrumb and page-header labels. Share the registry contract and rendering helpers, not staff navigation entries with customers. Unbuilt sections appear disabled with a muted `Pronto` text suffix. Keep routes, labels and permissions explicit.

## 3. Tables

Use pinned TanStack Table v8 and a shared `DataTable` for entity tables. Prefer a table over a card grid for collections larger than about six records; this does not turn chat transcripts or prompt editors into tables.

- Every data column has a sortable `DataTableColumnHeader`. The row-action column has no meaningless sort control.
- Search sits above the table and covers common-sense entity fields with multi-term AND matching. Server-backed search, sorting and pagination must cover the authorized result set, not only the current browser page.
- Provide Spanish pagination, page-size selection, a sticky header in a bounded scroll area, and a shadcn `Empty` state.
- Tables carry no ID column (owner direction, 2026-10-07; this replaces the earlier `IdLink` rule). A record opens from its own name or number: the agent name opens the agent page, the review number opens the review or its receipt. Two cells in one row never lead to the same page. **Customer agent list (owner direction, 2026-09-14):** the ellipsis action column comes first, and the Agente cell shows only the name, a link when the member may edit it. Existing edit permission checks also govern the name link.
- Body cells use uniform vertical padding within each table and the shared middle alignment, including action and status cells. Set table density on the table rather than individual columns.
- Primary record states may use pill badges under §9. Nested outcomes use inline icons and text. Badge tones use the source palette: `success`, `warning`, `error`, `orange`, `sky`, `violet`, `emerald`, `slate`, and the appropriate `inverse*` variants on colored surfaces. Light mode uses tinted surfaces/dark text; dark mode uses page-background surfaces/luminous text. Never use the solid primary `default` badge for statuses. Text communicates status as well as color.
- Shared `status-badge` components and `lib/badge-status` descriptors assign the same labels, colors and icons in both apps. Primary and nested displays consume the same descriptor. See §9 for state semantics and exceptions; permissions, counts, environment and availability do not use badges. Unknown statuses use neutral “Estado desconocido” with a help icon. The palette remains centralized in `badge.tsx` and the inline status renderer; inverse variants are reserved for colored surfaces.

### 3.1 Field standard (owner direction, 2026-10-07)

One data point is rendered the same way in every table of both apps unless a difference is written down here. The shared cells live in `table-cells.tsx` (`When`, `Deadline`, `Count`, `Code`, `Absent`, `FieldStack`, `CellLink`, `CellButton`, `sortableHeader`), the deployment columns in `deployment-columns.tsx` and the agent version columns in `agent-versions.tsx`.

- **One fact per cell.** A badge stands alone in its cell, never above or below text. When a cell must hold several facts, each carries its label in a `FieldStack`: the muted "Etiqueta:" over its value, as in corbero-cloud. The agent lists' Versión en uso and Próxima versión cells are the only stacks today.
- **Order.** Identity first (Agente, Espacio de trabajo, owner or email), then Versión and Revisión, then place (Entorno, Trabajador), then states (Estado or Despliegue, En reposo, Aprobación), then amounts and counts, then dates.

| Data point | Header | Rendering |
|---|---|---|
| Agent | Agente | Name; a `CellLink` to the agent page in Admin, to the editor in the customer list when the member may edit; plain text otherwise. |
| Workspace | Espacio de trabajo | Its own column, `WorkspaceName` with the workspace icon. Never stacked under another name. |
| Version | Versión | The bare number (tabular). |
| Review | Revisión | The review (submission) number, a link that opens the review or its receipt where one exists. The criteria's saved edits are "Criterios, edición N", never "Revisión". |
| Place | Entorno | `environmentLabels` for staff (`vm-agents-01`), `customerEnvironmentLabels` for customers; "No aplica" when nothing is deployed. |
| Worker | Trabajador | Monospaced id; "Sin trabajador". |
| Deployment state | Estado (deployment tables) or Despliegue | Always a badge from the deployment descriptor; "Sin despliegue" as muted text. |
| Resting | En reposo | Sí, No, or "No aplica" when not running. |
| Submission or proposal state | Estado | Badge from the submission or proposal descriptor. |
| Approval | Aprobación | Inline indicator keyed by the approval reason (Vigente, Vencida…), never a badge; "Sin aprobación". |
| Activation deadline | Plazo para activar | `Deadline`: date over time, "Venció el …" as a warning once past; only while the approval is valid. |
| Other timestamps | Creado, Enviada, Activado, Publicada, Fecha, Último turno, Vence, Uso autorizado hasta | `When`: date (6/10/2026) over muted UTC time; "Sin registro" or a specific absence. |
| Day | Día | The same date format, without time. |
| Counts | the counted thing ("Turnos (7 días)", "Documentos") | `Count`: plain tabular numerals, not muted. |
| Money | Gasto, Gasto conocido | `formatMoney`; spend against a budget as "USD x de USD y". |
| Identifiers | Commit, Artefacto, Recurso | Monospaced; a resource is its Spanish type plus its short id. |
| Workspace kind, timezone, role | Tipo, Zona horaria, Rol / Tu rol | Shared label maps (`workspaceKindLabels`, `memberRoleLabels`). |
| Email | Correo electrónico | Plain text; "No disponible". |

Badges and inline indicators of the same state share one descriptor (label, tone and icon), so a state looks alike in either form; tests hold the deployment, submission and approval maps to this.

## 4. Filters and row actions

Extra filters live in a shared `FiltersCard` titled `Filtros`, arranged in a responsive grid, with a `Limpiar` action resetting every filter. The page's table wrapper owns filter state.

Row actions use a final-column ellipsis menu with icons. Destructive actions are red, separated at the bottom, and consequential operations require an `AlertDialog` with explicit title, consequence and confirmation label. A disabled or hidden control does not replace server-side authorization.

## 5. Forms and feedback

Forms use react-hook-form, Zod, `zodResolver`, `mode: "onChange"`, and shadcn `Field`, `FieldLabel`, and `FieldError`. Submit is disabled while required inputs are invalid or submission is in progress: `disabled={!isValid || isSubmitting}`. Validate again on the server and preserve actionable field errors.

Creation entry buttons use a `+` icon. Inside dialogs, submit buttons omit that icon and retain a specific action label such as `Crear agente`, `Crear colección` or `Eliminar colección`, rather than generic `Confirmar`. Repeating the dialog's action makes the result of submitting explicit. Use `Cancelar` for dismissal and the appropriate progress label while submitting.

Use Sonner at the bottom right with centralized `notify` helpers and distinct success, warning and destructive styles. Components do not call `toast` directly. Every completed submission or row action produces exactly one notification, including failures; cancellation produces no success claim. Inline field errors complement that notification. Pending asynchronous work must be described as queued/submitted, not deployed or completed.

Dialog titles and descriptions share an 8 px gap. Use the shared `DialogHeader` (or `AlertDialogHeader`) so content spacing does not change the gap between the heading and its description.

## 6. Loading states and verification

Every rendered page route has a `loading.tsx` matching its actual structure: header, back row, cards, toolbar and table column count as applicable. Shared skeleton primitives include `PageHeaderSkeleton`, `RecordHeaderSkeleton`, `BackRowSkeleton`, `FiltersCardSkeleton`, `TableSkeleton` and `StatCardsSkeleton`; chat and editor routes receive matching specialized skeletons.

Port the source's skeleton freshness audit concept to both apps. Fingerprint each route's page, colocated visual components and loading skeleton; include relevant shared visual dependencies so a shared component change cannot silently escape review. `pnpm skeletons:check` must fail for missing skeletons, stale manifests and unreviewed visual changes. After changing a skeleton or explicitly confirming unchanged geometry, `pnpm skeletons:update` records the reviewed baseline. Hash freshness supplements visual review; it does not prove visual equivalence.

Foundation CI runs typecheck, lint, applicable tests and the skeleton audit. Verify responsive layouts, keyboard navigation, focus, validation feedback and light/dark/system themes as UI work lands. **Do not run `pnpm build` or `next build` for verification unless the owner explicitly requests a full build.**

## 7. Shell and detail pages

Use shadcn `Sidebar` with `variant="inset"`, an Agentonic brand mark placeholder, centralized application name/version, grouped navigation and bottom user menu. The menu provides theme selection (`Claro`, `Oscuro`, `Sistema` through next-themes with the `class` attribute), account and sign-out when those features work. Dynamic breadcrumbs use the navigation registry and shorten UUID segments to eight characters. Customer workspace selection and staff context must remain visibly distinct.

Nested pages render a separate ghost `BackRow` with left arrow immediately above `RecordHeader`, linking one route level up. Wrap the pair in `space-y-3`. Header actions remain available for operations and cross-links. `RecordHeader` contains title, one muted metadata line, the primary record state when useful and right-aligned actions; do not add an initials avatar there.

For ordinary detail pages, use a responsive `lg:grid-cols-3` grid: operational content spans two columns, reference data occupies the side track. Use stat tiles with muted uppercase labels and tabular numeric values, shadcn `Item`/`ItemSeparator` for record lists and definition rows with `Separator` for attributes. Related records open from their names or numbers (§3); statuses reuse the shared maps.

When an agent has independent facets, use tabs under its record header, such as configuration, knowledge, connections and activity, with counts where useful. Dense workflows can have dedicated pages. Preserve the shared shell, form, feedback and loading rules across the customer editor, upload journey and chat.

Acachuchazo's credit-line meter, financial layouts, KYC tabs and single-customer mock overlay are domain-specific examples, not Agentonic features. Apply the underlying composition rules to agents, submissions and deployments. Synthetic fixtures must be clearly identified and isolated from real workflows; never display fabricated deployment health or costs as live data. Agentonic logo/favicon and custom login composition remain implementation work; the approved preset supplies the initial theme.

## 8. Agentonic workflow clarity

The customer app must distinguish an editable draft, a frozen submission awaiting review and the currently deployed version. Clearly label staging previews, selected source scopes and requested capabilities. Customer actions create, personalize, preview and submit; staff actions review and deploy through the established approval boundary. Shared visual components do not collapse those responsibilities.

Keep chat access, configuration management, transcript access and knowledge sharing separate in the interface. Explain what is being shared before granting it. A connection's knowledge-import scope and live tool permissions are separate choices. Display unknown cost as unknown, and show deployment progress from observed status rather than treating a queued command as a successful release.



## 9. States, badges, metadata and icons

**Owner direction, 2026-09-15. Required across both apps.**

### 9.1 Choose emphasis by meaning and hierarchy

| Information | Required default | Example |
|---|---|---|
| Primary record state | Text badge, with a meaningful state icon when useful | Agent `Activo`, proposal `En revisión` |
| Nested outcome or secondary state | Unboxed icon + text | `✓ Superada` beneath an evaluation |
| Familiar binary indicator in a labeled compact context | Standalone accessible icon | Prompt readiness beside its character count |
| Count or progress | Plain text with tabular numerals | `8/10 superadas`, `3 seleccionadas` |
| Permission, environment, object type or preview context | Plain/muted text, optionally a type icon | `Solo lectura`, `Prueba privada` |
| Editing feedback or unmet prerequisite | Inline text near its action | `Cambios sin guardar` |
| Historical decision | Secondary text and available provenance | Approval decision and date |

Badges primarily represent an existing domain state: a table status/outcome, a persisted decision (including JSON criteria), or an authoritative server-derived state such as approval validity. A boolean, count, existing link or local form condition does not become a domain state merely because a component can color it.

Eligibility does not require rendering a pill everywhere. Use **one primary badge per focal row/header** as the default, not a page-wide quota. Independent records in a collection may each need a badge. When a parent has the primary badge, its child outcomes use inline indicators. Exceptions remain explicit and easy to find without surrounding every successful row with green.

Do not use pills for counts, permission labels, selected knowledge, environment, route availability, static `Borrador` labels on every asset, or prompt-length validation. Do not replace pills with colored icon tiles/circles that preserve the same visual clutter. Repeated context belongs at the section level.

### 9.2 Shared state vocabulary and truthful precedence

- Use `packages/ui/src/lib/badge-status.ts` for descriptors and `components/status-badge.tsx` for rendering. Descriptors contain the label, tone and icon; they are safe to import in server and client code. Domain maps must cover every known state and default unknown strings to slate `Estado desconocido`.
- Primary status wrappers and `DomainStatus appearance="badge"` render badges. `DomainStatus` defaults to inline; `CriterionStatus` renders the customer's decision inline. Application components must not build independent badge-color ternaries.
- Actual success/readiness/approval uses success; waiting/required attention uses warning; processing/review uses sky; requested changes uses orange; failure/rejection/revocation uses error; cancellation, absence and unknown values use slate. Expired approval uses warning. Draft lifecycle uses violet. These meanings apply consistently across both apps and both renderings.
- Customer acceptance of a criterion is **not** agent evaluation success. Use neutral `Aprobada por el cliente`, `Confirmada` for legacy confirmed evidence, `No aplica` for a valid exclusion and `Pendiente` for an undecided criterion. Do not turn exclusions into failed tests.
- Receipt headers prioritize **current approval validity**. A historical approval can coexist with lost validity; show `Aprobación no vigente` prominently and retain the historical decision/date below. Preserve backend-derived expiry/revocation; never infer renewed validity from passing historical results or invent a reason from a boolean.
- Submission state, review state, run state and case outcome remain separate concepts. An older passed run does not prove that the current review or deployment is approved.
- Preserve document precedence: an available ready version remains usable during reprocessing; otherwise active processing takes precedence over an old failure. Do not classify unknown values as known unprocessed states.
- Counts are descriptive, not success indicators. Missing/unavailable evidence must not become a green `0/0` success. Approval is never deployment.
- Expected answers and actual agent responses use neutral content surfaces. Green belongs to the recorded result, not to the response merely because it exists.

### 9.3 Icons and accessibility

- Use Lucide: check for pass/readiness, clock for waiting, activity for processing, alert for attention, X for failure, ban for revocation, pause for paused and archive for archived. Reuse the domain descriptor instead of choosing a new symbol at each call site.
- A badge may include one leading state icon when it improves recognition. Keep its visible label. Avoid adjacent duplicate icons that communicate the same state.
- Unboxed indicators have no pill border, tinted background or decorative container. Use approximately 14–16px icons; badge icons must remain legible (the shared primitive uses 12px).
- Visible text is required for ambiguous states and consequential outcomes. Icon-only presentation is limited to familiar compact indicators with an accessible name and sufficient surrounding context; add a keyboard-accessible explanation if visual meaning is unclear.
- Icons next to a visible label use `aria-hidden`. Do not add tab stops to decorative icons. Preserve keyboard operation and focus styling of disclosures, menus and dialogs.
- Long Spanish labels must wrap without pushing disclosure controls off-screen. Inspect mobile and both themes. Color must never be the only signal.
- Animate only verified active work when useful, with reduced-motion support; static icons are sufficient. A spinner must not imply execution merely from a queued request.

### 9.4 Review checklist

Before accepting UI changes, identify each remaining badge's domain source and why it owns primary emphasis. Inspect parent/child repetition and compare the same state across apps. Review synthetic examples for all-pass, failure/attention, exclusions, legacy confirmation, cancelled/queued/running, expired validity with historical success, unknown state and unavailable evidence. Check skeleton geometry, responsive wrapping, keyboard access and theme contrast before updating the skeleton baseline. Run typecheck, lint, relevant tests and `pnpm skeletons:check`; never run a production build for routine verification.


**Customer agent list update (2026-09-16):** the only extra filter is a workspace multi-select, using repeated `workspace` URL parameters. No selection shows all active memberships; existing single-workspace URLs still select that workspace. Each selected workspace is read in its own verified transaction, and failed reads fail the complete listing. Rows retain trusted workspace IDs for links/actions. The sortable Espacio de trabajo column replaces Instrucciones; instruction character count is the leftmost Recursos item with a document icon and an accessible readiness tooltip. Limpiar restores all workspaces and clears table search. Agent creation offers a workspace choice when several selected workspaces permit creation. The loading state mirrors the filter card and seven-column table.

**Badge restraint and empty cards — owner direction, 2026-09-17.** Reserve a badge for a record's primary state or a distinct authorization/deployment state needed for scanning. Do not repeat the same approval across page headers, card headers and decision feedback. In proposal receipts, Estado is the third summary field beside Agente and Versión. Counts, budgets, capabilities, access descriptions and secondary review phases use text; individual criteria/results use quiet icons with explicit labels. Evaluation totals use a numeric summary in the card body, never a badge. The denominator is the number of recorded results, not a claim that every planned case has completed. Approval, submission and deployment badge colors come from shared maps, with distinct colors within each family; equivalent states use the same map across both apps. “Sin aprobación” is slate; “Vencida” is yellow. Text always names the state, so color is never the sole signal.

Empty or unavailable card content uses the shared `CardEmptyState`: a muted, dashed, bounded-height frame with a short title and useful next step. It must distinguish absent content, work in progress and authorization-limited content. A version without approval always explains the pending approval and directs the reader to Propuestas; do not render a blank package footer. These presentation rules do not change consent, review, retention or deployment authority.

## 10. Later proposal presentation decisions

The compact Propuestas table, five derived proposal states, version/revision descriptors, frozen configuration receipt and criteria/results dialogs in architecture §39.6 supersede earlier proposal presentation examples. Preserve distinct approval, submission and deployment colors from the shared maps.

**Agent state columns — owner direction, 2026-10-06.** Both agent lists replace their state columns with **Versión en uso** and **Próxima versión** (architecture §55). In the customer list they replace En revisión, Actual and Estado, and are the last two columns; the loading state now mirrors six columns. In Admin they replace Despliegue and Estado; Agentes has no ID column, because the name is the link, and its Capacidades cell no longer repeats the version number, which only the version columns show (2026-10-07). Since 2026-10-07 each list shows the version in use's state as a lone **Despliegue** badge, followed by **En reposo**; Versión en uso and Próxima versión are labelled stacks (Versión, Entorno; Versión, Estado), with the next version's state inline (§3.1). Labels and colours come from the deployment, proposal and approval maps. Every agent name in Admin is a blue underlined link to the agent page; in Revisiones the review number opens the review. Vencimientos groups servers and evaluators by place in labelled groups, not tabs, so no lapsed registration is hidden.

**Admin layout — owner direction, 2026-10-06 (evening).**

- **Place names:** staff screens name where something runs by its host, `vm-agents-01`, or "Local (desarrollo)", while each environment has one host. Customers keep "Servidor de pruebas".
- **Servers by place:** Despliegues groups its servers and evaluators by place in labelled groups, like Vencimientos (shared `PlaceGroups`).
- **Workspace names:** a workspace's name always carries the sidebar's workspace icon (shared `WorkspaceName`), in tables, cards and headers. Cells that stack an agent over its workspace leave a small gap between the lines.
- **One fact per cell:** a state badge never shares its cell with a secondary state. Deployment tables and both agent lists give **En reposo** its own column ("Sí", "No", or "No aplica" when not running); in the agent lists it follows Versión en uso (2026-10-07).
- **Long lists open a dialog:** a cell that would list many places (Runtime → Instalada en) shows a count that opens a dialog with the full list.
- **Metric tiles** (the Admin agent page) show their value as prominent text in its state's colour, never a badge. Every tile keeps the same three rows (label, value, detail), with a placeholder when a detail is missing, so their text lines up.
- **Table text** stays at 12px under the Nova preset, whose body text is 14px: the shared `Table` sets it once, and buttons in cells and headers follow. Inline status indicators take the surrounding text size. Data cells stay on one line, and a wide table scrolls within its own area. Only free text such as error messages, and tables inside dialogs, may wrap.
