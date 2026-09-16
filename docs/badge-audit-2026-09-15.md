# Badge audit — admin and customer

**Date:** 2026-09-15

**Scope:** current working tree, including the pending review/receipt work. Source audit of both apps, their shared UI, contracts, Prisma models and relevant migrations.

**Status:** findings and proposed presentation rules; no application changes. This is an audit, not a replacement for the architecture contract.

**Implementation follow-up:** The owner requested these changes after the audit. They are now applied across both apps, with the authoritative rules in [the UI contract](ui/ui-contract.md). The inventory and findings below describe the original audited state.

## Conclusion

Badge overuse is concentrated in the shared UI, especially version receipts and evaluation breakdowns. The strongest fix is to establish visual hierarchy:

- Use a badge for the primary state of the record being inspected.
- Render nested outcomes as unboxed icons with text, even when those outcomes are persisted states.
- Render counts, permissions, environment, editing feedback and other metadata as ordinary text.
- Preserve distinctions between customer acceptance of a criterion, evaluation success, version approval and current approval validity.

Persisted state makes something eligible for a badge; it does not mean every occurrence needs one. A database column is also not the only legitimate source: persisted decisions inside JSON and authoritative server-derived validity are real domain information.

### Coverage

The inventory contains **40 application-level JSX badge sites in 22 files**: 34 direct `Badge` sites and six calls to the three shared status wrappers. Those wrappers contain another three internal `Badge` sites, excluded from the application count. Loops can render many badges from one site; these are source counts, not counts of badges on a screen.

- Customer routes contain two direct sites and consume the shared authoring, knowledge, preview, proposal and evaluation components.
- Admin routes contain no direct badge JSX, but consume the shared shell, roadmap, review queue, review detail, evaluations and approval receipt.
- Shared components account for the other 38 application sites. Searching only `apps/admin` would miss its badge usage.
- Searched badge wrappers, `badgeVariants`, `data-slot` references and rounded/color styling to catch related visual treatments.
- No authenticated browser review was performed. Responsive layout, visual contrast and actual rendered density remain implementation verification items. No customer content was opened or used as a fixture.

## Priority findings

### P1 — Receipts repeat success at several levels

**Evidence:** [SubmissionReceipt](../packages/ui/src/components/submission-receipt.tsx), [ProposalReceipt](../packages/ui/src/components/proposal-receipt.tsx), [ReceiptCriteria and ReceiptResults](../packages/ui/src/components/review-receipt-content.tsx).

The admin receipt renders a green `Aprobada` header, a green `x/y superadas` summary, a badge for every criterion, a badge for every result and another badge for approval validity. With C criteria and R results, the receipt can render C + R + 3 badges before the shared shell. The customer proposal receipt adds a submission badge, results-count badge, review-state badge and a badge per historical decision, alongside the same criterion/result lists.

These represent several different facts, but use nearly identical emphasis. Repeating the successful child outcomes also makes an actual exception harder to find.

**Recommendation:**

1. Keep one prominent current state for the version/review context.
2. Make `8/8 superadas` plain tabular text in the results heading.
3. Give each result a small unboxed icon and explicit label: `Check` + `Superada`, `X` + `No superada`, or `TriangleAlert` + `Requiere atención`. Successful rows can use neutral text and a restrained success icon.
4. Render criterion decisions as secondary icon/text, with their own vocabulary. A customer-approved criterion is not a passed evaluation.
5. Render historical decisions as a text timeline/list. Preserve dates, authors and feedback; a historical approval must not compete with current validity.
6. Keep current validity explicit. It can own the primary badge; the original approval decision can remain a historical fact in the metadata.

### P1 — A green approval headline can outshine an invalid approval

**Evidence:** [SubmissionReceipt](../packages/ui/src/components/submission-receipt.tsx), header at line 42 and validity at line 141; [receipt SQL](../packages/database/prisma/migrations/202609150021_approved_receipts/migration.sql).

The header is unconditionally green `Aprobada`, while a lower card can say `No vigente`. This is not a fabricated approval: the SQL function requires an approved submission and an approved decision. However, it separately returns `version_approval_valid(d.id)`, which can be false. The current visual hierarchy gives historical approval more prominence than current usability.

