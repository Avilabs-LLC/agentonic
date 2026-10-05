# Agentonic runtime

The agent engine. Each release is packaged (`pnpm package:runtime`) into an immutable, content-addressed artifact: one bundled Node 22 entry point (`src/surfaces/preview.mjs`), the platform policy and a checksummed manifest. Approval binds the artifact's hash, and evaluation, preview and staging all run those exact bytes.

The runtime runs in a child process with no credentials, network client or listener. It verifies the frozen candidate, composes instructions, offers tools, runs the bounded loop and parses the answer. Every model and tool call is a request to the platform broker over private IPC (broker protocol 2, `packages/contracts/src/runtime-protocol.ts`), and the broker decides: pinned model controls, live grants, contract argument schemas, metering, one execution per model-returned call, and the recorded answer. Lint rules keep provider, database, connector, process and network code out of this package.

- `src/agent/turn.ts`: the loop and its limits.
- `src/agent/instructions.ts`: platform rules and research policy.
- `src/agent/envelope.ts`: frozen-candidate verification.
- `src/tools/registry.ts`: tool descriptions shown to the model.

A behavior change is a new runtime version: bump `package.json`, commit, run `pnpm setup:preview`, then install it next to the existing runtimes with `pnpm runtime:install`. Running deployments keep the runtime they were approved with. See architecture §40.
