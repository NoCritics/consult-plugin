---
name: second-opinion
description: Use when the user wants an answer from a model other than you - a second opinion, a named external model (Codex/GPT/OpenAI, Antigravity/agy, Gemini, a separately invoked Claude), a local model (llama-swap, Ollama, LM Studio, llama-server, vLLM, or a local model name like qwen), a council vote or tournament where several models compete, an ongoing chat with one of them, or an image to be generated with Antigravity or with GPT through Codex. This includes screenshots, mockups or diagrams the user wants that model to look at, and questions about whether those CLIs or the local runner are signed in and reachable. Routes to the consult MCP server's tools.
---

# Second Opinion

Route the user's request to the external models exposed by the `consult` MCP server: Codex, Antigravity (agy), the legacy Gemini CLI, a local model, or a council of several.

## Decide which tool to call

- User names "Codex", "GPT", "OpenAI", "o3", "gpt-5" to ask a question or get an answer -> `mcp__plugin_consult_consult__ask_codex`. If the request is for an image, use `codex_generate_image` (see the image lines below) instead.
- User names "Gemini", "Google", "Antigravity", "agy" -> `mcp__plugin_consult_consult__ask_agy`. This is the DEFAULT Google-side provider.
  - Only use `mcp__plugin_consult_consult__ask_gemini` when the user explicitly names the **legacy gemini CLI** and clearly means it. Google withdrew its free tier for individual accounts, so it fails with an ineligible-tier error unless they have a paid `GEMINI_API_KEY`. If they said "gemini" generically, use `ask_agy` and mention you used Antigravity.
  - `agy` also fronts non-Google models (Claude Sonnet/Opus, GPT-OSS). Call `mcp__plugin_consult_consult__agy_status` to list what is reachable rather than guessing model ids.
- User names "local", "locally", "offline", "private", "llama-swap", "ollama", "LM Studio", "llama.cpp", "vLLM", or a local model name ("qwen", "llama", "mistral", "gemma") -> `mcp__plugin_consult_consult__ask_local`. Free — the model runs on this machine with no API tokens; Claude (a cloud model) still writes the prompt and reads the answer.
- User names a local nickname ("ask local fast", "the big local model") -> `ask_local` with `model` set to it (`fast`, `vision`, `vision-best`, `big`); a fragment of a model name ("distill", "27b") works when it matches one model.
- User asks to set up, pick or rename their local models, or to switch local runner ("use ollama", "back to llama-swap") -> `/consult:setlocal` (with the runner name to switch; the `local_setup` tool; save only what the user confirms).
- User wants one local call on another runner ("ask ollama's fast") -> `ask_local` with `runner`; it is refused while the runner in use holds a model, and `local_unload` frees it only after the user agrees.
- User asks whether the local runner is up, or which local models exist -> `mcp__plugin_consult_consult__local_status`. Also call this FIRST when `ask_local` fails, before reporting the failure: it distinguishes "runner is down" from "model not pulled" from "wrong model name".
- User says "council vote", "tournament", "run the council", "have all three weigh in", "best of three", or any phrasing that implies all three models compete and vote -> `mcp__plugin_consult_consult__council_vote`. Format the result per the `/consult:council` slash command's conventions (compact: winner + Borda scores; tied: show all candidates; verbose: include per-judge rankings).
- User asks for a "second opinion" or two-way comparison without naming a model -> call `ask_codex` AND `ask_agy` in parallel (one tool call each in the same response). Do NOT use `council_vote` for this - council is a 6-call tournament, twice the cost.
- User says "chat with codex/agy/gemini", "have a discussion with", "open a back-and-forth", "talk to codex", or anything implying multi-turn (participants: `codex`, `agy`, `gemini`; prefer `agy` over `gemini`) -> `mcp__plugin_consult_consult__consult_chat_start` (first turn) and then `mcp__plugin_consult_consult__consult_chat_send` for each follow-up. Track the `session_id` from the first result and pass it to every send. See `/consult:chat` slash command for format conventions.
- User says "continue", "next", "ask it more", "follow up with codex/gemini" AFTER an earlier chat tool call in this conversation -> reuse the same `session_id` and `participant`, call `consult_chat_send`.
- User names GPT, OpenAI, Codex or ChatGPT for an image, or needs a transparent background -> `mcp__plugin_consult_consult__codex_generate_image`. Set `aspect_ratio` (default 1:1), `count` (1-4), `transparent_background: true` for a real cut-out, `exact_prompt: true` when your prompt is already complete. At most 5 reference `images`. Prompts that copy copyrighted characters or logos are refused. Uses the user's Codex quota. Show the returned paths.
- Any other request to make, draw or generate an image, illustration, icon or mockup -> `mcp__plugin_consult_consult__agy_generate_image`. Set `aspect_ratio` for the shape (default 1:1), `count` for several (1-4), `tier: "pro"` for text in the image, busy scenes or 2-3 references and `tier: "flash"` for drafts and simple icons, `exact_prompt: true` when your prompt is already complete. At most 3 reference `images`. Show the returned paths.
- User says "end the chat", "close the session", "delete the session", "forget that conversation" -> call `mcp__plugin_consult_consult__consult_chat_end` with the most recent session's `participant` and `session_id`. Report back the `deleted` count.
- Ambiguous -> ask one short question.

