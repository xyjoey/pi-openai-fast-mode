# pi-openai-fast-mode

A Pi package that adds a `/fast` command for OpenAI GPT models. It switches request-level OpenAI `service_tier` between:

- **Fast on**: `service_tier: "priority"`, displayed Pi price = 2x standard
- **Fast off**: `service_tier: "default"`, displayed Pi price = 1x standard

It also displays `fast on` or `fast off` in Pi's footer/powerline via `ctx.ui.setStatus()`, and when fast mode is on it adjusts Pi's displayed assistant-message cost to exactly **2x** the standard/default request cost.

## Why

OpenAI's API supports request-level `service_tier` for Responses and Chat Completions. Current documented values include `auto`, `default`, `flex`, and `priority`. Priority processing offers lower and more consistent latency than Standard/default processing at higher cost. This package injects `service_tier` with a convenient toggle and normalizes Pi's displayed pricing to 2x standard while fast mode is on.

## Install

From this local checkout:

```bash
pi install pi-openai-fast-mode
```

## Usage

```text
/fast on       # Use service_tier="priority" for supported OpenAI GPT requests
/fast off      # Use service_tier="default"
/fast status   # Show current mode
/fast          # Toggle
```

State is stored in the Pi session via a custom entry, so branch/tree navigation restores the latest setting on that branch. The price multiplier applies to assistant responses made while `/fast on` is active.

## Scope

The extension only modifies requests for OpenAI-like GPT providers:

- `openai`
- `openai-codex`
- `azure-openai-responses`
- custom providers whose API is `openai-responses`, `openai-codex-responses`, or `openai-completions` and whose provider/id/base URL looks OpenAI/GPT-like

For `openai-completions`, Pi's current provider implementation does not expose a typed `serviceTier` option, so this extension injects `service_tier` directly into the provider payload. For Responses/Codex it also works at payload level through Pi's `before_provider_request` hook.

## Notes

- `priority` may require account/project eligibility and is billed at a premium.
- Unsupported models or providers may reject `service_tier`. Use `/fast off` if you see an OpenAI `invalid_value` error.
- This package is independent of Codex CLI's own `/fast` command and `config.toml`; it is for Pi.
- Some upstream docs mention model-specific fast-mode credit multipliers. Per your requirement, this Pi package displays exactly 2x standard cost whenever fast mode is on.
# pi-openai-fast-mode
