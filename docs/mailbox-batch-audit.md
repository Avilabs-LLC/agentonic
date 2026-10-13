# Can an agent handle "process my last 10 emails"? Audit, 13 October 2026

On 13 October Nico asked NicolAI-Mail, in Chats:

> Revisa mis últimos 10 correos y aplica el procesamiento completo: clasifícalos con su etiqueta correspondiente y hazme el resumen estructurado de cada uno. Prepara los borradores para aquellos que requieran mi respuesta, y al final enumera todas las tareas pendientes, citas y alertas críticas detectadas.

It is the agent's core job, as its own instructions define it. It failed twice over:

- The finished answer was refused. That was a bug, fixed in §66 (migration 69, 0.38.0, installed 13 October).
- Even without that bug, the turn could not have done what was asked. It read 2 of the 10 emails in full, spent the rest of its allowance on web searches nobody asked for, and could not prepare any drafts.

This page measures the whole platform against that one request. Facts come from the code at `cc3101b` and from the failed turn's records. Estimates say so.

## What the request needs

| Step                                             | Tool work                                                                        | Model work                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Find the last 10 emails                          | 1 Gmail search                                                                   | —                                                    |
| Read them well enough to classify and summarize  | 10 messages; long ones in full, ideally by thread                                | —                                                    |
| Classify, summarize (4 fields + ≤3 bullets each) | —                                                                                | ≈ 600–900 characters per email: 6,000–9,000 in total |
| Draft replies for those that need one            | One draft proposal per email needing a reply (say 3–5), as replies in the thread | ≈ 500–1,500 characters each                          |
| List tasks, appointments and alerts              | —                                                                                | ≈ 1,000–2,000 characters                             |

So a good answer is roughly 8,000–12,000 characters, about 2,500–4,000 output tokens before reasoning (estimate), plus 3–5 proposals.

## What one turn can do today

| Limit                         | Value                                                                                      | Where                                                                                                                               | Effect on this request                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Gmail calls per turn          | **3**, drafts included                                                                     | runtime `MAILBOX_CALLS` (`packages/runtime/src/agent/turn.ts`), `turnCeilings.gmailCalls`, worker turn spec, database (3 proposals) | One search + 2 reads, then every Gmail tool disappears, including draft creation. **Blocking.**                             |
| A Gmail write ends the turn   | The first proposal records the fixed "He preparado una acción de Gmail…" answer            | `apps/worker/src/broker.ts` (`proposalAnswer`)                                                                                      | At most one draft, and then no summary. **Blocking.**                                                                       |
| Search results                | ≤10 messages, 500-character excerpts, no thread ID                                         | `apps/worker/src/gmail.ts`                                                                                                          | Thin for summaries with tasks and deadlines; can't group by thread.                                                         |
| Thread reading                | None: no thread operation                                                                  | `packages/contracts/src/gmail.ts`                                                                                                   | The agent's rule "never process an email outside its thread" can't be followed.                                             |
| Drafts as replies             | Not possible: a draft has only to/cc/bcc/subject/body                                      | `gmailMessage`, `packages/connectors/src/google.ts`                                                                                 | A "reply" draft is a new email outside the thread. **Wrong result.**                                                        |
| Tool calls per model response | 1 (`parallel_tool_calls: false`; the broker rejects more)                                  | `apps/worker/src/providers.ts`, `broker.ts`                                                                                         | 10 reads + 4 drafts would need 15+ sequential model calls, with a context that grows each time.                             |
| Model and tool calls per turn | 8 tool calls, 9 model calls when web is granted (12 ceiling)                               | `turn.ts`, `turnCeilings`                                                                                                           | Not enough for the batch even with more Gmail calls.                                                                        |
| Web pressure                  | With web granted, every call carries "At most N tool calls remain" and the research policy | `turn.ts`, `instructions.ts`                                                                                                        | Once Gmail ran out, the model spent 5 calls on the web. **Wasted time and cost.**                                           |
| Turn deadline                 | 110 s with tools (65 s research + 35 s final answer)                                       | `apps/worker/src/runtime.ts`, `turn.ts`                                                                                             | The failed turn's final call took 35.0 s for 2,500 output tokens, at the limit. A full answer needs about 2×. **Blocking.** |
| Database turn window          | Every step of a chat turn older than 2 minutes is refused, and its envelope expires then   | `staging_worker` (found while building §67)                                                                                         | Even with longer runtime timeouts, a turn past 2 minutes loses its answer. **Blocking.**                                    |
| One model call                | ≤45 s ceiling; ≤4,096 output tokens (reasoning included) at low/medium                     | `turnCeilings.modelTimeoutMs`, `apps/worker/src/preview-models.ts`                                                                  | A 3,000–4,000-token answer plus reasoning would come back incomplete or time out. **Blocking.**                             |
| Answer length                 | 12,000 characters                                                                          | `turnAnswer` contract and database                                                                                                  | At the edge of what this request needs.                                                                                     |
| Follow-up turns               | Previous answers only (last 9); no tool results, message IDs or confirmed actions          | `staging_worker` `context`; outstanding B8                                                                                          | Splitting the job over turns means searching again each turn, and the agent can't see which drafts were confirmed.          |
| Confirmations                 | One card per write, valid 10 minutes; 30 writes per member per hour                        | Gmail migrations                                                                                                                    | Fine for 3–5 drafts, if one turn could propose them.                                                                        |
| Gmail labels                  | Not supported (inbox changes were excluded from v1)                                        | `docs/gmail-connection.md`                                                                                                          | Classification can only be text, which the agent's instructions allow.                                                      |
| Writing style                 | Aprender mi estilo writes a guide into a collection; NicolAI-Mail has no collections       | configuration                                                                                                                       | "Imitate Nicolas's tone" has nothing to imitate. Configuration, not platform.                                               |
| Budget                        | US$20 period; this turn cost about US$0.21                                                 | ledger                                                                                                                              | Not a constraint.                                                                                                           |

