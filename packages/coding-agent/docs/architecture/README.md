# Architecture Research

This directory stores durable research for self-hosting the Bindery agent.

Keep only findings that are:
- proven by code or docs
- useful for future implementation decisions
- likely to matter across multiple sessions

Do not keep raw exploration logs here. Distill them first.

## Files

- `comparative-methods.md` - method-level comparison of how similar projects solve handoff, context reduction, and prompt architecture
- `self-hosting-roadmap.md` - the recommended bootstrap order for getting the agent to build itself

## Update Rules

Update these files in the same PR whenever behavior changes in any of these areas:
- session format, branch summaries, or compaction
- task delegation, subagents, or handoff flow
- system prompt assembly, AGENTS loading, or prompt layering
- tool output truncation, artifact storage, or replay behavior

When updating:
- prefer method-level conclusions over repo-by-repo notes
- keep exact Bindery file references near the relevant conclusion
- keep external references at the repo/path level so they can be re-verified later
- replace stale conclusions instead of stacking contradictory notes

## Intake Rule

Research is worth saving when it changes one of these:
- what should be built next
- where a feature should live in the codebase
- which implementation pattern should win
- which ideas should be deferred

If a finding does not affect a decision, leave it out.

## Maintenance Loop

Use `scripts/session-transcripts.ts` to mine repeated session guidance and promote durable patterns into:
- `AGENTS.md`
- skills
- prompt templates
- these architecture notes

The goal is not to save every thought. The goal is to preserve decisions, evidence, and reusable patterns.
