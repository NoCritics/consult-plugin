---
description: Send a prompt to a local model (llama-swap, Ollama, LM Studio, llama-server) and return its clean response
argument-hint: "[--model <name>] [--runner <runner>] [--think | --no-think] [--image <path>] <prompt to send to the local model>"
allowed-tools: ["mcp__plugin_consult_consult__ask_local", "mcp__plugin_consult_consult__local_status"]
---

# /consult:local

Send a prompt to a model running on this machine via the `consult` MCP server and show the clean response to the user.

Free — inference is local, no API tokens are spent and nothing leaves the machine.

## Steps

1. Read `$ARGUMENTS`. Parse optional flags from the start:
   - `--model <name>` -> set `model` in the tool args: a nickname from `/consult:setlocal` (`fast`, `vision`, `vision-best`, `big`), a full model name, or a fragment that matches one installed model (e.g. `--model distill`)
   - `--runner <runner>` -> set `runner` (`llama-swap`, `ollama`, `lmstudio`, `llama-server`, `openai`) to use another configured runner for this call only. consult refuses while the runner in use has a model loaded; it says which, and `/consult:setlocal` (or `local_unload`, after the user agrees) frees it.
   - `--timeout <seconds>` (or `<n>m` for minutes, e.g. `15m`) -> set `timeout_s` in the tool args, 30-1800 seconds
   - `--no-think` -> set `reasoning_effort: "none"` (much faster; see Notes)
   - `--think` -> omit `reasoning_effort` entirely, letting the model reason normally
   - Any image paths in the request (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`), or an explicit `--image <path>` flag -> collect into `images` and drop them from the prompt text. Never describe the image instead of attaching it.
   - Vision needs a model that reads images. A model the user named keeps the call unless it is known not to read images (on llama-swap only the loaded model reports this; the result then says `vision: "unknown"`). Otherwise consult switches to the `vision` nickname and says so (`switched_for_images`); with none it names the models that can. If the runner refuses the images, the error says that model can't read them. Oversized PNGs are downscaled automatically.
   - Anything else is part of the prompt.
2. If the remaining prompt is empty, ask: "What should I ask the local model?" and stop. Do not invent a prompt.

3. **Detect any file references in the prompt and inline them.** See the "File handling" section below. Build the final prompt with file blocks first, the user's question last.
4. Call `mcp__plugin_consult_consult__ask_local` with the parsed args.
5. Format the result for the user as:

```
Local (<model>, <latency_ms>ms, <completion> tokens):

<response>
```

6. Do not add commentary, analysis, or your own opinion. The user wanted the local model's answer; deliver it.
7. **On failure, call `mcp__plugin_consult_consult__local_status` before reporting.** It names the runner in use and distinguishes the common causes; the fix differs for each:
   - not reachable -> the runner isn't running: give the start hint from the error (the runner's `start` setting, e.g. `Desktop shortcut "llama-swap"`, or `ollama serve`).
   - needs its key / key rejected (llama-swap) -> the error names the environment variable; suggest `/consult:setlocal`.
   - a nickname points at a model that is gone -> suggest `/consult:setlocal` (on Ollama a different quant of the same model is used automatically, so this means the whole model was deleted).
   - no default model -> suggest `/consult:setlocal`, or offer the models `local_status` listed.
   - `INCOMPLETE:` -> the model stopped sending tokens for 2 minutes, ran out of time, or was still thinking: show the partial only as partial; for "still thinking" suggest `--no-think`.

## File handling (always on)

The local model has no access to your filesystem. Inline any file the user references into the prompt before calling the tool.

- **Detect:** explicit paths (with ranges like `src/api.py:50-80`), "this file" (the most recent file you `Read`; ask if ambiguous), directory mentions (Glob; confirm if > 5 files). Pasted code passes through as is.
- **Inline** each file as `` `path` `` followed by a fenced block. For files of 20+ lines, prefix each line with its source line number, right-aligned, then ` | ` (a `:50-80` range starts at 50). Files first, the question last.
- **Guardrails:** missing path -> ask; binary -> refuse; more than ~20KB total -> warn first and prefer excerpts: local models have small context windows (often 4k-32k), and an overflow returns a truncated or empty answer, not an error. Never truncate silently.
- Edge cases and examples: `skills/second-opinion/references/file-handling.md` in this plugin.

## Notes

- **The endpoint is config-only.** No address is a tool argument, by design, so this command cannot point the model at an arbitrary host. `--runner` picks among configured runners by type. To switch the runner in use, run `/consult:setlocal <runner>`.
- **Reasoning models burn enormous token budgets.** On Ollama + qwen3.5:2b, "what is 2+2" cost ~2578 completion tokens and ~16s with thinking on, versus 2 tokens and <1s with `--no-think`. Worse, a small model can exhaust its whole context window thinking and return no answer at all. If that happens the tool says so explicitly — retry with `--no-think`.
- **Don't pass `--model` or `--runner` unless the user named one.** The runner's configured default is the default for a reason.
- **Don't fall back to a local model when a cloud CLI fails**, or vice versa. They are different models; the user picked one deliberately.
