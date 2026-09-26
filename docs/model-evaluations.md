# Model evaluations

Implemented 19 September 2026, replacing confirmation-triggered single-model evaluation.

Customer flow: submit version → generated criteria → confirm criteria → **Evaluar modelos** → choose models/levels and authorize a spending limit → dismissible progress → model aggregate → situations by level. Repeat runs, including after all models pass, require a fresh explicit authorization. Editing criteria requires reconfirmation. The selected models/levels are retained for the next run; historical pre-matrix results do not restrict the first matrix to mini.

The table's **Criterios** and **Resultados** cells open separate dialogs. A model only counts as 100% when every selected level has passed all situations. Partial, interrupted and pending cases are not passes. Earlier runs remain available from the results history and identify their criteria revision. Approval receipts retain the actual approved criteria and matrix.

The catalog is shared by the preview selector and evaluation confirmation:

| Model | Reasoning levels | Default exploratory level |
| --- | --- | --- |
| GPT-5.4 mini | none, low, medium, high, xhigh | medium |
| GPT-5.4 | none, low, medium, high, xhigh | medium |
| GPT-6 Astra | low, medium, high, xhigh, max | low |
| GPT-4.1 mini | not supported | not applicable |

The API account's read-only model listing confirmed all four identifiers are available. Capabilities and standard short-context token rates were checked against [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4), and [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra). Rates remain estimates, not invoice reconciliation. High/xhigh/max reserve up to 16,384 output tokens, other reasoning levels up to 4,096; legacy mini uses 1,000. Reasoning output is metered. Budget exhaustion is surfaced without silently increasing authorization or retrying unknown outcomes.

Staff can follow subsequent runs from the approval receipt while its initial view remains pinned to the approved evidence (migration 37).

Each immutable batch freezes its model list, criteria revision/hash, request ID and authorized budget. Each child execution freezes its response model and reasoning level. Provider reservations share the batch ceiling; previous usage is retained. Customer commands remain restricted-role functions with workspace locks and verified identity. Worker protocol 3 gates execution; an older worker cannot process matrix jobs. The primary semantic evaluator is currently GPT-4.1 mini using the versioned v3 rubric; executor and evaluator are separate roles. The v3 rubric includes configured permissions and the isolated read-only scope and flags conflicting expectations as uncertain. Tests cover authorization, first run, reruns, edited criteria, stale confirmation, duplicates, cumulative reservations, cancellation, aggregate reporting, approved live choices and exact provider parameters.

Live conversations accept only model/effort pairs in their deployment approval. Existing legacy deployments retain the model they were reviewed against. New preview conversations default to GPT-5.4 mini/medium. Selection never increases tool permissions or spending limits. Independent evaluation situations currently do not cover multi-turn switching or actual external tool execution; these remain separate coverage work.

Nonproduction rollout: migrations 35–37 applied; measured evaluation worker protocol 3 installed/registered on the existing isolated VM runtime. Local preview worker and local/Azure staging brokers updated. Existing runtime artifact retained; no customer version is automatically evaluated or activated.
