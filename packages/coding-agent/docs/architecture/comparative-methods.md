# Comparative Methods

This document compares methods, not brands. The goal is to keep the strongest parts of similar systems without inheriting all of their complexity.

## Task Handoff

### Session-tree summary handoff

- Method: summarize work when leaving a branch and inject that summary when returning later
- Best fit: in-session continuity without adding a separate task runtime
- Exemplar: Bindery branch summaries in `packages/coding-agent/src/core/compaction/branch-summarization.ts` and `packages/coding-agent/src/core/session-manager.ts`
- Pros: native to the current session tree, append-only, easy to audit
- Cons: lossy, not enough by itself for multi-worker delegation

### Handoff document

- Method: generate a structured handoff document and start or resume from a clean session with that document in context
- Best fit: explicit resets, fresh sessions, user-visible continuity
- Exemplar: `can1357/oh-my-pi` in `docs/handoff-generation-pipeline.md` and `packages/coding-agent/src/prompts/system/handoff-document.md`
- Pros: portable, readable, low ambiguity, easy to debug
- Cons: quality depends on the handoff prompt and what gets captured

### Strict task packet and summary return

- Method: parent sends a compact task contract, child returns one structured result summary
- Best fit: lightweight subagents without full swarm machinery
- Exemplars: `can1357/oh-my-pi` in `packages/coding-agent/src/prompts/tools/task.md`; `RooCodeInc/Roo-Code` in `src/core/prompts/tools/native-tools/new_task.ts`
- Pros: clear boundaries, easy to review, good for parallel work
- Cons: parent prompt quality matters a lot, schema drift becomes painful if left loose

### Resumable worker session

- Method: keep child session identity alive and resume it later instead of spawning from scratch
- Best fit: long-running async delegation
- Exemplar: `code-yeongyu/oh-my-openagent` in `src/tools/delegate-task/background-continuation.ts` and `src/tools/delegate-task/parent-context-resolver.ts`
- Pros: largest token savings once delegation is common
- Cons: much more stateful, higher failure surface, harder to reason about in a stripped core

### Planner to editor baton pass

- Method: one model plans, another edits
- Best fit: simple role separation without general subagents
- Exemplar: `Aider-AI/aider` in `aider/coders/architect_coder.py`
- Pros: easy to bolt on, useful for planning vs implementation splits
- Cons: weak continuity, not a real task runtime

## Context Reduction

### Iterative compaction with recent-tail retention

- Method: summarize older context, keep the recent tail verbatim, merge prior summaries, track file operations
- Best fit: the first serious context management system in a minimal core
- Exemplars: Bindery in `packages/coding-agent/src/core/compaction/compaction.ts` and `packages/coding-agent/docs/compaction.md`; `can1357/oh-my-pi` in `packages/coding-agent/src/session/compaction/compaction.ts`
- Pros: stable, incremental, fits existing session model, easy to recover from overflow
- Cons: still lossy, summary quality affects later turns

### Fresh-start condensation

- Method: collapse old history into a summary and hide the original messages instead of deleting them
- Best fit: stronger resets plus rewind safety
- Exemplar: `RooCodeInc/Roo-Code` in `src/core/context-management/index.ts` and `src/core/condense/index.ts`
- Pros: stronger context reset than simple compaction, preserves rewind options
- Cons: more metadata, more replay edge cases, heavier runtime logic

### Artifact-backed large output

- Method: keep a short summary in context and store full output outside the prompt
- Best fit: immediate token relief across tools
- Exemplars: `anomalyco/opencode` in `packages/opencode/src/tool/truncation.ts`; partial version already exists in Bindery bash output via `packages/coding-agent/src/core/messages.ts`
- Pros: high ROI, low complexity, model-agnostic
- Cons: needs a retrieval story so the agent can get back to full output when needed

### Repo map or structural code compression

- Method: send a ranked map of files and symbols instead of broad raw code context
- Best fit: large repos before conversation history dominates
- Exemplar: `Aider-AI/aider` in `aider/repomap.py`
- Pros: strong codebase compression before the chat grows
- Cons: highest implementation complexity in this set, not a direct solution for task-state continuity

### Triggered rule injection

- Method: inject rules or skills only when the trigger matches, instead of paying their token cost every turn
- Best fit: growing instruction libraries
- Exemplars: `can1357/oh-my-pi` in `docs/ttsr-injection-lifecycle.md`; `anomalyco/opencode` in `packages/opencode/src/session/instruction.ts`
- Pros: lower default token usage, keeps prompt surface cleaner
- Cons: bad triggering or precedence rules can make behavior feel inconsistent

### Cross-session memory summary

- Method: inject compact durable knowledge from prior sessions at startup
- Best fit: repeated workflows across days, not within one long task
- Exemplar: `can1357/oh-my-pi` in `docs/memory.md`
- Pros: reduces repeated restatement and bootstrap cost
- Cons: stale memory can contaminate later sessions if it is not pruned aggressively

## System Prompt Architecture

### Single builder

- Method: build the full prompt in one place
- Exemplar: Bindery in `packages/coding-agent/src/core/system-prompt.ts`
- Pros: simple, debuggable, cheap to change early on
- Cons: turns brittle as soon as you add modes, tasks, subagents, and runtime overlays

### Ordered prompt chunks

- Method: assemble prompt parts in a fixed order with clear boundaries
- Exemplar: `Aider-AI/aider` in `aider/coders/base_prompts.py` and `aider/coders/base_coder.py`
- Pros: easiest upgrade path from the current Bindery prompt builder
- Cons: less flexible than a richer prompt template registry

### Layered discovery plus runtime overlays

- Method: combine base prompt, project files, loaded skills, runtime state, and final per-turn overrides
- Exemplars: Bindery in `packages/coding-agent/src/core/agent-session.ts` and `packages/coding-agent/src/core/system-prompt.ts`; `anomalyco/opencode` in `packages/opencode/src/session/system.ts` and `packages/opencode/src/session/llm.ts`
- Pros: matches pi's architecture well, keeps responsibilities separated
- Cons: needs explicit precedence rules or it becomes hard to debug

### Mode or role overlays

- Method: keep one base prompt and swap role sections depending on mode or agent category
- Exemplar: `RooCodeInc/Roo-Code` in `src/core/prompts/system.ts` and `src/shared/modes.ts`
- Pros: good specialization without full prompt duplication
- Cons: adds configuration and prompt-surface area quickly

### Generated orchestration prompts

- Method: dynamically assemble prompts from categories, skills, and task metadata
- Exemplar: `code-yeongyu/oh-my-openagent` in `src/agents/dynamic-agent-prompt-builder.ts` and `src/plugin/skill-context.ts`
- Pros: powerful once you have a rich agent ecosystem
- Cons: too much machinery for a stripped core at the start

## Recommended Hybrid

For a stripped pi that needs to grow into self-hosting, the best mix is:

1. Bindery session tree and iterative compaction
2. oh-my-pi handoff document
3. oh-my-pi or Roo style strict task packet and summary return
4. opencode style artifact-backed large output handling
5. aider style ordered prompt chunks before any larger prompt framework rewrite

## Methods To Defer

Delay these until the simpler stack is working:

- resumable worker sessions
- full memory system
- TTSR or other advanced trigger engines
- shadow git checkpoints
- generated orchestration prompt graphs

Those ideas are useful, but they add complexity faster than they help in the first self-hosting stage.