### Images (vision)

`ask_codex`, `ask_agy`, `ask_local`, and `council_vote` accept an `images` array of file paths. Use it whenever the request depends on SEEING something -- a screenshot, mockup, diagram, chart, or error dialog.

- Pass the path in `images`. Do NOT try to describe the image in the prompt instead, and never inline image bytes into the prompt text.
- Formats: PNG, JPEG, GIF, WebP (checked by file signature, so a mislabelled extension fails clearly).
- `ask_gemini` and the `claude` council participant CANNOT take images. If the user names one of those for an image question, say so and offer `ask_agy` / `ask_codex` / `ask_local`.
- For `ask_local`, a model the user named keeps the images unless it is known not to read them; otherwise they go to the `vision` nickname, and the result says so. Oversized PNGs are downscaled automatically and the result reports `image_warnings`; relay those only if the user asks why something was slow or looked lossy.
- Councils with images must use only vision-capable participants, e.g. `participants: ["codex","agy","local"]`. The tool refuses a mixed council rather than producing a skewed ranking -- if that error comes back, re-run with the subset it names.

## Build the prompt to send

Pass exactly what the user wants asked. If the user said "ask codex about X", the prompt to Codex is "X" - not "the user wants me to ask you about X". Be a clean conduit.

### File detection and inlining (default behavior, always on)

External CLIs have NO access to your filesystem - they only see the prompt string. Before calling any consult tool, scan the user's request for file references and inline them automatically.

**Detect:**
- Explicit paths in the request (e.g. `src/utils.py`, `./foo.js`, `C:\path\file.ext`, paths with line ranges like `src/api.py:50-80` or `src/api.py#L50-L80`).
- "this file", "the script", "what we just looked at" -> use the most recent file Claude `Read` in the conversation. Ambiguous? Ask once.
- Already-pasted code blocks -> pass through unchanged.
- Directory mentions (e.g. `src/handlers/`) -> Glob first, confirm with user if >5 files.

**Inline using standard markdown with line-numbered bodies** (line numbers let the consulted model say "line 42 has a bug" instead of vaguely describing locations):

````
`path/to/file.ext` (lines 10-50 if range given):

```python
 10 | import fs from 'node:fs';
 11 | 
 12 | function foo() {
 ...
 50 | export default foo;
```
````

Line numbers: right-padded to the max-line digit count, ` | ` separator. Numbers reflect SOURCE file lines (so `:10-50` starts at 10, not 1). Skip numbering for files **< 20 lines** — it's just noise. Each file's numbering resets per file.

Stack multiple files in order, file blocks FIRST, user's question LAST.

**Guardrails:**
- Path doesn't exist -> tell user, suggest closest match if obvious.
- Binary file -> refuse, ask what to extract.
- Single file > 100KB (or > 50KB for council) -> ask before sending.
- Total inlined > 300KB (or > 150KB for council) -> ask before sending.
- Never silently truncate. Always get consent.

