---
description: Send a prompt to the Codex CLI (OpenAI) and return its clean response
argument-hint: "[--image <path>] <prompt to send to Codex>"
allowed-tools: ["mcp__plugin_consult_consult__ask_codex", "mcp__plugin_consult_consult__codex_login_status", "mcp__plugin_consult_consult__codex_login_start"]
---

# /consult:codex

Send a prompt to Codex (OpenAI) via the `consult` MCP server and show the clean response to the user.

## Steps

1. Read `$ARGUMENTS`.
   - `--timeout <seconds>` (or `<n>m` for minutes, e.g. `15m`) -> set `timeout_s` in the tool args, 30-1800 seconds
   - Any image paths in the request (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`), or an explicit `--image <path>` flag -> collect into `images` and drop them from the prompt text. Never describe the image instead of attaching it.
2. If `$ARGUMENTS` is empty, ask: "What should I ask Codex?" and stop. Do not invent a prompt.

3. **Detect any file references in `$ARGUMENTS` and inline them.** See the "File handling" section below. Build the final prompt with file blocks first, the user's question last.
4. Call `mcp__plugin_consult_consult__ask_codex` with `{ prompt: <built prompt> }`, plus `timeout_s` when `--timeout` was given.
5. Format the result for the user as:

```
Codex (<model>, <reasoning_effort> effort, <latency_ms>ms):

<response>
```

6. Do not add commentary, analysis, or your own opinion. The user wanted Codex's answer; deliver it.
7. If the call fails with an authentication-related error, suggest calling `mcp__plugin_consult_consult__codex_login_status` and, if needed, `mcp__plugin_consult_consult__codex_login_start`.
8. If the result starts with `INCOMPLETE:`, Codex ran out of time. Say so plainly; the fenced partial is only the last message Codex had finished (possibly a progress note), so label it as partial rather than presenting it as Codex's answer, and offer to retry with the longer `timeout_s` the error suggests (or `/consult:codex --timeout 20m ...`), or to raise `codex_timeout_ms` in `.claude/consult.local.md`.

## File handling (always on)

Codex (the subprocess) has no access to your filesystem. Inline any file the user references into the prompt before calling the tool.

- **Detect:** explicit paths (with ranges like `src/api.py:50-80`), "this file" (the most recent file you `Read`; ask if ambiguous), directory mentions (Glob; confirm if > 5 files). Pasted code passes through as is.
- **Inline** each file as `` `path` `` followed by a fenced block. For files of 20+ lines, prefix each line with its source line number, right-aligned, then ` | ` (a `:50-80` range starts at 50). Files first, the question last.
- **Guardrails:** missing path -> ask; binary -> refuse; single file > 100KB or total > 300KB -> ask before sending. Never truncate silently.
- Edge cases and examples: `skills/second-opinion/references/file-handling.md` in this plugin.

## Notes

- Codex runs in read-only sandbox - it cannot touch the filesystem (which is why inlining files is mandatory).
- Long prompts are fine; they're piped via stdin.
- Do NOT pass a `model` argument unless the user explicitly named one.
