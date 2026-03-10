# Bindery

A focused fork of [pi-mono](https://github.com/badlogic/pi-mono) containing only `packages/coding-agent`.

`packages/ai`, `packages/agent`, `packages/tui`, and the upstream app packages (`mom`, `web-ui`, `pods`) are stripped. Those deps are consumed from npm as published packages.

## Setup

```bash
npm install
```

## Run

```bash
./pi-test.sh         # Run coding agent from source
```

## Check

```bash
npm run check        # Lint, format, and type check
```

## Syncing with upstream

```bash
# One-time per clone
bash scripts/setup-fork.sh

# Pull upstream changes
bash scripts/pull-upstream.sh
```

Upstream: `https://github.com/badlogic/pi-mono`
