---
description: Start or continue a multi-turn chat with Codex, Antigravity (agy) or Gemini. Maintains conversation state across turns via the CLI's own session store
argument-hint: "[codex|agy|gemini] <message>   or   continue <message>   or   end"
allowed-tools: ["mcp__plugin_consult_consult__consult_chat_start", "mcp__plugin_consult_consult__consult_chat_send", "mcp__plugin_consult_consult__consult_chat_end"]
---

# /consult:chat

Have an ongoing back-and-forth with one external model. Unlike `/consult:codex` and `/consult:agy`, this remembers context across turns.

Participants: `codex`, `agy` (default Google provider), `gemini` (legacy, needs a paid `GEMINI_API_KEY`).

## Steps

1. Parse `$ARGUMENTS`. A `--timeout <seconds>` (or `<n>m`) flag anywhere sets `timeout_s` (30-1800) on that start or continue call. Three modes:
   - **Start**: first token is `codex`, `agy`, or `gemini`, rest is the first message. Prefer `agy` over `gemini` for Google models unless the user explicitly names the legacy CLI.
     Example: `codex review this design pattern: ...`
   - **Continue**: first token is `continue` (alias: `next`, `more`). The rest is the next message. Use the `session_id` and `participant` from the most recent chat tool result in this conversation.
     Example: `continue what about thread safety?`
   - **End**: argument is exactly `end` (or `stop`). Use the most recent chat tool result for `session_id` + `participant`, call `mcp__plugin_consult_consult__consult_chat_end`. Report back: "Session deleted (N files removed)." If `deleted=0`, say so honestly — the session was already gone.

2. **For Start**:
   - Detect file references in the message and inline them (see "File handling" below).
   - Call `mcp__plugin_consult_consult__consult_chat_start` with `{ participant, prompt }`.
   - Show the response with the format below, AND tell the user the session id explicitly so they know we're in a chat.

3. **For Continue**:
   - Look up the most recent chat tool call in this conversation. Use its `session_id` and `participant`.
   - If you can't find one, ask the user: "I don't see an active chat session in this conversation. Use `/consult:chat codex <message>` or `/consult:chat agy <message>` to start one."
   - Detect file references and inline them.
   - Call `mcp__plugin_consult_consult__consult_chat_send` with `{ participant, session_id, prompt }`.

4. **For End**: call `consult_chat_end` with the participant + session_id from the most recent chat tool result. The tool returns `{ deleted, note, ... }`. Format as a one-line confirmation: `Session <id> deleted (N file(s) removed).` If `deleted=0`, surface the `note` field instead so the user understands why.

## Output format

```
[<participant> (<model>) - <latency_ms>ms]
session: <session_id>

<response>
```

For continue turns, you can omit the `session:` line after the first turn if the same id keeps showing — it's noise. Keep showing the `[participant (model) - Nms]` header so latency is visible.

## File handling (always on)

Same rules as the other consult commands. The participant subprocess has no filesystem access; inline files into the prompt before calling the tool.

- **Detect:** explicit paths (with ranges like `src/api.py:50-80`), "this file" (the most recent file you `Read`; ask if ambiguous), directory mentions (Glob; confirm if > 5 files). Pasted code passes through as is.
- **Inline** each file as `` `path` `` followed by a fenced block. For files of 20+ lines, prefix each line with its source line number, right-aligned, then ` | ` (a `:50-80` range starts at 50). Files first, the question last.
- **Guardrails:** missing path -> ask; binary -> refuse; single file > 100KB or total > 300KB -> ask before sending. Never truncate silently.
- Edge cases and examples: `skills/second-opinion/references/file-handling.md` in this plugin.

## Notes

- **Token cost grows with conversation length.** Each turn replays the full conversation history to the model. Long chats get expensive fast on every provider.
- **Codex sessions** persist in `~/.codex/` (cwd-scoped by default). The session id is a UUID (`thread_id`).
- **Gemini sessions** persist in `~/.gemini/`. The session id is a UUID we generate client-side.
- **Antigravity (agy) sessions** persist in `~/.gemini/antigravity-cli/` as a SQLite db plus a `brain/<id>/` directory. The `conversation_id` comes from agy itself. These are heavy (~600KB+ per conversation), so ending an agy chat you are done with is worth doing.
- **Same safety posture as single-shot.** Codex chat runs `-s read-only`; Gemini chat runs `--approval-mode plan`. Antigravity (agy) is NOT enforced read-only - it can edit files inside its trusted workspaces - so every agy turn gets the same answer-only preamble as `ask_agy`; keep prompts as questions.
- **Pass through verbatim.** Don't summarize or edit the participant's response.
- **One chat at a time per conversation** is the simple mental model. If the user wants parallel chats with e.g. codex and agy, start two sessions and remember both session ids.
