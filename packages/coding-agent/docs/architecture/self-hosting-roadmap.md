# Self-Hosting Roadmap

This is the bootstrap order for getting pi to build pi.

The rule is simple: improve continuity first, then delegation, then learning.

## Phase 1: Get It Off the Ground

### 1. Add a real `/handoff`

Why first:
- it gives clean-session continuity without needing a full task runtime
- it makes long work survivable
- it creates a reusable artifact that humans and agents can both inspect

Best method:
- use an explicit handoff document, closer to `can1357/oh-my-pi` than to implicit branch-only summaries

Best insertion points in Bindery:
- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/docs/tree.md`

### 2. Add one minimal `task` contract

Why second:
- self-hosting is much easier once work can be split cleanly
- a strict parent-child contract is enough at first; a swarm is not

Best method:
- parent sends goal, constraints, relevant files, and done definition
- child returns one compact result summary

Best insertion points in Bindery:
- `packages/coding-agent/src/core/session-manager.ts` via custom entries and custom messages
- `packages/coding-agent/src/core/agent-session.ts` for runtime injection

### 3. Externalize large tool output

Why third:
- this is one of the cheapest token wins available
- it makes long coding sessions much more stable

Best method:
- keep short context summaries in-session
- store full output as retrievable artifacts or file-backed payloads

Best insertion points in Bindery:
- `packages/coding-agent/src/core/messages.ts`
- `packages/coding-agent/src/core/compaction/utils.ts`
- `packages/coding-agent/src/core/tools/truncate.ts`
- `packages/coding-agent/src/core/extensions/wrapper.ts`

### 4. Split the system prompt into layers

Why fourth:
- this makes later tasking and handoff work much easier to reason about
- it reduces the chance of turning the prompt into one growing string blob

Best method:
- move from one large builder to ordered layers: base, project, runtime, task, subagent

Best insertion points in Bindery:
- `packages/coding-agent/src/core/system-prompt.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/resource-loader.ts`

## Phase 2: Teach pi From Its Own Sessions

### 5. Turn session mining into a first-class loop

Why now:
- once handoff and tasking exist, session logs become much more useful training material
- repeated instructions can become durable behavior instead of repeated chat overhead

Use:
- `scripts/session-transcripts.ts`

Promote repeated patterns into:
- `AGENTS.md`
- skills
- prompt templates
- these architecture notes

### 6. Add a safety loop

Before adding more autonomy, require:
- a clear check or test gate before declaring work done
- a way to undo or recover from bad edits
- a rule that self-improvement changes update docs in the same PR

## Phase 3: Add Heavier Systems Only If Needed

Build these later, not first:
- resumable background worker sessions
- cross-session memory
- trigger-driven rule injection
- checkpoints or shadow repos
- repo-map indexing

These are valuable, but they are not the best first moves for getting pi off the ground.

## Maintenance Rules

Whenever one of the roadmap areas changes, update this file and `comparative-methods.md` in the same PR.

Keep the docs focused on:
- what the chosen method is
- why it won
- where it lives in Bindery
- what was intentionally deferred

Do not let this file turn into a wish list. It should stay opinionated and executable.