## Why the evaluation passed anyway

NicolAI-Mail was approved on 9 October with GPT-5.4 (medium) and GPT-6 Astra (low), 9 cases out of 9:

- the 4 **business** cases, written from its instructions, all pasted the emails into the question, so no tool was used;
- the platform's Gmail cases used mailboxes of 1–2 messages and a single write;
- no case asked for a batch, so none came near 3 Gmail calls, 35 s, 4,096 tokens or 12,000 characters.

Fixtures allow up to 10 messages per case, but nothing writes such a case. **An approval says the agent behaves; it doesn't say the platform can carry its job.** That is why a first real request found two structural problems.

## Two more weaknesses this incident showed

- **Errors without causes.** The broker reports any refusal or protocol problem as `runtime_mismatch`, the chat shows the generic "No se pudo completar la respuesta.", and the job log carries no diagnostic. Finding the §66 cause took the ledger and the live function definition.
- **No end-to-end test at real limits.** Database tests replay curated migration lists (one stops at migration 32), and nothing runs a realistic turn through the runtime, broker and database together with real ceilings.

## Verdict

Before §67 the platform could answer questions about **one or two** emails and propose **one** change per turn. It could not carry an inbox-processing job of the kind NicolAI-Mail was built for. Six limits blocked that request:

- Gmail calls per turn;
- a write ending the turn;
- the turn deadline;
- the database's 2-minute turn window;
- the single model call's time and output;
- drafts that can't be replies.

Each was a deliberate, conservative bound from the first Gmail slice (18 September), and none was revisited when agents moved to real mailboxes.

## What changed (B9, architecture §67)

The owner decided on 13 October:

- each draft keeps its own confirmation card, up to 10 per turn;
- a mailbox turn may run about 4 minutes;
- the batch evaluation case, diagnostics and B8 ship together.

Runtime 0.7.0 declares `mailboxBatch`, and only its turns change:

1. **Allowances of their own.** 6 Gmail reads and 10 proposals, apart from the web's 8. Proposals return to the model, and the platform appends how many await confirmation.
2. **Several tool calls per model response**, up to 5.
3. **Searches with 2,000-character excerpts** and each message's thread ID.
4. **Replies in the thread.** A draft names the message it answers. The platform sets the thread and reply headers on confirmation, and the card says so.
5. **Web only when needed.** No research pressure until the model uses the web.
6. **Room for the answer.**
   - Any call may write the answer: 12,000 output tokens and up to 120 s.
   - The broker's deadline is 240 s, and the database window is 5 minutes.
   - Answers may hold 30,000 characters.
7. **B8.** The next turn sees its earlier Gmail actions, with outcome and IDs.
8. **The batch evaluation case.** `platform-gmail-batch`: 10 synthetic emails, 3 needing a reply. It is required of mail agents on a batch runtime.
9. **Diagnostics in the job log**, and a clear chat message for `runtime_mismatch`.

Still open:

- thread reading (a thread operation);
- Gmail labels;
- a style guide for NicolAI-Mail, which needs a collection;
- streaming a long answer as it is written.

NicolAI-Mail needs a new version on runtime 0.7.0 (outstanding N20).
