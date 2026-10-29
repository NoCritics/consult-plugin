---
description: Set up or switch your local model runner (llama-swap, Ollama, LM Studio, llama-server) and its nicknames (default, fast, vision, vision-best, big), saving only what you confirm
argument-hint: "[runner]"
allowed-tools: ["mcp__plugin_consult_consult__local_setup", "mcp__plugin_consult_consult__local_status", "mcp__plugin_consult_consult__local_unload"]
---

# /consult:setlocal

Set up the local runner consult uses, and the nicknames for its models, from what is running on this machine. Show the user everything first and write only what they confirm. Run it after downloading or deleting a model too: the table says which saved nicknames are kept, gone, or replaced by another quant.

In Claude Code with the consult mod loaded, typing this command opens the consult pane's Local models tab instead, and these steps don't run. They are for everywhere else (Claude Desktop, the mobile app) and for when the user asks in words.

Argument: `$ARGUMENTS` (empty, or a runner: `llama-swap`, `ollama`, `lmstudio`, `llama-server`, `openai`).

## With no argument

1. Call `mcp__plugin_consult_consult__local_setup` with no arguments.
2. **A runner is in use** (`in_use` is set): go straight to step 4 for it. Under the table, list the other runners the probe found (`probe` entries that are `up`) on one line: "Also running: … (switch with /consult:setlocal <runner>)".
3. **No runner is in use**: show the runners found (`probe`: type, address, whether it needs a key) and ask which to use, recommending the only one found, or the one with models. Then call `local_setup` with that `runner` and continue.
   - A llama-swap the probe found but couldn't read (`needs_key`) needs the NAME of the environment variable holding its key (never the key itself). When the probe already used `LLAMA_SWAP_API_KEY` (`key_env` set), there is nothing to ask.
   - A runner not found needs its address once (on this machine only: setup refuses others; a remote runner is written into the file by hand).
   - Optionally ask how they start it (e.g. `Desktop shortcut "llama-swap"`), saved as `start` and shown when it isn't running.
4. Show one table, one row per role in this order: default, fast, vision, vision-best, big. Columns:
   - **Nickname**
   - **Proposed**: the row's `proposed`. Several names mean a tie: list them all.
   - **Why**: the row's `reason`.
   - **Saved now**: from `saved` and `saved_state`: `—` for none; the name for kept; `<name> (gone)`; or `<name> (gone) → <replacement>, another quant of the same model`.

   Below the table, list `proposal.new_models` (models no nickname uses); when a row proposes nothing, list `proposal.models` with each one's name and description so the user can pick. Say in one line when `fit_known` is false (Ollama only: `local_vram_mb` sets the GPU size).
5. Ask the user to approve the table, change a row (any listed model, by name), or drop a row. For every tie, ask which one. One question at a time if several things are open.
6. **Preview, then one confirmation.** Call `local_setup` with `runner`, `preview: true`, and the changes: `save` holding every approved row whose model differs from what is saved now (including `replaced` and `gone` rows they approved, and `null` for a dropped row that has a saved value); `use: true` when this runner isn't the one in use; `url`, `key_env`, `start` when given in step 3. Show the returned `preview.diff` lines and, when `other_loaded` lists a runner holding models, ask once: "Apply this change (and unload <models> from <runner>)?" If nothing differs, say so and stop.
7. On yes: the same call without `preview`; then `local_unload` with that runner if they agreed to unload.
8. Report the `saved.path` it wrote (a `.bak` copy of the old file sits beside it) and the nicknames now in effect, in one short list.

## With a runner argument

- A runner that is configured and has a default (its nickname table has a `default`, or the runner has a `default` alias or a single model): a quick switch. Call `local_setup` with `runner`, `use: true`, `preview: true`; show the diff and anything another runner holds; ask once; then write and unload as in steps 7–8.
- A runner not set up yet, or with no default: the full setup above (steps 3–8) for that runner, with `use: true` in the same write.

## Notes

- Never write without the user's answer in this conversation, and never pass a key's value: only the name of its variable.
- Runner settings live in `~/.claude/consult.local.md` only; a project's file can't change them.
- Nicknames work anywhere a local model is named: `ask_local`'s `model`, `/consult:local --model fast`, and as the runner's default.
- On Ollama, a saved model replaced by another quant of the same model keeps working (`quant_swapped`); a model that is gone entirely stops with an error until this command is run again. llama-swap has no quants in its names.
- Proposals come from facts only: on llama-swap its own aliases (`default`, `fast`, `vision`, `big`); on Ollama and LM Studio size, parameters, quant, vision and GPU fit. The user's taste decides.
