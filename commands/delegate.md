---
description: Hand a background task to Codex, agy or a local model instead of a Claude subagent
argument-hint: "[codex | agy | local | local:<nickname>] <the task>"
allowed-tools: ["mcp__plugin_consult_consult__delegate", "mcp__plugin_consult_consult__delegate_status", "mcp__plugin_consult_consult__delegate_result", "mcp__plugin_consult_consult__delegate_wait"]
---

# /consult:delegate

Hand a task to another model (Codex, agy or a local model) that works on it in the background, much like one of your own subagents. The user chose consult by typing this command, so do not use your own subagent tool for it.

## Steps

1. Read `$ARGUMENTS`. If it is empty, ask "What should I hand to the worker?" and stop. Do not invent a task.
2. **Pick the worker by the first word** (any case):
   - `codex`, `agy`, `local`, or `local:<nickname>` (`default`, `fast`, `vision`, `vision-best`, `big`, e.g. `local:fast`) is the worker, and the rest of the text is the task.
   - A model-family word names a worker too: `gpt` or `openai` is codex, `gemini` or `argon` is agy, `qwen`, `llama` or `offline` is local.
   - Anything else: the whole text is the task. Pass `worker: "auto"` and classify the task into `kind`: `code` (writing, building, editing), `research`, `review`, `private` (private or offline work), or `other`. The user's default table maps the kind to a worker; `other` makes `delegate` ask which worker.
3. **Write the brief yourself.** The worker cannot see this conversation or your context, so put in: the goal, the files and folders involved (paths you know), what "done" means (tests that must pass, behaviour to check), and the constraints (things not to touch, style to match). Plain and complete; no file contents unless they are short and essential.
4. Declare `mode`: `read` for research, review and questions (the worker changes nothing), `write` when it edits files. Give a `task_title` of a few words. Pass `model`, `effort` or `location` ("here" / "copy") only when the user said so ("Codex on high effort", "in a copy").
5. Call `mcp__plugin_consult_consult__delegate`.
6. **If the reply has `started: false`**, it carries `ask` and a `question`. Put the question to the user as it is (one question, with your recommendation), then call `delegate` again with the answer:
   - `ask: "worker"`: the worker they pick.
   - `ask: "limit"`: the worker is near its usage limit. If they say start anyway, pass `confirm_limit: true` (not possible once the limit is full); if they want another worker, pass that. Never switch a worker the user named on your own.
   - `ask: "git-setup"`: pass `git_setup: "yes"` (consult runs `git init`, a `.gitignore` and a first commit, then works in a copy) or `"no"` (remembered; workers edit here).
7. **Tell the user in one line** which worker and model took it and where it works (`location`: a separate copy of the project, or the real folder), in your own words. Add what the reply flags: `limit_note`, `context_warning`, `location_note`, and `queued` (a local task waits for the runner; say what `ahead` and `queue_model` show). If the worker was chosen from the table, say so, so the user can redirect.
8. Carry on with the user's work. When the task ends you will be told (or call `delegate_wait` when you have nothing else to do): read it with `delegate_result`, tell the user what it did, and for a write task in a copy show the changed files and the diff stat. `delegate_merge` and `delegate_send` work only from a session of the task's own project (anywhere else they are refused, and a result read elsewhere changes nothing); merge a copy only when the user wants it (a task started with `hold` waits for their review). Files `delegate_merge` lists as `held` were not applied: ask the user before applying any of them. Conflicts are resolved with both sides in view, and the user told.

## Notes

- This command is the guaranteed route to consult's workers. Without it, use `delegate` only when the user names Codex, agy or a local model, or says "through consult", "another model" or "not Claude"; for ordinary delegation use your own subagent tool.
- A local worker keeps the worker's own model calls on this machine, but it is not offline and you, who write the brief and read the result, are a cloud model. Do not call it "private" beyond that.
- `delegate_send` sends a follow-up to a task whose run ended, in the same worker session and folder; `delegate_cancel` stops a running one; `delegate_status` and `delegate_list` show where tasks stand.