**Recommendation:** let the header express `Aprobación vigente` or `Aprobación no vigente`, using the authoritative validity result. Keep the historical decision and date below. Do not invent whether invalidity means expiry, revocation or changed prerequisites when the receipt only supplies a boolean. Passing results stay historical passing results; they do not restore validity.

The customer receipt similarly displays `submission.status` and the review flow's validity-aware status. Preserve both meanings, but make current validity prominent and render the historical submission decision as secondary text where they differ.

### P1 — State colors are assigned independently and disagree

**Evidence:** [ReviewFlowPanel](../packages/ui/src/components/review-flow-panel.tsx:263), [ProposalReceipt](../packages/ui/src/components/proposal-receipt.tsx:160), [AgentProposals](../packages/ui/src/components/agent-proposals.tsx:338), [EvaluationPanel](../packages/ui/src/components/evaluation-panel.tsx:439), [shared maps](../packages/ui/src/lib/badge-status.ts).

Examples from the current branches:

- `revoked` and `expired` fall through to sky in `ReviewFlowPanel`, but warning in `ProposalReceipt`. Submission `revoked` is error in the shared submission map.
- `needs_attention` falls through to sky in both review receipt/panel mappings.
- In `AgentProposals`, every flow state except fully reviewed `criteria_ready` is slate, including approval and error. The same badge switches between a count and a workflow state.
- `EvaluationPanel` maps cancelled, queued and awaiting-consent runs to sky along with running evaluations.
- A failed individual result is warning in `ReceiptResults` and error in `EvaluationPanel`.
- A submitted candidate is violet in `AgentWorkflow`, while the shared submission map uses warning for submitted proposals.

**Recommendation:** centralize label, tone and optional icon by domain. Use the same descriptor for badge and inline renderings. Keep domains distinct: preparation status, submission status, evaluation-run status, result outcome and criterion decision need explicit maps. Replace catch-all “everything else is sky” branches with exhaustive mappings and a neutral unknown state.

Suggested semantics: success for actual approval/pass/readiness; warning for awaiting action or attention; sky for work in progress; orange for requested changes; error for failure/rejection/revocation; slate for cancellation, neutral absence and unknown values. Expiry should visibly communicate lost validity, with a consistent warning treatment. These are presentation changes, not state-machine changes.

### P2 — Metadata has acquired the appearance of workflow state

Counts, access permissions, static draft labels, route availability, environment and preview context all use the same pill component as approval and failure. Some also consume green or blue status colors.

Examples include selected collection counts, skills/collection counts on frozen versions, preview message usage, `Gestionar`/`Solo lectura`, repeated `Borrador` labels and a green `Disponible` for a link that exists.

**Recommendation:** plain text with a suitable weight and optional type icon. Counts use tabular numerals. Editing feedback uses a compact inline message near its action. Section context should be stated once, rather than on every child.

### P2 — Related green surfaces reinforce the same ambiguity

[ReceiptTextFrame](../packages/ui/src/components/review-receipt-content.tsx:17) paints the agent's answer green even when its result failed or needs attention. The criteria dialog also paints the expected-answer block green before evaluation. [AgentWorkflow](../packages/ui/src/components/agent-workflow.tsx:244) gives the prepared-version icon a green background independently of approval.

**Recommendation:** use neutral content frames for expected/actual answers, identified by headings or message icons. Reserve outcome color for the actual result indicator. Prepared/frozen version icons should convey the object type without implying successful evaluation or deployment. Removing badge borders alone will not resolve these competing signals.

## State provenance

