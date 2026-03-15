# Providers

This Bindery fork only ships built-in auth handling for OpenAI, Google, and ZAI. The TypeScript CLI/SDK surface no longer manages built-in auth for Anthropic, Bedrock, OpenRouter, Vercel AI Gateway, or other upstream providers.

## Table of Contents

- [Subscriptions](#subscriptions)
- [API Keys](#api-keys)
- [Auth File](#auth-file)
- [Resolution Order](#resolution-order)
- [Custom Providers](#custom-providers)

## Subscriptions

Use `/login` in an interactive host, then select a provider:

- OpenAI ChatGPT Plus/Pro (Codex)
- Google Gemini CLI
- Google Antigravity

Use `/logout` to clear credentials. Tokens are stored in `~/.pi/agent/auth.json` and auto-refresh when expired.

### Google Providers

- **Gemini CLI**: Standard Gemini models via Cloud Code Assist
- **Antigravity**: Sandbox with Gemini-family models
- Both work with a Google account, subject to the provider's limits
- For paid Cloud Code Assist, set `GOOGLE_CLOUD_PROJECT`

### OpenAI Codex

- Requires ChatGPT Plus or Pro
- For direct API usage, prefer the OpenAI Platform API with `OPENAI_API_KEY`

## API Keys

Set via environment variable:

```bash
export OPENAI_API_KEY=sk-...
pi
```

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| ZAI | `ZAI_API_KEY` | `zai` |

### Auth File

Store credentials in `~/.pi/agent/auth.json`:

```json
{
  "openai": { "type": "api_key", "key": "sk-..." },
  "google": { "type": "api_key", "key": "..." },
  "zai": { "type": "api_key", "key": "..." }
}
```

The file is created with `0600` permissions. Auth file credentials take priority over environment variables.

### Key Resolution

The `key` field supports three formats:

- **Shell command:** `"!command"` executes and uses stdout (cached for process lifetime)
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'openai'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment variable:** uses the value of the named variable
  ```json
  { "type": "api_key", "key": "MY_OPENAI_KEY" }
  ```
- **Literal value:** used directly
  ```json
  { "type": "api_key", "key": "sk-..." }
  ```

OAuth credentials are also stored here after `/login` and managed automatically.

## Resolution Order

When resolving credentials for a provider:

1. CLI `--api-key`
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`

## Custom Providers

Custom providers still work through `models.json` and extensions. That path is generic plumbing, not built-in Bindery auth support.

- **Via `models.json`**: add local or proxied providers that speak a supported API. See [models.md](models.md).
- **Via extensions**: add custom API implementations or OAuth flows. See [custom-provider.md](custom-provider.md).

That means this fork only narrows the built-in provider/auth surface. If you wire your own provider through `models.json` or an extension, the generic registry and auth storage code can still carry those credentials.
