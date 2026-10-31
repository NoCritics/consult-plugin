---
description: Ask Antigravity (Google) one question and return its answer. Not when the user says to delegate, or for project work or research over many sources - use consult:delegate
argument-hint: "[--model <id>] [--effort low|medium|high|xhigh|max] [--image <path>] <prompt to send>"
allowed-tools: ["mcp__plugin_consult_consult__ask_agy", "mcp__plugin_consult_consult__agy_status"]
---

# /consult:agy

Send a prompt to Antigravity (`agy`) via the `consult` MCP server and show the clean response to the user.

This is the default Google-side provider. `/consult:gemini` works only with a paid `GEMINI_API_KEY`.

## Steps

1. Read `$ARGUMENTS`. Parse optional flags from the start:
   - `--model <id>` -> set `model` (e.g. `gemini-3.8-flash`, `gemini-3.8-flash-high`, `claude-opus-5-5-high`)
   - `--timeout <seconds>` (or `<n>m` for minutes, e.g. `15m`) -> set `timeout_s` in the tool args, 30-1800 seconds
   - `--effort low|medium|high|xhigh|max` -> set `effort` (model-dependent; agy names the levels a model supports if one is refused)
   - Any image paths in the request (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`), or an explicit `--image <path>` flag -> collect into `images` and drop them from the prompt text. Never describe the image instead of attaching it.
   - Anything else is part of the prompt.
2. If the remaining prompt is empty, ask: "What should I ask Antigravity?" and stop. Do not invent a prompt.

3. **Detect any file references in the prompt and inline them.** See the "File handling" section below. Build the final prompt with file blocks first, the user's question last.
4. Call `mcp__plugin_consult_consult__ask_agy` with the parsed args.
5. Format the result for the user as:

```
Antigravity (<model>, <latency_ms>ms):

<response>
```

6. Do not add commentary, analysis, or your own opinion. The user wanted Antigravity's answer; deliver it.
7. On failure, call `mcp__plugin_consult_consult__agy_status` and report what it says. It distinguishes "not on PATH" from "not signed in" from a backend error, and lists reachable models.

## File handling (always on)

The `agy` subprocess runs headless. It auto-denies shell commands, but it CAN create or edit files inside directories the user has trusted in agy itself (often their whole home) - consult prepends an answer-only instruction and cannot enforce more. So: phrase every prompt as a question, never as "fix/change/write the file", and inline any file the user references into the prompt before calling the tool. If the result carries a `denied_actions` field, say so - the answer was produced without that tool. If the user wants agy to actually change files, that is not what this tool is for.

- **Detect:** explicit paths (with ranges like `src/api.py:50-80`), "this file" (the most recent file you `Read`; ask if ambiguous), directory mentions (Glob; confirm if > 5 files). Pasted code passes through as is.
- **Inline** each file as `` `path` `` followed by a fenced block. For files of 20+ lines, prefix each line with its source line number, right-aligned, then ` | ` (a `:50-80` range starts at 50). Files first, the question last.
- **Guardrails:** missing path -> ask; binary -> refuse; single file > 100KB or total > 300KB -> ask before sending. Never truncate silently.
- Edge cases and examples: `skills/second-opinion/references/file-handling.md` in this plugin.

## Notes

- **Prompts travel via stdin, not argv**, so large inlined files are safe (no Windows command-line length limit).
- **agy fronts non-Google models too** — `claude-opus-5-5-high`, `claude-sonnet-5-5-medium`, `gpt-oss-120b-medium` alongside the Gemini family. Call `agy_status` for the live list rather than guessing; ids encode an effort suffix.
- **Don't pass `--model` unless the user named one.** The CLI default is fine and model ids rotate.
- **Every call carries a large built-in system prompt** (~31k input tokens even for a one-word question). Fast in wall-clock, not cheap in tokens.
- `--effort` is redundant when the model id already encodes one (e.g. `gemini-3.8-flash-high`).
