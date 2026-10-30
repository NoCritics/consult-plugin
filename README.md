# consult

Ask other AI models for a second opinion from Claude Code or Claude Desktop: the Codex and Antigravity (`agy`) CLIs, the legacy Gemini CLI, and local models (llama-swap, Ollama, LM Studio, llama-server, vLLM). One-shot questions, multi-turn chats, a council that has the models rank each other's answers, and background tasks you hand to Codex, agy or a local model while you keep working (Claude Code only).

## What's inside

| Component | Where | What it does |
|-----------|-------|--------------|
| **MCP server** | `mcpServers` in `.claude-plugin/plugin.json` + `mcp/consult.js` | 25 tools: `ask_codex`, `ask_agy`, `ask_gemini`, `ask_local`, `agy_generate_image`, `codex_generate_image`, `agy_status`, `local_status`, `local_setup`, `local_unload`, `consult_chat_start`, `consult_chat_send`, `consult_chat_end`, `codex_login_status`, `codex_login_start`, `gemini_auth_status`, `council_vote`, and the eight delegate tools `delegate`, `delegate_status`, `delegate_list`, `delegate_result`, `delegate_merge`, `delegate_send`, `delegate_cancel`, `delegate_wait`. Handles output cleanup, sandboxing, timeouts, session relay, reasoning stripping, anonymization, Borda counting, and the background tasks' folders, copies and merges. |
| **Slash commands** | `commands/*.md` | `/consult:codex`, `/consult:agy`, `/consult:local`, `/consult:gemini` (one-shot), `/consult:chat` (multi-turn), `/consult:council` (tournament), `/consult:setlocal` (local runner and model nicknames), `/consult:delegate` (a background task for Codex, agy or a local model). |
| **Skill** | `skills/second-opinion/` | Triggers on "ask codex", "get a second opinion", "run the council", "chat with codex" and similar, and routes to the right tool. Inlines any files you mention, since the other models can't read your disk. |
| **Hook** | `hooks/scripts/` | On `SessionStart`: checks codex auth, `agy`, and (if a local runner is set up) that runner. One line per broken service; never blocks. |
| **Band and pane** | `hooks/register.tsx`, `hooks/mod/`, `hooks/ui/` | In Claude Code only: each running call above the prompt with its time limit and its own Cancel, a `/consult` pane of this and earlier sessions' answers, a Local models setup tab and a **Delegated** tab for background tasks, consult's health in the status line, and the wake-up when a delegated task ends. See [In Claude Code: the band and pane](#in-claude-code-the-band-and-pane) and [Delegate: background tasks](#delegate-background-tasks). |
| **Desktop extension** | `mcp/manifest.json` | The same server, installable in Claude Desktop. See [Claude Desktop](#claude-desktop). |

## Setup

### 1. Prerequisites

Node.js 20+. Each provider is optional and independent; a tool you can't use reports why.

| For | You need |
|-----|----------|
| `ask_codex`, codex chat | `codex` CLI, signed in (`codex login`) |
| `ask_agy`, agy chat | `agy` CLI from [antigravity.google](https://antigravity.google), signed in |
| `council_vote` | codex + agy + the `claude` CLI |
| `ask_local`, `local_status` | a local OpenAI-compatible runner (step 4) |
| `ask_gemini` (legacy) | `gemini` CLI **plus a paid `GEMINI_API_KEY`**; the free tier is gone (see caveats) |
| `delegate` | the worker's own CLI: `codex` signed in, `agy`, or `pi` plus a local runner (step 4). Tasks that write files in a separate copy of the project need git 2.40 or newer |

### 2. Install the plugin

In Claude Code:

```
/plugin marketplace add NoCritics/consult-plugin
/plugin install consult@nocritics
```

Then restart Claude Code. There is nothing to `npm install`: the server's one dependency, the MCP SDK, ships bundled in `mcp/vendor/`.

### 3. Set up Antigravity (`agy`)

`agy` is the default Google provider. On Windows:

```
curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Sign in by running `agy` once. consult finds `agy` at its install location (`%LOCALAPPDATA%\agy\bin\agy.exe`) even before your PATH picks it up; to run `agy` yourself, open a new terminal first. The `agy_status` tool lists the models agy can reach (it also fronts Claude and GPT-OSS models) and costs no tokens. Model ids rotate (agy 1.3.5 offers `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}` and `gpt-oss-120b-medium`), so leave `agy_model` unset unless you need one. A base id such as `gemini-3.8-flash` uses that model's default effort. **Gemini 4 Argon** (`gemini-4-argon`, released 2026-10-13) reaches Antigravity on Google AI Ultra plans; once your account has it, `agy_status` lists it and you can ask for it by name. The legacy Gemini CLI does not offer it.

### 4. (Optional) Set up a local model

Run `/consult:setlocal` (or ask Claude to "set up my local models"). consult looks for a runner on this machine, shows what it found and proposes nicknames for its models; it writes only what you confirm, after showing you the diff. In Claude Code the command opens the consult pane's **Local models** tab, a form with pickers (see [In Claude Code: the band and pane](#in-claude-code-the-band-and-pane)); in Claude Desktop, or when you ask in words, Claude walks you through the same steps in chat.

| Runner | Found at | Nicknames |
|--------|----------|-----------|
| [llama-swap](https://github.com/mostlygeek/llama-swap) | probed on 9292 and 8080 (it has no standard port; give yours once) | from its own aliases `default`, `fast`, `vision`, `big` |
| Ollama | `http://127.0.0.1:11434/v1` | from each model's size, parameters, quant, vision and GPU fit |
| LM Studio | `http://127.0.0.1:1234/v1` | from each model's size, parameters, quant, vision and GPU fit (its `/api/v1/models`); embedding models are left out |
| llama.cpp (`llama-server`) | `http://127.0.0.1:8080/v1` | model names, passed through |
| vLLM, Strata, any other OpenAI-compatible server (`openai`) | the address you give | model names, passed through; facts from a `meta` block, see below |

A server of your own can describe its models for the Local models tab: give each entry of its `/v1/models` a `meta` object with any of the fields llama-swap's `metadata:` uses, e.g. `{"id": "my-model", "meta": {"arch": "MoE", "engine": "vLLM", "decode_tps": 40, "vision": true}}`. `"chat": false` (here, or in a llama-swap model's `metadata:`) marks a model that can't reply, such as an embedding model, and leaves it out. A value of another shape is ignored; without them the tab shows the name and, once you've used the model, its measured speed.

A runner is recognised by what answers, not by its port (LM Studio by its `/lmstudio-greeting`). Several can be configured; one is in use. `/consult:setlocal ollama` switches back to Ollama with its own nicknames intact, `/consult:setlocal llama-swap` switches again, and `/consult:local --runner ollama …` uses another runner for one call (refused while the runner in use holds a model, so two runners never fill memory at once; `/consult:setlocal` offers to unload it).

The settings it writes, in `~/.claude/consult.local.md` (runner settings are read from that global file only; a project's file can't change them):

```yaml
---
local_runner: llama-swap
llama-swap.url: http://127.0.0.1:9292/v1
llama-swap.key_env: LLAMA_SWAP_API_KEY        # the NAME of the variable holding the key
llama-swap.start: Desktop shortcut "llama-swap"  # shown when it isn't running; never run
llama-swap.default: qwen3.6-35b-a3b
llama-swap.fast: qwen3.5-4b
ollama.default: qwen3.8-9b-distill:q4_k_m
ollama.fast: qwen3.5:4b
---
```

- **llama-swap's key** stays out of every file: consult reads the variable named by `llama-swap.key_env` at call time, from its own environment or (on Windows) your user environment, so a variable created after Claude Code started still works. It is only ever sent to an address on this machine, never in a redirect, and never shown in an error or log. Setup finds `LLAMA_SWAP_API_KEY` by itself when it exists.
- **Ollama nicknames** (when llama-swap has no aliases, the table lists every model with its description for you to pick):

  | Nickname | Proposed Ollama model |
  |---|---|
  | default | most parameters among models that fit the GPU |
  | `fast` | smallest model that fits the GPU |
  | `vision` | most parameters among vision models that fit the GPU |
  | `vision-best` | most parameters among all vision models (slow) |
  | `big` | most parameters overall (slow) |

  GPU fit is judged against `nvidia-smi`'s memory minus 1 GiB, or `local_vram_mb`. Equal models (same parameters and quant, within 0.2 GB) are a tie you pick. If a saved model is gone and exactly one other quant of it is installed, calls use that one and say `quant_swapped`; a whole model gone stops with an error until you run `/consult:setlocal` again. Nothing changes a nickname without you.
- **Using them:** "ask local fast …", `/consult:local --model big …`, or any fragment that matches one model (`distill`). On llama-swap, `fast:nothink` and the other `:nothink` names pass through as given.
- **Images:** a model you name keeps the images unless it is known not to read them (llama-swap reports vision only for the loaded model). Otherwise they go to the `vision` nickname (`switched_for_images`). If the runner refuses them, the error says that model can't read images.
- **Slow models:** every llama-swap call, and an Ollama model that doesn't fit the GPU, gets at least 20 minutes unless `local_timeout_ms` or `timeout_s` says otherwise (flash-next-class models load for minutes, and a load inside Strata isn't bounded by llama-swap's health check). Answers stream: a model that stops sending tokens for 2 minutes after it started ends the call as `INCOMPLETE:` with what it had, and a refused connection or a missing key fails at once.
- **0.11.0 settings keep working:** with `local_runner` unset, `local_base_url`, `local_api_key` and `local_model*` behave as before; with `local_runner: ollama` the `local_model*` lines are the Ollama nicknames, and setup replaces each with its `ollama.` line (in the diff you confirm).
- `local_status` shows the runner in use, its models (and on llama-swap which one is loaded), the nicknames and whether each resolves, other runners holding models, and any settings warnings (unknown keys, indented lines, runner lines in a project file).

**Why `reasoning_effort: none`?** Reasoning models can spend their whole context window thinking. Ollama 0.30.7 + qwen3.5:2b on *"what is 2+2, one word"*: omitted, ~2,578 completion tokens and ~16 s, sometimes with no answer at all; `none`, 2 tokens in under a second; `low`, 4,076 tokens and an empty answer. On llama.cpp-based runners (llama-swap, llama-server) `low`/`medium`/`high` act like the default; `none` turns thinking off. If `ask_local` reports *"produced only reasoning"* or *"was still thinking"*, this is the fix.

No address is a tool argument, so a prompt injection can't redirect your prompts: `runner` picks among configured runners by type, and setup only saves addresses on this machine (a remote runner is a line you write by hand). The server warns if a **project** config points `local_base_url` off the machine; keep remote endpoints in the global config.

## In Claude Code: the band and pane

A function-hooks module in the plugin draws consult's calls in Claude Code's terminal. Nothing shows while consult isn't doing anything, and no pane opens by itself.

- **The band.** While a consult call runs, a row in a rounded box above the prompt shows the provider, model and effort, a bar against the call's time limit (`timeout_s`, else the limit from your settings; yellow past 75 %, red past 90 %), and elapsed / limit. **Cancel** stops that call alone: Claude reads "Cancelled by the user from the consult band." and carries on with its turn. A call still running after 2 minutes is moved to the background by Claude Code; its row stays until the result arrives (as a task notification), and its Cancel then stops the background task, or, if Claude Code refuses that, tells you to ask Claude to stop it. A council's bar spans its two rounds; a judging retry past it reads "over: judge retry". After the last call ends, one slim row shows its summary (or "✓ 3 answers · 1 error") until your next prompt.
- **A toast** when each call ends, and a **push notification request** for calls of 120 s or more (`notify_after_s`). Claude Code decides whether it goes out (only while you're away from the terminal); a push reaching a phone has not been confirmed yet.
- **`/consult`** toggles the pane (so does the band's **Answers**; Esc closes it). If Claude Code refuses the name, the command is `/consult-answers`. The pane has three tabs, **Answers**, **Local models** and **Delegated** (background tasks, described [below](#delegate-background-tasks)), and opens on the one you used last (the band's Answers always opens Answers). **Answers** lists this session's calls, then earlier sessions' (the last 50, `history_size`). The calls made for one prompt share a rounded box headed by the question, with a rule between answers; the pane shows ten boxes at a time. Press an entry to expand it: the answer as Markdown, with **Copy answer** and **Copy prompt** (a toast confirms the copy, or says why it failed). An image entry has a `file:///` link, **Open** (images only), **Show in folder** and **Copy path**; the picture itself shows in kitty or Ghostty for PNGs, and as its name and size elsewhere. Errors and timeouts keep consult's own hint (`retry with timeout_s: 360`).
- **Local models** (also what `/consult:setlocal` opens; `/consult:setlocal ollama` opens it on Ollama) sets up the local runner without a chat turn: a **Runner** picker with a dot for its state (green up, yellow not running, grey not found), one picker per nickname (default, fast, vision, vision-best, big) starting on the saved model or the proposal (a tie starts on its first tied model; the list marks the tied ones `(tie)`), and, only when needed, fields for the runner's address, the NAME of its key variable and a start note. In a picker's list ● marks the saved model and ○ the one picked but not saved; beside it, `• was <saved model>` marks a change not saved yet and `⚠ images` a vision nickname whose model isn't known to read images. A **Models** list gives each model's type, engine, decode speed and `images`, dim when no nickname uses it. On llama-swap those come from each model's `metadata:` in its config (`arch: MoE`, `engine: llama.cpp`, `decode_tps: 38`, `vision: true`); a model without them shows its description. On Ollama and LM Studio the type comes from the runner itself; a custom server can send them in a `meta` block (above). A model with no speed written down shows the median of its last five `ask_local` or council calls as `~N t/s` (kept in `~/.claude/consult-speeds.json`). When the runner isn't running, the tab lists the saved nicknames and says to start it and press Refresh. Each change shows the settings file's diff after a moment; **Save** writes it (dim, and doing nothing, until there is a diff), **Save and unload …** also frees a model another runner holds. After a save a toast tells you, and Claude gets a one-line note, so it stops using the old runner or nicknames. **Refresh** reads the runners again. The pane runs `hooks/scripts/setlocal.js`, which is `local_setup`'s own code, so it saves exactly what the chat steps would.
- **The status line** (Claude Code puts `⚠ consult:` in front) reads `checking…` at the start of a session (resuming one with `/resume` or `claude --resume` counts as a start), then `codex ✓ agy ✓ local –`, and clears at your first prompt. A small script runs the checks, without going through Claude's tool permissions. – means not set up; ? means the check got no answer. The check never contacts a `local_base_url` that is not on this machine, so such a runner always shows ?. If a call later fails because a service is signed out, missing or unreachable, it reads e.g. `agy ✗ not signed in — run agy once` until a call to that service answers.
- **Summaries** are the answer's first paragraph; with `summary_model: haiku` Claude Code's haiku writes them (billed to your Claude usage).

History lives in Claude Code's per-plugin store (answers capped at 32 KB, prompts at 2 KB). The Claude Desktop extension is unchanged: Desktop has no band or pane.

## Delegate: background tasks

`delegate` hands a piece of work to Codex, agy or a local model, the way Claude hands one to its own subagents: it runs in the background, you and Claude keep working, and Claude is woken when it ends to read the result, merge it and tell you. Claude Code only; see [Claude Desktop](#claude-desktop).

- **The words.** `/consult:delegate <worker> <task>` is the sure route. The worker is the first word: `codex`, `agy`, `local`, or `local:<nickname>` (`local:fast`, `local:big`, …), or a model-family word: `gpt` and `openai` mean codex, `gemini` and `argon` mean agy, `qwen`, `llama` and `offline` mean local. Plain words work too ("give the About page to Codex"). With no worker (`/consult:delegate <task>`, or "through consult" / "another model") Claude sorts the task by kind and the default table in the settings below picks the worker, and says which it chose so you can redirect; a kind the table doesn't cover, or a row set to `ask`, makes it ask you. A bare "delegate this", or "use a subagent", stays with Claude's own subagents; consult is not involved. `delegate_send` sends a follow-up to a finished task in the same worker session, `delegate_cancel` stops a running one, and a task started with `hold` waits for your review instead of counting as ready to merge.
- **Workers.** Each runs headless with permissions given for that one run; consult never writes `~/.codex/config.toml`, agy's settings or `~/.pi/agent/*`.
  - **codex** needs the Codex CLI signed in. Fence: its own sandbox keeps it inside its folder (its copy, for a write task); a read-only task runs with `read-only`. A write task may use the network.
  - **agy** needs the `agy` CLI. It is `not fenced` (nothing keeps it inside its folder) and can't run commands, so it suits research, review and edits that need no build. A read-only task is told in words to change nothing (every worker is), but nothing enforces that for agy, so consult compares the folder before and after the run (git's read-only status, or a capped file listing without git) and, if files changed, the result names them and the wake notice gives their number (names come from an unfenced worker, so they stay out of what is submitted to Claude as a notice). Some may be your own edits made meanwhile. A write task in a copy that agy ends refused a command (say, its own `git diff`) with no summary still counts as done, with a warning, when the copy has changes; with none it is failed.
  - **local** runs the `pi` coding agent against your local runner (the one `/consult:setlocal` set up), reaching it through a provider consult adds to that one run, so nothing in `~/.pi/agent` is read or changed and a local task can't go to a cloud model. `not fenced`: pi's shell can write anywhere you can. A read-only task gets pi's read tools only (`read`, `grep`, `find`, `ls`). A model with a context window under about 16K gets a warning, since a worker's own instructions take several thousand tokens.
  - **Local and privacy, exactly:** a local worker keeps the worker's own model calls on this machine. It is not offline (its shell can reach the network), and Claude, which writes the brief and reads the result, is a cloud model.
- **Processes a worker leaves behind (Windows).** When a task ends or is stopped (or its supervisor died and the next sweep stops it), consult kills the worker's whole process tree. For a task in a copy it then looks for processes created since the worker started whose command line names the copy's folder, follows each up through its living parents that also started during the run, and if that chain ends at a parent that has exited (not at a program that was already running, such as your editor or explorer) it kills the topmost process of the chain with everything under it. That catches a dev server a worker started through `Start-Process`, `cmd /c start`, or `npm run dev` or `next dev` (a launcher that stays alive over a server with the copy's path in its command line). It does not catch a process whose command line never names the copy's folder, and nothing in the chain names it (a server started as `node server.js` with a relative path, from a launcher that also uses relative paths). It can wrongly kill a program you start from inside the copy during a run if it is started through a short-lived launcher that exits. For a task that works in place consult can't tell the worker's server from yours, so it kills nothing there: `delegate_result` carries a warning naming the same kind of processes, and you stop them yourself. A Job object, which would hold them all, is not used yet.
- **Copies.** Where a task edits is a per-project setting, **Workers edit**: **Auto** (the default), **Here** or **In a copy**; saying "right here" or "in a copy" for one task beats it. Read-only tasks always run in the real folder. In Auto, a write task in a project with git (at least one commit, git 2.40 or newer) runs in a git worktree under consult's data folder on the branch `consult/<id>`, started from the folder as it is now, uncommitted and untracked files included, ignored files (`node_modules`, `.env`) not. Your index, branch and files are not touched; when the project has uncommitted changes, the reply to `delegate` says how many the copy includes. A later task does not see an earlier task's unmerged work.
  - **Merging.** Claude reviews the finished copy and merges it back file by file with `delegate_merge`. Nothing is committed and the index is not touched. A file that changed on both sides is left with conflict markers for Claude to resolve with both sides in view. A clean merge removes the copy and keeps the branch `consult/<id>` (the undo) until you clear the row. After Claude has resolved the markers, `delegate_merge` on the same task checks that none are left in the files that clashed (it names those that still have some) and then marks it merged, removing the copy and keeping the branch. The tab's **Discard** on a conflict row says so: its merged changes stay in the project, and only the copy and its branch go.
  - **Config-like files are held.** A file that runs or configures a tool (dot-files other than a short list of inert ones such as `.gitignore` and `.editorconfig`, `CLAUDE.md`, `AGENTS.md` and `GEMINI.md`, mise files, and eslint and prettier configs) is not applied. Its version is saved beside it as `<file>.task`, and Claude applies it only after you say yes.
  - **No git.** consult never sets git up on its own. The first time a copy would help, Claude asks once whether to run `git init`, add a `.gitignore` and make a first commit. If you say no, that is remembered for the project and workers edit in place; with two write tasks in the real folder Claude runs one after the other. The question is never asked in your home folder, a drive's root or a folder inside another repository.
- **Waking, and the Delegated tab.** When a task is done, held, conflicted, paused at a limit, failed or stopped, the plugin submits a short notice that starts a turn as soon as the session is idle, and sends a notification. This happens in interactive sessions only; elsewhere Claude uses `delegate_wait`. The **Delegated** tab of the `/consult` pane lists this project's tasks: a mark, the worker, the title, the state, `copy` or `here`, the elapsed time (`48s`, `1m36s`, then `12m`, `2h05m`), and one button. In a pane under 60 columns each task takes two lines (mark, worker, title and button, then the state, where and time dimmed); from 100 columns the state labels are long (`queued · waits for <model>`, `conflict · <file>`). **Cancel** stops a running or queued task. **Clear** takes a finished task off the list; for a read-only task whose result Claude hasn't read, a confirm says so; for a task that worked in place and was never merged, a confirm says the edits stay in the project and only the record goes. **Discard** throws away the unmerged work of a task in a copy, after a confirm. Press a task's name for its summary, then its folder and log as links (Ctrl+click) and the buttons **Open folder**, **Open report** (the worker's final message, when it wrote one) and **Show log**. Under the rows: the usage line, one line saying whether tasks stop or keep running when Claude Code closes (with a *change* link), **Stop all** while anything runs (it asks first, "Stop 3 tasks?", adding "in all projects" when other projects have tasks going), and the settings folded into one line (below). Tasks of other projects appear as a count only; you merge them from a session in their own project.
- **Usage limits.** Codex's usage windows are read from its own run records, with no polling; agy shows no quota, so consult notes when it last hit a limit. At 90 % of a window or more, `delegate` asks before starting (start anyway, wait, or another worker); at 100 % it doesn't offer to start anyway. A rate-limit error (a 429) from agy is not a full limit: it only warns, for 5 minutes. A worker you named is never switched silently. A task that hits a limit midway keeps its copy and session, shows `paused · limit` and wakes Claude, which can carry on after the reset with `delegate_send`.
- **Local tasks at once.** The number is per model and decided automatically from what the runner reports; unknown slots count as 1. A task for a model the runner can't hold alongside the loaded one waits in the queue (`queued · waits for <model>`) and a model is never swapped while a task is using it. The same rule applies to `ask_local` and a council's local seat: a call that would force a swap is refused with `local runner busy: task <id> …`, and `local_unload` is refused while a task holds the model.
- **Settings.** Global keys go in `~/.claude/consult.local.md` (they are ignored with a warning in a project's file) or are set from the tab's Settings fold:

  | Key | Allowed | Default |
  |---|---|---|
  | `delegate.code` | `codex` / `agy` / `local` / `ask` | `codex` (writing, building, editing) |
  | `delegate.research` | `codex` / `agy` / `local` / `ask` | `agy` |
  | `delegate.review` | `codex` / `agy` / `local` / `ask` | `agy` |
  | `delegate.private` | `codex` / `agy` / `local` / `ask` | `local` (private or offline work) |
  | `delegate.local_at_once` | `auto` or a whole number `1`–`8` (a ceiling; memory checks still apply) | `auto` |
  | `delegate.on_close` | `stop` / `keep` | `stop` |
  | `delegate.time_limit_min` | whole minutes, `10`–`1440` | `180` |

  The tab shows research and review as one row. **Workers edit** (`auto` / `here` / `copy`), and whether you declined git, are per project, kept in `~/.claude/consult-projects.json` by project path (never in your project) and set from the tab. A task that produces no output for 10 minutes is stopped as stuck, unless its worker is inside one command it started and has not finished (a long build prints nothing); the time limit still applies then.
- **When Claude Code closes.** By default the tasks stop. With `keep running` they carry on, each still bounded by the time limit; a local task then keeps the GPU busy and its model loaded, and its row says so. The next session in that project is told what ended meanwhile, and a session in another project shows it as a count in the Delegated tab.
- **Where things live.** `~/.claude/consult-delegate/` holds each task's folder (brief, log, final message, state), the copies under `worktrees/` and the usage notes. **Clear** removes a task's folder, copy and `consult/<id>` branch, and nothing else; consult never commits, stashes or resets in your project.

## Claude Desktop

The server also installs as a Claude Desktop extension, so Chat and Cowork can use it without Claude Code. `mcp/` is the extension.

**Install:** download `consult-<version>.mcpb` from the [releases page](https://github.com/NoCritics/consult-plugin/releases), then in Settings → Extensions → Advanced choose *Install extension* and pick it. From a clone you can instead choose *Install unpacked extension* and pick the `mcp` folder, or build the file yourself from the repository's root with `npx @anthropic-ai/mcpb pack mcp dist/consult-<version>.mcpb` (`dist/` is gitignored). Don't use Customize → Plugins instead: that route is tied to your account, syncs back into Claude Code as a second consult, and Chat ignores a plugin's local MCP servers.

**Updating:** both routes copy the folder (to `%APPDATA%\Claude\Claude Extensions\local.unpacked.nocritics.consult\` for the unpacked one), so repo changes reach Desktop only when you install again. Bump the version, reinstall, start a new chat.

**Runtime:** leave *Use built-in Node.js for MCP* on; no Node install is needed. The CLIs are not bundled: codex and agy must be installed and signed in, as for the plugin.

**What Desktop gets:** the 17 tools the extension's manifest lists. The slash commands, the skill and the SessionStart check are Claude Code only, so in Desktop ask for a model by name ("ask codex …"). **The Desktop extension doesn't include delegate in this release** (its tools aren't listed there): delegate needs the pane, the wake-up and a project folder, none of which Desktop has. Use it from Claude Code.

**Settings** come from `~/.claude/consult.local.md`; Desktop doesn't start the server in a project.

**Cowork gives up on a call after 4 minutes** ("No result received from the Claude Desktop app after waiting 4 minutes"). That limit is Cowork's, not consult's, and it can't be raised from here. A long codex run, say at your config's `xhigh`, can pass it. For quick questions in Cowork, ask for lower effort ("ask codex, low effort, …").

**Tool loading:** both hosts load MCP tools on demand, which is the "Searched available tools" step before the first call. Claude Code also reads consult's server instructions (every tool name, and "load what you need in one search"). Desktop 2.26454 ignores them, and also ignores the per-tool always-load flag (tried in 0.8.5), so expect one search before the first consult call in a Desktop chat.

## Vision (images)

`ask_codex`, `ask_agy`, `ask_local` and `council_vote` take an `images` array of file paths. Formats are checked by file signature, not extension: PNG, JPEG, GIF, WebP.

| Provider | How the image gets there | Bytes through the MCP server? |
|----------|--------------------------|-------------------------------|
| **codex** | native `-i <file>`, once per image | No |
| **agy** | paths named in the prompt; agy opens them itself | No |
| **local** | OpenAI `image_url` part, base64 data URI | **Yes**, so size matters |
| claude / gemini | not supported | — |

**Local models pay per pixel.** Ollama 0.30.7 + qwen3.5:9b, same image and question: 3000×2000 cost 4,084 prompt tokens, 1024×683 cost 700, with the same answer. So `ask_local` downscales PNGs to `local_image_max_edge` (default 1024) and says so in `image_warnings`. Only PNG can be resized without adding an image codec; larger JPEG/GIF/WebP go at full size with a warning. Use a 9B+ model for vision: qwen3.5:4b got a two-colour test image wrong where 9b was exact.

**Vision councils** send images to the generation round only; judges rank the text. A council that includes `claude` or `gemini` (which can't see images) is refused rather than silently skewed:

```
/consult:council --participants codex,agy,local <prompt about the screenshot>
```

## Image generation

Two tools make images. **`agy_generate_image`** (Antigravity, Google) is the default for "make an image of …". **`codex_generate_image`** (GPT through Codex) is used when you name GPT, OpenAI, Codex or ChatGPT for an image, or need a transparent background. The first part of this section covers agy; `codex_generate_image` follows it.

`agy_generate_image` makes images with Antigravity's built-in image generator and saves them to disk. Say "make an image of …" and Claude calls it. It returns the saved paths, and Claude can open the files to show you.

- **Where they go:** `output_dir` if Claude passes one, else the `agy_image_dir` setting, else `consult-images/` in the project (add it to `.gitignore` if you don't want them committed). Claude Desktop starts consult in its own install folder, so there, and whenever there is no project, they go to `~/Pictures/consult-images`. Existing files are never overwritten: a clash gets a `-1`, `-2` suffix.
- **Options** (Claude picks them per request):
  - `aspect_ratio`: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, or `auto` to let agy choose from the content. Default: the `agy_image_aspect_ratio` setting, else `1:1`. Left alone, agy guesses, so consult always sends one, except for `auto`.
  - `tier`: `pro`, `flash` or `inherit` (the default, the model running the call). The tier is the agy subagent that writes the image prompt and judges the result; Google picks the image model itself. `pro` suits text in the image, busy scenes and matching 2–3 references; `flash` suits drafts and simple icons.
  - `count`: 1–4 images, each its own generation. If fewer come back, the result says so.
  - `exact_prompt`: `true` hands your prompt to the image model word for word; by default agy may expand it.
- **References:** pass up to 3 `images` to edit a picture, keep a face or match a style. agy's image tool takes at most 3 and drops the rest without saying which, so consult refuses a 4th.
- **Size and time:** each image is a ~1K JPEG: 1024×1024 at 1:1, 768×1376 at 9:16, 1376×768 at 16:9. Each takes about a minute (56 s for one image, 134 s for two). The timeout is 5 minutes (`agy_image_timeout_ms`) plus 2 minutes per extra image, up to 30. Under Cowork the 4-minute limit is the real ceiling. If agy times out after saving some images, you get those with a warning.
- **Cleanup:** agy saves images inside its conversation and runs the generator as a subagent with a conversation of its own. consult copies the images out, then deletes both conversations.
- **Writes:** this is the one consult tool meant to create files. agy is told to make the images and touch nothing else; the same trusted-workspace caveat as `ask_agy` applies.

### GPT images through Codex

`codex_generate_image` asks Codex to generate images with OpenAI's image generation and saves them to disk, like the agy tool. It needs Codex signed in with your ChatGPT plan (`/consult:codex` or `codex_login_status`); no API key.

- **Where they go:** `output_dir`, else the `codex_image_dir` setting, else `consult-images/` in the project, else `~/Pictures/consult-images`, as for agy. Existing files are never overwritten. consult copies the images out of Codex's own folder and removes what it copied.
- **Options:** `aspect_ratio` (`1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `auto`; default the `codex_image_aspect_ratio` setting, else `1:1`), `transparent_background`, `count` (1-4), `exact_prompt`, and up to 5 reference `images`.
- **Shape:** the aspect ratio goes into the prompt and is honoured only approximately (1254×1254 with no shape asked; 1672×941 for 16:9).
- **Transparency:** `transparent_background: true` gives a real alpha channel, not a painted checkerboard.
- **Size and time:** PNG files. About 43 s for one image and 109 s for two. The timeout is 5 minutes (`codex_image_timeout_ms`) plus 2 minutes per extra image, up to 30; Codex's usual 10-minute floor does not apply. `timeout_s` overrides it per call. Under Cowork the 4-minute limit is the real ceiling, so 3-4 images can exceed it.
- **Refusals:** OpenAI's safety system refuses prompts that copy copyrighted characters or logos; the result then says so instead of returning images.
- **Model:** OpenAI chooses the image model and does not report it. `model` only picks the Codex model that drives the run.
- **Cost:** it uses your Codex usage quota (each image takes a few Codex turns). It is free under the ChatGPT plan, with no API key.

## How it fits together

```
 slash commands          skill ("ask codex ...", "council on X")
        \                      /
         v                    v
   ask_* (one-shot)   consult_chat_* (multi-turn)   council_vote (tournament)
         \                    |                       /
          v                   v                      v
   spawn codex / agy / gemini / claude        POST {local_base_url}/chat/completions
   (prompt via stdin)                         (local runner, no subprocess)
                               |
                               v
        clean response (+ session_id for chats) back to Claude
```

The MCP server is the only part that invokes the CLIs. Chats keep no state on consult's side: each CLI keeps its own session store (`~/.codex/sessions`, `~/.gemini/antigravity-cli`, `~/.gemini/tmp`) and consult relays the session id. Local runners have no session store, so `ask_local` is one-shot only.

## Settings (optional)

Settings live in `~/.claude/consult.local.md` (global) or `<project>/.claude/consult.local.md` (project). The first file found is used, the project's before the global one; they don't merge, except that runner settings (`local_runner` and `<runner>.<key>`) and the `delegate.*` settings are always read from the global file. Unknown keys, unknown runners and indented lines are reported by `local_status` (with file and line), never silently misread. Only the YAML frontmatter is read, and invalid values fall back to the default. [`examples/consult.local.md`](./examples/consult.local.md) lists every key, commented out. Add `.claude/*.local.md` to a project's `.gitignore` to keep it out of version control.

| Field | Type / allowed | Default |
|---|---|---|
| `codex_model` | string | codex's own: `model` in `~/.codex/config.toml` (the Codex app and TUI rewrite it when you switch models there) |
| `codex_reasoning_effort` | `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra` (model-dependent) | codex's own: `model_reasoning_effort` in `config.toml` |
| `codex_sandbox` | `read-only` / `workspace-write` / `danger-full-access` | `read-only` |
| `codex_timeout_ms` | positive integer | `max(timeout_ms, 600000)` |
| `codex_hooks` | boolean | `false`: your `~/.codex/hooks.json` doesn't run on consult calls; per-call `run_hooks` overrides |
| `agy_model` | string (see `agy_status`) | (CLI default) |
| `agy_effort` | `low` / `medium` / `high` / `xhigh` / `max` (model-dependent) | (CLI default) |
| `agy_timeout_ms` | positive integer | `timeout_ms` |
| `agy_image_dir` | folder path | `consult-images/` in the project, or `~/Pictures/consult-images` |
| `agy_image_timeout_ms` | positive integer | `300000`, plus 2 minutes per extra image |
| `agy_image_aspect_ratio` | `1:1` / `2:3` / `3:2` / `3:4` / `4:3` / `9:16` / `16:9` / `auto` | `1:1` |
| `codex_image_dir` | folder path | `consult-images/` in the project, or `~/Pictures/consult-images` |
| `codex_image_timeout_ms` | positive integer | `300000`, plus 2 minutes per extra image |
| `codex_image_aspect_ratio` | `1:1` / `2:3` / `3:2` / `3:4` / `4:3` / `9:16` / `16:9` / `auto` | `1:1` |
| `gemini_model` | string | (CLI default; recommended) |
| `gemini_approval_mode` | `default` / `auto_edit` / `yolo` / `plan` | `plan` |
| `claude_model` | string | (CLI default) |
| `local_runner` | `llama-swap` / `ollama` / `lmstudio` / `llama-server` / `openai` | unset: the 0.11.0 keys below. Global file only; `/consult:setlocal` writes it |
| `<runner>.url` | absolute http(s) URL | the runner's standard address (none for llama-swap and `openai`). Global file only |
| `<runner>.key_env` | the NAME of an environment variable | none: no key sent. Global file only; the key goes only to this machine |
| `<runner>.start` | text | shown in "not running" errors; never run. Global file only |
| `<runner>.default`, `.fast`, `.vision`, `.vision_best`, `.big` | a model name | none; nicknames `/consult:setlocal` writes after you confirm. Global file only |
| `local_base_url` | absolute http(s) URL | `http://127.0.0.1:11434/v1` (0.11.0 way; with `local_runner: ollama`, Ollama's address) |
| `local_model` | string: a model name or a nickname | none (0.11.0 way; with `local_runner: ollama`, Ollama's default) |
| `local_api_key` | string | `null` (0.11.0 way only; prefer `<runner>.key_env`) |
| `local_temperature` | number `0.0`–`2.0` | (runner default) |
| `local_reasoning_effort` | `none` / `low` / `medium` / `high` | (model default) |
| `local_timeout_ms` | positive integer | `timeout_ms`, at least 1200000 for llama-swap and for an Ollama model that doesn't fit the GPU |
| `local_image_max_edge` | positive integer | `1024` |
| `local_vram_mb` | positive integer | `nvidia-smi`'s reading; decides which models fit the GPU |
| `local_model_fast`, `local_model_vision`, `local_model_vision_best`, `local_model_big` | string | none (0.11.0 way; with `local_runner: ollama`, Ollama's nicknames) |
| `delegate.code`, `.research`, `.review`, `.private`, `.local_at_once`, `.on_close`, `.time_limit_min` | see [Delegate: background tasks](#delegate-background-tasks) | see there. Global file only |
| `council_use_bare` | boolean | `true` if `ANTHROPIC_API_KEY` is set |
| `council_timeout_ms` | positive integer | `timeout_ms` |
| `timeout_ms` | positive integer | `180000` |
| `log_calls` | boolean | `false`; `true` appends each call's metadata (never content) to `~/.claude/consult-log.jsonl` |
| `notify_after_s` | non-negative integer | `120`; request a push notification when a call took at least this long; `0` never (Claude Code band only) |
| `history_size` | integer `1`–`200` | `50` calls kept across sessions for the pane (Claude Code band only) |
| `summary_model` | `haiku` / unset | unset: a call's summary is its answer's first paragraph (Claude Code band only) |

## How the council works

`/consult:council` runs a 6-call tournament across `claude`, `codex` and `agy`:

1. **Generate (parallel):** each model answers the same prompt.
2. **Anonymize:** answers are shuffled to `A/B/C` (Fisher–Yates with `crypto.randomInt`), so judges don't know who wrote what.
3. **Judge (parallel):** each model ranks all three: `1st: <letter>`, `2nd: …`, `3rd: …`.
4. **Borda count:** with N candidates, 1st earns N−1 points down to 0 for last, summed across judges. Highest score wins.

If one model fails to generate, the tournament continues 2-way with `degraded: true` and the reason; if two fail, it aborts. An unparseable ranking is retried once with a stricter format, then dropped. On a tie, the result lists `tied_at_top`, and the slash command shows the tied answers and asks you to pick.

**The Claude participant runs stripped** (`--safe-mode --tools "" --strict-mcp-config --no-session-persistence --disable-slash-commands`), so it loads none of your CLAUDE.md, plugins, hooks or MCP servers. With haiku that cut a call from 37k to 3.7k tokens and $0.042 to $0.005 on subscription auth. `--bare` trims a little more but needs API-key auth; it is chosen automatically when `ANTHROPIC_API_KEY` is set, or via `council_use_bare`.

**Opt-in participants:** `gemini` and `local` must be named, e.g. `--participants claude,codex,agy,local` for a free fourth voice. A local model needs `local_model` set (checked before any paid call). Small models often fail the ranking format; the retry-then-drop path degrades the tournament instead of breaking it, but prefer 9B+ for judging.

## Notes & caveats

- **Codex runs read-only by default and leaves no trace.** `-s read-only` blocks writes (`codex_sandbox` can grant `workspace-write` or `danger-full-access`), and one-shot asks pass `--ephemeral`. Chat sessions persist until `consult_chat_end`, which removes them with `codex delete --force` (rollout file and state-DB row).
- **Codex results name the model and effort that ran**, e.g. `gpt-6-astra (codex default)` when codex chose. Codex 0.161 made `gpt-6.1-sol` the bundled default, but a `model` line in your `config.toml` (which the Codex app writes when you pick a model) still wins. Chats read them from the session record. One-shot asks leave none, so they read `~/.codex/config.toml` (or `$CODEX_HOME`), including the active profile. Each chat turn keeps the model and effort the chat started with; consult passes them back, because `codex exec resume` would otherwise switch to the config defaults.
- **Your codex hooks don't run on consult calls.** consult passes `--disable hooks`: hooks in `~/.codex/hooks.json` are written for interactive sessions, and a Stop hook that blocks the stop keeps codex working after its answer, racing the timeout. Turn them on per call (Claude passes `run_hooks: true` to `ask_codex`, chat start/send or `council_vote`; just ask) or by default with `codex_hooks: true`. Every codex result says `hooks_ran`.
- **Timeouts return what arrived, marked INCOMPLETE.** Codex gets at least 10 minutes (`codex_timeout_ms`), since image reviews at high effort run long; Claude Code backgrounds MCP calls after 120 s, so this doesn't block you. A timed-out call returns an error starting `INCOMPLETE:` with the partial output between `BEGIN/END PARTIAL <PROVIDER> OUTPUT` markers. For agy that is the answer cut off mid-stream. Codex doesn't stream text, so its partial is the last *complete* message, which may be the answer or only a progress note. The message suggests a longer per-call limit (below); for a lasting change raise `agy_timeout_ms` or `codex_timeout_ms`.
- **Each call can set its own time limit.** Every ask, chat turn, council, `agy_generate_image` and `codex_generate_image` call takes `timeout_s`, 30 to 1800 seconds, overriding the settings (codex's 10-minute floor included) for that call only. Claude sets it when a task is big, or you can ask ("give codex 20 minutes on this"); the slash commands take `--timeout 20m`. A timed-out call names the value to retry with, roughly double what it had. The 30-minute ceiling is Claude Code's idle timeout for a local MCP server (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 30 minutes by default): consult sends nothing while a call runs, so a longer call would be cut off by Claude Code instead. Under Cowork the 4-minute limit still applies.
- **A cancelled call stops its CLI.** When the host cancels a call or gives up on it, consult kills the codex, agy, gemini or claude process (or aborts the local request) instead of letting it run on and spend tokens.
- **Tool failures come back as tool results** (`isError: true`, message as text), so Claude reads them; only an unknown tool name is a protocol error.
- **Antigravity is NOT read-only, and consult cannot make it so.** Headless agy denies shell commands, but it **creates and edits files without asking inside any directory in agy's own `trustedWorkspaces`** (`~/.gemini/antigravity-cli/settings.json`), whatever the cwd. `--mode plan` and `--sandbox` change nothing, and there is no per-call override. If you once trusted your home directory, that is your whole home. consult prepends an *answer in text only, don't touch files* instruction to every prompt, passes `--disable-slash-commands`, reports any `denied_actions`, and shows the posture in `agy_status` (`write_posture.level`: `denied` / `home_trusted` / `workspaces_trusted` / `untrusted`). **To actually block writes**, add this to agy's settings.json (it applies to interactive agy too), or narrow `trustedWorkspaces`:
  ```json
  "permissions": { "deny": ["write_file(**)", "command(**)"] }
  ```
- **Antigravity is token-heavy.** Its built-in system prompt is ~20–29k input tokens even for a one-word question (agy 1.3.5), part of it served from cache.
- **Antigravity one-shot asks leave no local files.** Each agy conversation takes ~600 KB on disk (`conversations/<id>.db` plus `brain/<id>/`). `ask_agy` and the council's agy calls delete theirs once the answer is read, including after a failure. A call killed before agy reports its conversation id (a timeout or a cancel) can still leave one. Chats keep theirs until `consult_chat_end`. agy's own index keeps a ~1 KB row for each deleted conversation (it never prunes them, and consult does not edit agy's databases); a stale row is harmless.
- **Gemini's free tier is gone.** Google answers individual OAuth accounts with `IneligibleTierError: UNSUPPORTED_CLIENT`, and re-authenticating doesn't help; `gemini_auth_status` reports `ineligible_tier` and says so. `ask_gemini` stays for paid `GEMINI_API_KEY` users, in read-only `plan` mode. Everyone else should use `ask_agy`.
- **`codex_login_status` can be wrong.** The CLI reports "Logged in" even with a dead refresh token. If `ask_codex` fails with a token error, run `codex login` anyway. `codex_login_start` runs the device flow in the background and returns the URL; check `codex_login_status` after finishing in the browser.
- **Every call costs tokens** on its provider, except `ask_local`, which runs on your machine. A delegated task costs the same way on its worker's plan, and a local one runs on your machine.

## Testing

The band, pane and health line, from the plugin's folder (offline, free):

```
claude plugin test .        # the mod's tests in tests/
claude plugin validate .
```

The server, from `mcp/`, after `npm install` (it installs the SDK and esbuild, which only the tests and `npm run build:vendor` need):

| Command | Cost | Needs |
|---------|------|-------|
| `npm test` | free | nothing (offline unit tests + MCP smoke test) |
| `npm run test:local` | free | a local runner with a model; skips cleanly without one |
| `npm run test:live` | ~2 LLM calls | codex + agy signed in |
| `npm run test:chat` | ~4 LLM calls | codex + agy signed in |
| `npm run test:chat-end` | ~2 LLM calls | codex + agy signed in |
| `npm run test:council` | ~6 LLM calls | codex + agy + claude |
| `npm run test:image` | 1 image call, ~1–2 min | agy signed in |

`npm test` includes `mcp/delegate-test.js`: the delegate tools, supervisor, copies and merges, usage limits and the local queue, against fake workers and a temporary git repository (it never starts a real Codex, agy or pi).

`npm run test:local` on llama-swap uses `fast` only, and skips when another model is loaded so it never swaps out one you are using.

`CONSULT_NO_USER_ENV=1` is **for tests only**: it stops consult reading a key from the Windows user environment, to simulate a missing key. It can only turn that read off; it never makes consult send a key. Don't set it in normal use.

## Try it

| To trigger | Say or type |
|------------|-------------|
| Second opinion | "Get a second opinion on this approach: <paste code>" |
| One model | "Ask codex why my `for...of` over a Map yields `[key, value]` pairs." |
| With files | "Ask codex about src/utils.py": Claude reads the file and inlines it. |
| Vision | "Ask codex what's wrong with this screenshot: C:\shots\err.png" |
| Chat | "Start a chat with codex about structuring a state machine", then "Continue: what about thread safety?" |
| Council | "Run the council on this haiku." or `/consult:council --participants claude,codex Compare async/await and callbacks.` |
| Image | "Make an image of a lighthouse at dusk, flat vector style." |
| Local | `/consult:local --no-think Summarize what a bloom filter is in two lines.` |
| Status | "Is my local runner up?" / "Is codex signed in?" (free) |

## File layout

```
consult/
  .claude-plugin/plugin.json
  commands/                   # slash commands (delegate.md: /consult:delegate)
  examples/consult.local.md   # every setting, commented out
  hooks/
    hooks.json                # the SessionStart check and the band's module
    scripts/auth-check.js     # SessionStart check
    scripts/health.js         # the status line's checks
    scripts/setlocal.js       # the Local models tab's door to local_setup
    scripts/delegate.js       # the Delegated tab's door to the delegate code (show, cancel, clear, stop all, save)
    register.tsx              # the band, pane and health line: wiring
    mod/                      # call tracking, settings, history, health, results; delegate.ts wakes Claude, delegated.ts runs the tab
    ui/                       # band.tsx (above the prompt), pane.tsx (/consult), local-tab.tsx (Local models), delegated-tab.tsx (Delegated)
  types/index.d.ts            # the module's $.state contract
  tests/                      # claude plugin test: the module's tests
  skills/second-opinion/      # SKILL.md + references/file-handling.md
  mcp/                        # the MCP server; also the Claude Desktop extension
    manifest.json             # Claude Desktop extension manifest (MCPB)
    consult.js                # tool registry + request dispatch
    lib/
      codex.js  agy.js  gemini.js  claude.js  local.js   # one wrapper per provider
      council.js              # generate -> anonymize -> judge -> Borda
      local-runners.js        # runner types, keys from the environment, detection, llama-swap nicknames, setup writes
      local-models.js         # Ollama's inventory: facts, nickname proposals, quant swaps
      local-setup.js          # local_setup and local_unload, shared with the pane
      delegate.js             # the eight delegate tools and the server instructions' routing text
      delegate-route.js       # worker words, aliases and the default table
      delegate-store.js       # task folders, state files, the index, per-project settings
      delegate-workers.js     # codex, agy and pi command lines and output parsers
      delegate-supervisor.js  # runs one task: time limit, watchdog, stop on close
      delegate-git.js         # copies (worktrees), file-by-file merge, held files, git setup
      delegate-limits.js      # Codex and agy usage limits
      delegate-local.js       # local queue and slots; guards for ask_local and local_unload
      delegate-sweep.js       # heartbeat and clean-up of dead tasks
      pi-provider.js          # the pi extension that points a local task at your runner
      image.js                # image validation and PNG downscaling (no dependencies)
      spawn-cli.js            # subprocess runner: timeouts, buffer cap, tree-kill
      resolve-cmd.js          # CLI lookup: PATH, .cmd shims, install locations
      settings.js             # consult.local.md loader
      defaults.json           # time-limit defaults shared with the band
      util.js                 # validators, PII scrubbing, INCOMPLETE errors
    vendor/mcp-sdk.js         # the MCP SDK, bundled (generated: npm run build:vendor)
    vendor/THIRD_PARTY_LICENSES.md
    build-vendor.js           # builds vendor/ from node_modules
    delegate-run.js           # entry of a task's detached supervisor
    *-test.js, test-helpers.js
```

## Roadmap

Open ideas, not scheduled. What has shipped is in [CHANGELOG.md](./CHANGELOG.md).

- **Structured output:** a response-schema argument (agy has `--json-schema`, codex `--output-schema`).
- **Grounded search with citations** for "current state of X" questions.
- **JPEG/WebP downscaling** (needs an image codec dependency).
- **More image controls:** output size, if agy's generator grows an option for it.
- **Vision in chats;** `images` is one-shot and council only.
- **Local chats;** the server would have to keep the history.
- **`consult_compare`:** answers side by side without judging.
- **Council refinements:** a one-line rationale per judge in verbose mode, and judges that rank only the others' answers.
- **Progress notifications** for long calls.
- **pi fenced (checks step):** a local worker that can't write outside its folder; today it is `not fenced`, and so are workers editing in the real folder.
- **agy fenced:** the same for agy, if it gains a per-run way to keep it inside its folder.
- **Delegate in Claude Desktop:** without the pane and the wake-up, so with its own way to be told a task ended.
