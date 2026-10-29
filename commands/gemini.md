---
description: "[LEGACY] Send a prompt to the old Gemini CLI - requires a paid GEMINI_API_KEY. Use /consult:agy instead"
argument-hint: "<prompt to send to Gemini>"
allowed-tools: ["mcp__plugin_consult_consult__ask_gemini", "mcp__plugin_consult_consult__gemini_auth_status"]
---

# /consult:gemini

> **Legacy / opt-in.** Google withdrew Gemini CLI free-tier access for individual accounts, so this fails with `IneligibleTierError` (`UNSUPPORTED_CLIENT`) unless a paid `GEMINI_API_KEY` is configured. **Re-authenticating does not help.** Use `/consult:agy` for Google models. This command is kept only for users who have a paid API key.
>
> If the user typed `/consult:gemini` without knowing this, say so once and offer `/consult:agy`, then do what they asked.

Send a prompt to Gemini (Google) via the `consult` MCP server and show the clean response to the user.

## Steps

1. Read `$ARGUMENTS`.
   - `--timeout <seconds>` (or `<n>m` for minutes, e.g. `15m`) -> set `timeout_s` in the tool args, 30-1800 seconds
2. If `$ARGUMENTS` is empty, ask: "What should I ask Gemini?" and stop. Do not invent a prompt.
3. **Detect any file references in `$ARGUMENTS` and inline them.** See the "File handling" section below. Build the final prompt with file blocks first, the user's question last.
4. Call `mcp__plugin_consult_consult__ask_gemini` with `{ prompt: <built prompt> }`, plus `timeout_s` when `--timeout` was given.
5. Format the result for the user as:

```
Gemini (<model>, <latency_ms>ms):

<response>
```

6. Do not add commentary, analysis, or your own opinion. The user wanted Gemini's answer; deliver it.
7. If the call fails, call `mcp__plugin_consult_consult__gemini_auth_status` and report its `hint` verbatim. Pay attention to `reason`:
   - `ineligible_tier` (`fatal: true`) -> the account cannot use this CLI at all. Do NOT suggest re-authenticating; suggest `/consult:agy` or a paid `GEMINI_API_KEY`.
   - `unauthenticated` -> run `gemini` interactively in a terminal once.
   - `binary_missing` / `rate_limited` / `network` -> report as given.

## File handling (always on)

Gemini (the subprocess) has no access to your filesystem. Inline any file the user references into the prompt before calling the tool.

- **Detect:** explicit paths (with ranges like `src/api.py:50-80`), "this file" (the most recent file you `Read`; ask if ambiguous), directory mentions (Glob; confirm if > 5 files). Pasted code passes through as is.
- **Inline** each file as `` `path` `` followed by a fenced block. For files of 20+ lines, prefix each line with its source line number, right-aligned, then ` | ` (a `:50-80` range starts at 50). Files first, the question last.
- **Guardrails:** missing path -> ask; binary -> refuse; single file > 100KB or total > 300KB -> ask before sending. Never truncate silently.
- Edge cases and examples: `skills/second-opinion/references/file-handling.md` in this plugin.

## Notes

- Gemini runs in `plan` (read-only) approval mode - it cannot execute tools or write files (which is why inlining files is mandatory).
- Gemini auto-falls-back across model versions when its preview is rate-limited; the returned `model` field tells you which actually answered.
- Do NOT pass a `model` argument unless the user explicitly named one. Hardcoded preview names sometimes 404.