| Display | Actual source | Treatment |
|---|---|---|
| Agent lifecycle | `agents.status` | Keep badge in the agent table's Estado column. |
| Proposal lifecycle | `agent_submissions.status` | Keep as the primary proposal state; use inline text when nested below a primary version state. |
| Review lifecycle | `evaluation_preparations.status`, with SQL-derived display overrides for current approval/revocation/expiry | Keep a primary status indicator; consume the authoritative returned state. |
| Evaluation lifecycle | `evaluation_runs.status` | Keep one badge per independently inspected evaluation run. |
| Individual test result | `evaluation_results.outcome` | Valid persisted outcome; inline icon/text in the nested breakdown. |
| Criterion decision | `evaluation_preparations.criteria[*].reviewDecision` and immutable `evaluation_criteria_revisions.criteria` JSON | Valid persisted decision, not a separate criterion-table status. Inline in lists; an isolated criterion editor may retain one compact state badge. |
| Legacy criterion confirmation | `criterionDecisionLabel` combines decision/exclusion with confirmation context | Preserve `Confirmada` when there is no explicit individual approval; do not relabel it as a passed result. |
| Approval decision/history | `submission_review_decisions.decision` | Primary badge only for the current focal decision; historical entries use text. |
| Approval validity | Server function `version_approval_valid`, including current prerequisites | Important derived state; keep explicit and do not reduce it to the old approval decision. |
| Document readiness | View combines document-version readiness and processing-job state | Keep the document status badge. Preserve “ready version remains usable during reprocessing” precedence. |
| Access, counts, local editing, route availability | Permissions, array lengths, form state or static configuration | Text/icons; these do not require state badges. |

Relevant implemented provenance is in [Prisma models](../packages/database/prisma/schema.prisma), the [criterion-decision migration](../packages/database/prisma/migrations/202609150019_criterion_decisions/migration.sql), [review-summary migration](../packages/database/prisma/migrations/202609150020_review_summary/migration.sql) and [receipt migration](../packages/database/prisma/migrations/202609150021_approved_receipts/migration.sql). No schema changes are needed to reduce badge use.

## Complete application-site inventory

Line references describe the audited working tree. “Sites” counts JSX placements, not runtime repetitions. Paths below are shared UI components unless marked as routes.

