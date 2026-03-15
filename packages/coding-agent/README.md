<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="pi logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@mariozechner/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@mariozechner/pi-coding-agent?style=flat-square" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

Pi is the coding agent that drives the Bindery web workspace. The browser surface is now the canonical interactive experience: it shows the conversation stream, tool responses, session history, and extension UI in one place. The CLI and SDK remain for headless automation, batch jobs, or embedding into your own service.

Use Bindery web to carry out interactive flows so you can see cards from extensions, drag context around, and branch without losing track of history. When you need responses for scripts, CI, or RPC clients, keep running `pi` with `--print`, `--mode json`, or `--mode rpc`. You can still extend the agent with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes), and bundle them into [Pi Packages](#pi-packages).

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Bindery Web](#bindery-web)
- [Sessions](#sessions)
- [Customization](#customization)
- [Programmatic Usage](#programmatic-usage)
- [CLI Reference](#cli-reference)
- [Philosophy](#philosophy)
- [Contributing & Development](#contributing--development)
- [License](#license)
- [See Also](#see-also)

---

## Quick Start

### 1. Open Bindery web for interactive work

Visit your Bindery web workspace (for example the hosted experience documented at pi.dev or your self-hosted endpoint). Sign in with your provider account or API key, choose a model, and start typing—web handles the session timeline, tool output, and extensions in one panel. If you previously expected `pi` to bring up a terminal UI, note that `pi` now runs headless, so drop straight into web for interactive conversations.

### 2. Keep installs and automation headless

Install the CLI for automation and tooling work:

```bash
npm install -g @mariozechner/pi-coding-agent
pi --print "Summarize the workspace architecture"
pi --mode json "Extract the TODO items"
pi --mode rpc   # pair with a client that speaks JSONL frames
```

Running `pi` without flags still produces a short help message and logs that remind you to open Bindery web if you expect an interactive board. `pi --resume` now prints a short deprecation reminder that directs you to the web workspace and exits; it no longer acts as a branch summary or selector. `pi config` prints the same deprecation guidance and exits, so edit the JSON files by hand or open Bindery web if you need an interactive settings view.

### 3. Align CLI with scripting requirements

Headless mode respects the same resource discovery as your web workspace: config directories default to `~/.pi/agent`, context files are picked up from the current working tree, and installed packages stay in sync. Keep using standard JSON files for settings and extensions so both surfaces see the same context.

---

## Providers & Models

Bindery keeps named providers and tool-capable models cataloged for you. Select them from the web UI or with CLI flags when you dispatch headless commands.

**Subscriptions:**
- OpenAI ChatGPT Plus/Pro (Codex)
- Google Gemini CLI
- Google Antigravity

**API keys:**
- OpenAI
- Google Gemini
- ZAI

See [docs/providers.md](docs/providers.md) for setup instructions. This Bindery fork only ships built-in auth handling for OpenAI, Google, and ZAI. Add custom providers via `~/.pi/agent/models.json` when they speak OpenAI, Anthropic, or Google APIs. Dual-transport models and OAuth flows are still surfaced through [extensions](#extensions) when needed.

---

## Bindery Web

Bindery web is where you read replies, review tool output, and let extensions draw their own UI. A single session page mixes:

- A **message stream** with every user prompt, assistant response, tool call, and notification.
- A **tool palette** that lets extensions inject cards, sliders, or selectors beside the conversation.
- A **context sidebar** that lists open files, linked prompts, and loaded AGENTS.md instructions.
- A **session timeline** for branching, labeling, compacting, and exporting history.

Keyboard shortcuts, thinking-level controls, and completion delivery modes live on the web page—`Alt+Enter` queuing, suspending, and canceling behave the same but are handled by the browser, not a terminal. Extensions can inject cards, sliders, and selectors beside the conversation via the tool palette, but the overlay/custom-footer/status-line hooks are still unsupported in the runtime and throw when invoked, so rely on the palette/context hooks instead.

Want a feature you remember from the old terminal UI? Build it with an extension, share it as a pi package, and the web surface will host it just the same.

---

## Sessions

Every session records a JSONL tree inside `~/.pi/agent/sessions/` (or the directory you override with `PI_CODING_AGENT_DIR`). Each entry has an `id`, `parentId`, and a `branch` attribute; branches let you fork, compact, and revisit earlier points without mutating history.

Headless commands like `pi --resume` and `pi --session` operate on the same files, so you can script recovery flows or post-process logs. `pi --resume` now just prints the deprecation guidance and exits; open Bindery web when you need to explore or branch off with an interactive timeline.

Compaction still runs automatically when the history grows too large, and you can manually request it from the web UI or by issuing the `pi --compact` script flag. The full JSONL history stays intact so you can always roll back.

---

## Customization

### Prompt Templates

Reusable prompts live in Markdown files. Type `/name` on Bindery web or include `@prompt.md` when you invoke `pi --print` to expand them server-side.

```markdown
<!-- ~/.pi/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place templates in `~/.pi/agent/prompts/`, `.pi/prompts/`, or inside a [pi package](#pi-packages).

### Skills

Skills follow the Agent Skills spec: they register instructions, tools, and event handlers that both the web workspace and CLI can load.

```markdown
<!-- ~/.pi/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Drop them in `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/`, or a pi package.

### Extensions

Extensions are TypeScript modules that register tools, commands, or UI hooks.

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

They unlock MCP servers, SSH helpers, git automation, and more. Bind them to `~/.pi/agent/extensions/`, `.pi/extensions/`, or a pi package.

### Themes

Built-in themes (`dark`, `light`) hot-reload as soon as you edit the active file. Store custom themes in `~/.pi/agent/themes/`, `.pi/themes/`, or a package so the web surface and CLI share them.

### Pi Packages

> **Security:** Pi packages execute code with the permissions of your coding agent. Review what you install before granting access.

```bash
pi install npm:@foo/pi-tools
pi install git:github.com/user/repo
pi remove npm:@foo/pi-tools
pi list
pi update
```

Install packages globally or with `-l` for project scope (`.pi/git/`, `.pi/npm/`). Pi auto-discovers extensions, skills, prompts, and themes from standard directories when no manifest is present. A `package.json` entry looks like:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

---

## Programmatic Usage

### SDK

Use the SDK to embed the agent into your own UI or service:

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: AuthStorage.create(),
  modelRegistry: new ModelRegistry(authStorage),
});

await session.prompt("What files are in the current directory?");
```

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, talk to the agent over stdin/stdout:

```bash
pi --mode rpc
```

RPC mode streams LF-delimited JSON records. Clients must split only on `\n`; avoid readers that split on additional separators. See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## CLI Reference

```bash
pi [options] [@files...] [messages...]
```

### Package Commands

```bash
pi install <source> [-l]
pi remove <source> [-l]
pi update [source]
pi list
pi config                   # prints a deprecation reminder and exits (no config dump)
```

`pi config` simply prints a deprecation reminder and exits; open Bindery web or edit the JSON files directly for real configuration work.

### Modes

| Flag | Description |
|------|-------------|
| (default) | Headless run (prints status and connection hints); interactive work belongs on Bindery web |
| `-p`, `--print` | Print a single response and exit |
| `--mode json` | Emit a JSON event stream (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC framing for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export a session file or HTML snapshot |

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Select a provider (openai, google, zai, or a custom provider from `models.json`) |
| `--model <pattern>` | Model pattern or ID (`provider/id` with optional `:<thinking>`) |
| `--api-key <key>` | Override environment credentials |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated models for cycling |
| `--list-models [search]` | Show available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session headlessly |
| `-r`, `--resume` | Print deprecation guidance pointing to Bindery web and exit; no branch summary is emitted |
| `--session <path>` | Use specific session file or partial UUID |
| `--session-dir <dir>` | Override session storage directory |
| `--no-session` | Run ephemeral (do not save) |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>` | Enable builtin tools (`read,bash,edit,write` by default) |
| `--no-tools` | Disable builtin tools (extensions still run) |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a template (repeatable) |
| `--no-prompt-templates` | Disable template discovery |
| `--theme <path>` | Load a theme (repeatable) |
| `--no-themes` | Disable theme discovery |

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace the default system prompt (context files still append) |
| `--append-system-prompt <text>` | Append extra system instructions |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in a prompt:

```bash
pi @prompt.md "Answer this"     # headless prompt that includes prompt.md
pi -p @screenshot.png "Describe this image"
pi @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Summaries remain headless
pi --print "List all .ts files in src/"

# JSON stream for tooling
pi --mode json "Review dependencies"

# Different provider
pi --provider openai --model gpt-4o "Help me refactor"

# Read-only mode
pi --tools read,grep,find,ls --print "Review the code"

# High thinking level
pi --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | Override the config directory (default: `~/.pi/agent`) |
| `PI_PACKAGE_DIR` | Override the package directory (handy for Nix/Guix) |
| `PI_SKIP_VERSION_CHECK` | Skip the update check at startup |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt caching (OpenAI 24h) |
| `VISUAL`, `EDITOR` | External editor used when the agent opens files |

---

## Philosophy

Pi keeps the core minimal so you can augment it however you need. Extensions, skills, and prompt templates do the heavy lifting while Bindery web surfaces the interactive experience and the CLI/SDK stay headless.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the full rationale.

---

## Contributing & Development

Follow [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup. Architecture research lives in [docs/architecture/README.md](docs/architecture/README.md), [docs/architecture/comparative-methods.md](docs/architecture/comparative-methods.md), and [docs/architecture/self-hosting-roadmap.md](docs/architecture/self-hosting-roadmap.md).

---

## License

MIT

## See Also

- [@mariozechner/pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai): Core LLM toolkit
- [@mariozechner/pi-agent](https://www.npmjs.com/package/@mariozechner/pi-agent): Agent framework