**Full rules with examples + edge cases:** `skills/second-opinion/references/file-handling.md` in this plugin. Read it if you hit an edge case not covered above.

## Return the result

Format each response as:

```
<Codex|Antigravity|Gemini|Local> (<model>, <latency_ms>ms):

<response text>
```

If you called both, show both blocks separated by a blank line. Do NOT synthesize a verdict yourself unless the user asked for one. If they did, append a brief synthesis after both blocks under a `Synthesis:` header.

## Failure handling

- Auth errors from Codex -> suggest the user call `mcp__plugin_consult_consult__codex_login_start` (or that you call it on their behalf if they confirm). Note that `codex_login_status` can report `authenticated: true` while the stored token is actually dead — if `ask_codex` fails with a token-refresh error, trust the failure over the status.
- Failures from `ask_agy` -> call `agy_status` before reporting. It distinguishes "not installed" (consult also checks agy's default install location, so PATH is not required; if agy was just installed, only a NEW terminal sees the updated PATH - restarting Claude Code in the same terminal does not) from "not signed in" (run `agy` once interactively) from a backend error, and lists reachable models.
- Failures from `ask_gemini` -> call `gemini_auth_status` and relay its `hint`. If `reason` is `ineligible_tier` (`fatal: true`), do NOT suggest re-authenticating - it cannot help. Say the free tier was withdrawn and offer `ask_agy` instead.
- `ask_local` failures -> call `local_status` before reporting, then relay the specific cause: runner down (give the start hint the error names), llama-swap needing its key (the error names the variable), a nickname pointing at a deleted model, or no default model (both: `/consult:setlocal`). The error messages are already actionable — pass them through rather than paraphrasing.
- `ask_local` returns "produced only reasoning, no answer" -> the model exhausted its context thinking. Tell the user to set `local_reasoning_effort: none` in `.claude/consult.local.md`, or retry once with `reasoning_effort: "none"` if they'd rather not edit config.
- Timeouts or rate limits -> report the failure verbatim; do NOT silently fall back to your own answer. The user wanted the external model's view.
- Codex hooks: consult runs codex with the user's `~/.codex/hooks.json` hooks OFF unless told otherwise. Pass `run_hooks: true` (ask_codex, consult_chat_start/send, council_vote) only when the user asks for their hooks to run on this call - e.g. "with my hooks", "run the impeccable pass too". Expect such calls to take longer; a Stop hook can make codex do another pass after answering. The result's `hooks_ran` confirms what happened.
- A result starting with `INCOMPLETE:` means the model ran out of time (or, for agy, errored mid-answer). The text between the `BEGIN/END PARTIAL` markers is NOT the answer: for codex it is only the last message codex had finished, which may be a progress note. Tell the user the call did not complete and show the partial clearly labelled as partial if it has substance. The error suggests a longer `timeout_s`; you may retry once with it (say you are doing so), or suggest raising `codex_timeout_ms` / `agy_timeout_ms` or narrowing the prompt. Never present the partial as the model's answer.
- Time limits: every ask, chat turn, council and image call takes `timeout_s` (30-1800 seconds) for that call alone. Set it up front when the task is big: large inlined files, high/xhigh/max/ultra effort, several images, or a council over a long prompt. Under Cowork anything past 4 minutes is cut off regardless.

## What NOT to do

- Don't invent or paraphrase what the external CLI "would say" - actually call it.
- Don't pass a `model` argument unless the user named one. Defaults are deliberately left to each CLI (and to the local runner's default, set by `/consult:setlocal`).
- Don't trim or rewrite the external CLI's response. Pass it through verbatim.
- Don't substitute `ask_local` for `ask_codex` / `ask_agy` when one of those fails. They are different models with different strengths; the user asked for a specific one. Report the failure instead.
- Don't add `local` or `gemini` to a council unless the user asked. Defaults are `["claude","codex","agy"]`; both others are opt-in by design.
- Don't silently substitute `ask_agy` when the user explicitly asked for the legacy gemini CLI. Report its failure and offer the alternative.