| Component / placement | Sites | Reach | Recommended disposition |
|---|---:|---|---|
| [app-shell](../packages/ui/src/components/app-shell.tsx), 156 / 256: `Pronto`, `Desarrollo` | 2 | Both | Muted suffix for unavailable navigation; persistent icon/text environment label. Keep environment context clearly visible and truthful. |
| [foundation-roadmap](../packages/ui/src/components/foundation-roadmap.tsx), 78: `Disponible` / `Pronto` | 1 | Both | Link/arrow affordance for available destinations; muted text for upcoming ones. Route existence does not need green success. |
| [authoring-table](../packages/ui/src/components/authoring-table.tsx), 173: prompt readiness | 1 | Customer | Remove the Badge wrapper around the existing check/X. Keep accessible readiness text and character count; this is a length check, not a quality evaluation. |
| authoring-table, 250: submitted version state | 1 | Customer | Inline status next to each version; the separate agent Estado column keeps its badge. Retain both domains' information. |
| authoring-table, 291: agent state | 1 | Customer | Keep `AgentStatusBadge`. |
| [customer agent route](../apps/customer/app/(panel)/agents/[id]/page.tsx), 48: `Sin despliegue` | 1 | Customer | Plain deployment metadata with an appropriate icon. Currently a hardcoded launch-boundary statement; future operational state must come from data. |
| [agent-workflow](../packages/ui/src/components/agent-workflow.tsx), 195: editing/readiness | 1 | Customer | Inline `Cambios sin guardar` / `Sin cambios nuevos` / `Por preparar`, near the relevant action. |
| agent-workflow, 254: candidate/submission/preview availability | 1 | Customer | Separate prepared-version context from submission state and preview permission; avoid one badge switching among these meanings. Prefer inline stage text here. |
| [agent-asset-list](../packages/ui/src/components/agent-asset-list.tsx), 75: `Borrador` on each skill | 1 | Customer | Remove per-row pill; draft section already provides context. |
| [draft-editor](../packages/ui/src/components/draft-editor.tsx), 191: selected collection count | 1 | Customer | Muted count, e.g. `3 seleccionadas`. |
| [agent-capability-placeholder](../packages/ui/src/components/agent-capability-placeholder.tsx), 20: `Próximamente` | 1 | Customer | Plain availability copy; the existing description already explains it. |
| [customer preview route](../apps/customer/app/(panel)/agents/[id]/preview/page.tsx), 39: `Prueba privada` | 1 | Customer | Lock icon + visible text in header metadata. This describes context, not status. |
| [agent-preview](../packages/ui/src/components/agent-preview.tsx), 214: message usage / `Sin iniciar` | 1 | Customer | Plain `3 de 10 mensajes` or `Sin iniciar`. Do not infer session lifecycle from ID presence. |
| [knowledge-collections](../packages/ui/src/components/knowledge-collections.tsx), 64: permission | 1 | Customer | `Eye` / `Settings2` with `Solo lectura` / `Gestionar` as ordinary text. |
| [document-table](../packages/ui/src/components/document-table.tsx), 236: document readiness | 1 | Customer | Keep shared document status badge, with optional state icon. |
| [agent-proposals](../packages/ui/src/components/agent-proposals.tsx), 334: submission status | 1 | Customer | Keep primary row badge. |
| agent-proposals, 338: criteria count / flow state | 1 | Customer | Plain progress count or inline workflow text in its own column. |
| [review-criteria-dialog](../packages/ui/src/components/review-criteria-dialog.tsx), 290: current criterion decision | 1 | Customer | One badge can remain when editing a single criterion; centralize mapping and preserve pending/confirmed distinctions. Inline treatment is also sufficient if header context is clear. |
| [review-criteria-summary](../packages/ui/src/components/review-criteria-summary.tsx), 107: decisions per row | 1 | Customer | Unboxed icon/text. `No aplica` is a valid exclusion decision, not automatically a warning/error. |
| [proposal-receipt](../packages/ui/src/components/proposal-receipt.tsx), 53 / 125 / 160 / 188: submission, results count, flow, decisions | 4 | Customer | One primary current state; plain count; secondary inline review details; historical decision text. |
| [review-receipt-content](../packages/ui/src/components/review-receipt-content.tsx), 41 / 111: criterion and result rows | 2 | Both receipts | Unboxed icon/text; preserve the different meanings of accepted criterion and passed test. |
| [review-table](../packages/ui/src/components/review-table.tsx), 156 / 180 / 317: two `Pronto` labels and tab counts | 3 | Admin | Muted menu suffixes and plain tab counts. Its state-filtered tabs already establish row context; do not add a badge to every row. |
| [submission-review-layout](../packages/ui/src/components/submission-review-layout.tsx), 56 / 73: aggregate tests and attention | 2 | Admin | Primary state should describe the current review; plain test summary and an inline attention callout. `testsPassed` currently uses `some(...)` across records and must not be presented as proof of current approval. |
| submission-review-layout, 170 / 201: skill and collection counts | 2 | Both via version content | Plain counts in headings or metadata. |
| [review-flow-panel](../packages/ui/src/components/review-flow-panel.tsx), 263 / 331: flow and criterion state | 2 | Admin current wiring | Keep one correctly mapped flow badge; inline criterion decisions. |
| [evaluation-panel](../packages/ui/src/components/evaluation-panel.tsx), 439 / 500: run and individual outcomes | 2 | Both | Keep run badge; inline child outcomes. Map non-pass outcomes explicitly rather than treating every other string as failed. |
| [submission-receipt](../packages/ui/src/components/submission-receipt.tsx), 42 / 120 / 141: approval, result count, validity | 3 | Admin | One primary current-validity badge; plain count; historical approval/validity details as text. |
| **Total** | **40** | | |

The underlying [status-badge wrappers](../packages/ui/src/components/status-badge.tsx) remain useful; they should share descriptors with inline status renderings. Avoid moving all these local conditionals into a single generic “success boolean” component, which would lose domain meaning.

## Proposed presentation contract

### Choose the representation

| Information | Default representation | Example |
|---|---|---|
| Primary persisted or authoritative derived state | Badge with text; optional meaningful icon | `Clock3 · En cola` |
| Nested state/outcome | Unboxed icon + text | `Check · Superada` |
| Compact, familiar binary indicator in a clearly labeled column | Standalone icon with accessible label | Prompt check beside `350 caracteres` |
| Count/progress | Plain tabular text | `8/10 superadas` |
| Type, access, environment or context | Muted text, optional type icon | `LockKeyhole · Prueba privada` |
| Unsaved work or action prerequisite | Inline feedback near the action | `Cambios sin guardar` |
| Historical decision | Dated text entry | `Aprobada · [fecha]` |

