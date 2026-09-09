# Agent Notes (TSTS Legacy)

Read and follow `../tsonic/docs/architecture/workspace-agent-policy.md` before
any work. This file contains only legacy-TSTS TS-Go fidelity, compiler-state,
and verification rules.

## TS-Go Contract

- The frontend target is the exact TS-Go schema-level AST contract.
- The source of truth is the pinned TS-Go schema copied under `schema/tsgo/`.
- Do not hand-maintain AST kind values, node fields, aliases, or visitor/factory ordering.
- Do not target TypeScript 6 JavaScript object shapes.
- Do not target Go memory layout or pointer identity.
- If the local schema or generated output drifts from the pinned TS-Go contract, fail hard.

## Compiler State Mutation

- TSTS allows controlled compiler-state mutation **only where TS-Go mutates the equivalent** AST `Node`, `Symbol`, `Type`, `FlowNode`, `Program`, or `EmitContext` state (e.g. `node.parent`, `node.symbol`, `node.locals`, `node.flowNode`, `node.nextContainer`, `symbol.declarations`, `symbol.members`).
- The mutable fields must be declared **centrally** on the corresponding interfaces/types, not bolted on ad hoc.
- Banned: arbitrary ad-hoc mutation, `as any` / `as unknown as` writes, and parallel **side-table substitutes** (e.g. `symbolByNodeId.set(getNodeId(node), symbol)`) — unless upstream TS-Go itself uses an equivalent separate table/link object for that exact state.
- Rationale: the binder/checker/transformer/emitter port is 1:1 with TS-Go, which shares state through AST/Symbol/Flow/links. Side tables create a permanent translation layer that diverges from upstream and hides silent misses. (Decision: codex review-036, AST option A.)

## Testing Workflow

- Schema checks must run before trusting generated AST code.
- Parser/scanner tests must compare against TS-Go behavior, not approximate TypeScript expectations.
- Golden files may only encode intended external behavior.
- Never weaken tests to match an implementation bug.