Use one primary badge per row/header for the focal entity as the default, not a rigid page-wide quota. Several independent records in a table can each need a badge. A parent badge plus child statuses is legitimate; repeating the same filled pill treatment throughout the hierarchy is the problem. An exceptional child needs enough emphasis to remain discoverable.

### Icon rules

- Use existing Lucide icons. Suggested state icons: `Check` for pass/readiness, `Clock3` for waiting, `LoaderCircle` for verified active processing, `TriangleAlert` for attention, `X` for failure, `Ban` for revocation, `Pause` for paused, and `Archive` for archived.
- Add an icon inside a badge when it helps distinguish states or keeps a familiar pattern across a domain. Do not add one merely to decorate every badge.
- Standalone icons have no pill, tinted tile or circular background. Otherwise the same visual density survives under a different component name.
- Use visible text for ambiguous states and consequential outcomes. Icon-only is appropriate for familiar checks in a labeled compact context, not for the sole explanation of approval validity.
- If adjacent text names the state, the icon is decorative (`aria-hidden`). Icon-only indicators need an accessible name and a keyboard-accessible explanation when the meaning is not apparent visually. Do not add tab stops to every decorative icon.
- Avoid duplicate spoken labels and duplicate neighboring clock/check icons when moving an existing icon into a badge.
- Keep status tones centralized and readable in both themes. The current badge primitive forces direct SVGs to `size-2.5!`; review that 10px size before adding icons widely. Unboxed list indicators should normally be around 14–16px.
- Do not add a spinner based on an optimistic assumption of processing. Static labels still explain the state, and animation must respect reduced motion.

### Receipt hierarchy example

This is illustrative Spanish copy, not fabricated application data:

```text
Versión 4                         [Aprobación vigente]
Aprobada el [fecha] · No representa un despliegue

Criterios confirmados             6 situaciones
  ✓ Situación 1                   Aprobada por el cliente
  − Situación 2                   No aplica

Resultados de la evaluación       8/8 superadas
  ✓ Situación 1                   Superada
  ✓ Control de plataforma         Superado

Aprobación registrada
  Tipo / responsable / fecha / vigencia
```

For an invalid approval, the primary state becomes `Aprobación no vigente`; historical successes remain readable below. An excluded criterion remains an exclusion decision, without looking like a failed agent response.

## Implementation order and verification

1. **Update the UI contract with this owner direction.** Sections 21.2–21.3 currently prescribe `Pronto` badges and colors for non-state metadata; later notes also endorse selected-count and prompt-readiness badges. Narrow those rules so future work does not reintroduce the current pattern. Keep older implementation notes identifiable as historical.
2. **Centralize state descriptors and add an inline rendering option.** Retain shared domain wrappers. Keep text/tone/icon mapping independent of whether the caller requests a badge or inline indicator. Include neutral unknown handling; the document helper currently falls back to `Sin procesar`, so distinguish a recognized unprocessed state from an unknown value.
3. **Fix receipts and evaluation hierarchy first.** These provide the largest reduction in repeated success styling. Preserve current validity, historical decisions, exclusions, evidence and unavailable-content explanations.
4. **Replace metadata badges across both apps.** Counts, context, permissions, placeholders, prompt readiness and form feedback can then use the agreed text/icon patterns.
5. **Verify representative fixtures.** Cover all-pass; failed/attention results; exclusions; legacy confirmed criteria; queued/running/cancelled/error states; expired approval with successful historical evidence; unknown state; and unavailable private report. Never convert absent evidence into `0/0` success. Use synthetic fixtures only.
6. **Review light/dark, narrow layouts and accessibility.** Ensure long Spanish labels wrap, receipt summaries still open with keyboard input, exceptions remain visible and icons do not create duplicate announcements. Review all affected loading skeletons before recording baselines.
7. **Run checks relevant to the implementation.** Typecheck, lint, meaningful state-mapping/behavior tests and `pnpm skeletons:check`; update skeleton baselines only after review. No production build. Prisma generation/validation is only relevant if subsequent work changes database/contracts requiring it; this presentation audit requires no migration.

**Audit verification:** source inventory and provenance inspection only. Application tests, database commands and builds were not run because this change only adds the audit document. Existing working-tree changes were left intact.
