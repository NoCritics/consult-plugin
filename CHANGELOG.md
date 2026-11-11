# Changelog

All notable changes to this plugin are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.17.0] - 2026-11-08

### Added

- **Real fences for agy and the local worker.** Both are now enforced, not just asked for in the brief. agy runs with `--settings` naming the task's folder as its only trusted workspace. pi runs inside Codex's sandbox, with the work folder as its one write root and its own agent and temp folders. Codex can be installed just for its sandbox; it needs no sign-in.
- **A sandbox self-test per Codex version**, cached in `~/.claude/consult-sandbox-check.json`: a pass is kept, a failure is retried after an hour, and an inconclusive check (offline, a write to home that failed some other way than a refusal, a cache that could not be written) runs again next task. It runs the way pi does: in a work folder of its own, with `TEMP` and `TMP` in a temp folder of its own. If Codex is missing, is inside the project, fails the test, or the folder is your home folder, a drive root or one that holds consult's own files, pi gets the guard only (file edits checked, commands not) and the task says so. If the sandbox cannot start, the task fails; it never retries without it.
- **consult's own files stay out of a fenced worker's reach.** Its task data, `~/.claude/consult-projects.json`, the sandbox-check file and the plugin itself:
  - a fenced agy write task in a folder that holds them (your home folder, say) is refused at start and at a follow-up, with a message to run it in a project folder or lift agy's fence for that project;
  - pi there gets the guard only, and the guard refuses edits to those files even inside the folder.
- **The Delegated tab and start reply** say how each task is fenced. The tab shows the guard for a home folder, a drive root or a folder holding consult's files when the project's write tasks run in place (a copy is none of those). A local task that drops to the guard after it started says so in its result, with the reason.
- **`delegate` never waits for the sandbox check.** It names the local layer from the cache; when nothing is cached yet the reply says `fence_layer: "pending"`, and the task's supervisor runs the check as the task starts (`delegate_status` and `delegate_result` then name the layer it got).
- **pi's newest sessions are never lost.** A temp copy left by a run whose copy-back failed is copied back before the next run; if that fails again, a fenced run continues on the temp copy and a lifted run stops without starting pi.

### Changed

- **The fence is on by default for every project**, for all three workers. A stored `soft` reads as `fenced`, and the tab can no longer save it. Fence choices are `fenced`/`none` for agy and the local worker.
- **agy read tasks trust no folder.** A read task can write nowhere; agy 1.5.3 was checked to still read its `--add-dir` folder.
- **A failed sandbox check is retried after an hour**; a pass holds for that Codex version.
- A sandboxed pi no longer shares the real temp folder: its `TEMP` and `TMP` are its own. Its `codex sandbox` run pins the environment policy (`shell_environment_policy.inherit=all`, `ignore_default_excludes=true`), so a `~/.codex/config.toml` that strips variables can't cut pi off from its runner.
- **A fenced Codex write task in a folder that holds consult's own files is now refused** (it ran there in 0.16.0), at start and at a follow-up, as for agy: run it in a project folder, or set Codex to full access for that project. Codex read tasks there are unaffected.
- agy's refused writes are reported only when agy says it denied a write, and relative paths are resolved against the work folder.
- pi's sessions are copied without `fs.cpSync`: on Windows, Node 22's `cpSync` ended the supervisor when a folder name was not ASCII (a Cyrillic project name, say).
- Tests never start the real Codex for a fence or write your sandbox-check cache: the supervisor, the Delegated tab and test servers all honour the test switch, and test servers get a scratch cache file.

### Known limits

- Fenced workers can read anywhere, including secrets, and agy has network access.
- agy's fence depends on agy honouring `--settings`, so an agy update could change it.
- Codex at `full access` and agy/local at `none` remain trusted with everything.
- Codex's permission entries stay on work folders, as they already do for Codex tasks.
- A fenced agy or Codex write task can't run in place in a folder that holds consult's own files; a pi task there gets the guard only.

## [0.16.0] - 2026-11-02

### Added

- **A fence per worker, per project.** In the Delegated tab's settings ("Fences (this project)"): Codex `fenced` or `full access`; agy and the local worker `stay in folder` or `anywhere`. Lifting one shows a warning before Save. Nothing else can set a fence: no tool, and not `consult.local.md`.
- **Markers where it matters.** The band leads a running task's row with `unfenced` when its fence is lifted; the tab's task notes read `full access`, `anywhere` or `not fenced`; the settings line shows e.g. `codex full access`.
- **Start and result notes.** The start reply says the fence is lifted, and an unfenced worker is asked to list the files it changed outside the folder, which the result tells Claude to name.

### Changed

- A task keeps the fence it started with. Every run (first, resume, follow-up) uses the stricter of that and the project's current setting.
- Codex at full access runs write tasks with `danger-full-access`; read tasks stay read-only. agy and the local worker at `anywhere` are no longer asked to stay in the folder.

## [0.15.6] - 2026-11-01

### Fixed

- **Ended rows can no longer pile up in the band.** While something still runs, the three most recently ended rows keep their places and older ones fold into one line above them (`✓ 2 answers · 1 task done`). A long turn of many calls used to push the prompt up a row per call.
- **A task first seen without its time limit gets it.** When an older server had already rewritten the index before the band first saw a task, its bar was missing for the whole run. The band now reads the limit from the task's own state file, once, and keeps it for every reader of the row, not only the band.

## [0.15.5] - 2026-11-01

### Changed

- **A row that ends while others still run stays in the band.** It becomes its result line in place (`✓ delegate · agy · default · 3m08s — finished`, `✓ ask · codex · … — "…"`), with no Cancel, until your next prompt. Before, it vanished until the last row ended, so a task that finished first looked as if it had never ended. When everything has ended, the one short summary row is unchanged.

### Fixed

- **A task's bar and time limit no longer come and go.** A consult server older than 0.15.4, still running in another session, rewrites the shared task index without the time limit, so the row flipped between `5m40s / 3h00m` with a bar and `5m40s` alone. The band now keeps a limit it has already seen.

## [0.15.4] - 2026-10-31

### Added

- **The band shows background tasks.** A task this session delegated gets a `delegate · <worker> · <model>` row above the prompt for as long as it is queued or running: its time against the task's own limit (`12m / 3h00m`) and a Cancel that cancels the task. When it ends it joins the short finished row (`✓ delegate · codex · gpt-5.5 · 42m — finished`) until your next prompt. With only tasks in the band, its button opens the Delegated tab instead of Answers. A Cancel that fails says why in a toast. The task index now carries each task's `time_limit_ms` for this.
- **Each band row says what kind of call it is:** `ask`, `chat`, `image` or `delegate`, then the provider and model, in the running rows and the finished row alike. A council row already named itself.

### Fixed

- **The band no longer wraps when the `/consult` pane is docked.** Its running rows were a fixed 83 columns wide and ignored the band's real width, which the docked pane narrows. They now fit it: the bar shrinks first, then the model label, then the bar goes (the clock still shows the time against the limit), down to about 50 columns.

## [0.15.3] - 2026-10-31

### Fixed

- **Claude picks between asking a model and delegating to it by one rule.** "Delegate agy to research…" could turn into a 15-minute `ask_agy` call instead of a background task. Naming a model now picks only the worker. The first match decides:
  1. Being told to delegate means `delegate`, even for a quick question.
  2. Project work (fix, write, run, debug, investigate) or research over many sources means `delegate`, even when the user says "ask".
  3. An answer, explanation or summary means `ask_*`.
  4. Otherwise the verb decides: "ask" or "what does X think" means `ask_*`; "task", "hand off" or "give X the job" means `delegate`.
  5. Failing all of these, `ask_*`.

  The server instructions, the tool descriptions and the skills now say the same thing. In 17 test prompts run twice each, Claude picked the expected tool 34 of 34 times, up from 31 of 34.
- **A very long answer no longer comes back as an error.** Claude Code refuses a tool result over about 25,000 tokens, and it saved a 76,000-character agy answer as JSON with the whole answer on one line. Now, in Claude Code, an answer over 40,000 bytes from an ask tool or a chat is saved in full as Markdown in `~/.claude/consult-answers/`, which keeps the last 100. Claude gets the first 8,000 characters, the length and the path. A delegated task's report that long comes back the same way, with the path to its `final.md`. Claude Desktop, which can't open the file, still gets the whole answer.

## [0.15.2] - 2026-10-30

### Security

- **A project opened through an 8.3 short path or a junction still can't run its own `codex.cmd` or `agy.cmd`.** On Windows, `where` reports a CLI by its long real path, so a project whose folder was spelled `C:\Users\RUNNER~1\...`, or reached through a junction, didn't match and its own `codex.cmd` could be picked. Both paths are now also compared by their real long path.

### Fixed

- **A home folder reached through a link is still the home folder.** When the home folder was reached through a symlink or junction (macOS's `/var` is `/private/var`), starting in it read `~/.claude/consult.local.md` as a project file and warned about it.
- **On macOS, a worker left running by a supervisor that died is now stopped.** The start-up sweep checked the worker's age with `ps -o etimes`, which macOS's `ps` doesn't have, so it never stopped the worker. It now uses `etime`, which Linux and macOS both have.
- **On Windows, a delegate's leftover process is found even when its command line names the task folder by its real long path.** A dev server a copy task left behind is stopped (an in-place task's is named in a warning) whether the folder was written with an 8.3 short name, through a junction or in full.
- The tests now pass on Linux and macOS. The mod's tests resolved their Windows-style paths there, the git-hook test scripts weren't executable, the fake worker's grandchild left the worker's process group, and three checks relied on Windows timings.

### Added

- **Tests run on Linux, macOS and Windows for every push and pull request** (GitHub Actions): the server's `npm test` and the mod's `claude plugin validate` and `claude plugin test`. The paid tests never run there.

### Changed

- **The README is a quarter of its old length.** The tests, file layout and ideas moved to CONTRIBUTING.md, and `examples/consult.local.md` is now the full settings reference.
- `LICENSE` names NoCritics.

## [0.15.1] - 2026-10-30

### Security

- **Opening a repository that contains its own `codex.cmd` or `agy.cmd` no longer runs it.** On Windows consult looked CLIs up with a search that tried the current folder (your project) before PATH, so a repository's own `codex.cmd` or `agy.cmd` could run at session start and on every call. It now looks CLIs up on PATH and in their install folders only, and ignores any hit inside the project. A CLI it finds only inside the project is reported as such ("found only inside the project folder"), not as not installed. consult's CLIs and their children no longer look up bare program names (`where`, `node`) in the project folder on Windows, and it works the same when Claude Code starts in your home folder or a drive root.
- **CLI paths are always quoted** (so `&`, `(`, `)`, `^`, `|`, `<`, `>`, `!`, `,`, `;` and `=` in a folder name cannot act as commands) when consult starts a CLI, so a folder like `C:\Tools\A&B` can no longer run part of its own name as a command. A path containing a quote or `%` is refused with a clear message.
- **The session-start check never contacts a local-model runner that is off this machine.** A project's `.claude/consult.local.md` could name a remote `local_base_url`, and the check would send it a request at every session start. It now skips any address that is not on this machine, as the health check already did.
- **`local_setup` with a new address sends the saved key only when you name its variable again.** Giving a new `url` without `key_env` used to send the key saved for the old address to the new port, even in a preview. The new address now gets no key, and the write removes the old `key_env` line.
- **After a save, the Local models tab tells Claude only a fixed sentence.** It used to repeat the runner's model names in a message Claude reads as coming from you, so a model named like an instruction could steer it. The message now says only that local model settings changed and to call `local_status`.

### Fixed

- **On macOS and Linux a timed-out or cancelled call now stops the CLI's own child processes too.** Before, only the CLI itself was killed, so a wrapper's child could keep running (and spending tokens) and hold the call open past its timeout.
- **`agy_generate_image` keeps agy's original images when copying them to the output folder fails** (disk full, permissions). Before, agy's conversation was deleted anyway and the originals were lost; now they stay, and the error names the folder that holds them.
- **A delegated agy task whose answer arrived is no longer reported as failed when agy's connection drops afterwards.** agy can finish its answer and then end with an error (such as a stream idle timeout); the task now ends done (or held) with that error as a warning, and `delegate_result` returns the answer. An answer cut off mid-stream still fails, and a usage-limit error still pauses the task.
- **At session start, a `codex` or `agy` found only inside the project is reported as such** ("found only inside the project folder") instead of "not found - install it or fix PATH". A delegated task whose worker program lies inside its project or its copy now fails with the same message instead of running it.
- **On macOS and Linux, closing the terminal or stopping the host stops the CLIs a call is waiting on.** Since each CLI got its own process group, they no longer received the terminal's hang-up; the server now stops them when it exits, is terminated or interrupted, or its connection closes.
- **A CLI path that cmd.exe cannot take safely is reported as a failed start** (`spawn_error`) rather than a plain error.
- **A delegated agy task's warning from the end of a run is scrubbed of secrets and shortened** like its other messages.
- **A follow-up that fails no longer shows the previous run's answer as its own.** `delegate_result` returns the final message only when the latest run wrote one, and a new run clears the old one when it starts.
- **The Local models tab's Save writes only what the preview showed.** When the runner could not be reached, typing its address made the pickers appear but the preview had been built without them, so Save could write nicknames the diff never listed. The preview now runs again with the pickers filled, and Save waits for it.

### Changed

- **The README, slash commands and skill match what the code does.** Desktop gets 17 tools, not 16; `/consult:codex` passes images and says Codex is read-only by default (`codex_sandbox` can change that); `/consult:chat` passes `--timeout`; `/consult:delegate` may list and cancel tasks without asking; images are attached with `images` rather than refused as binary files; and local models are described as running on this machine while Claude still writes the prompt and reads the answer.
- **Installs from GitHub need no `npm install`.** The MCP SDK, the server's only npm dependency, is bundled into `mcp/vendor/mcp-sdk.js` by `npm run build:vendor` (esbuild 0.28.2), with the licences of the bundled packages in `mcp/vendor/THIRD_PARTY_LICENSES.md`. The SDK and esbuild are dev dependencies now, needed only for the tests and the build; a unit test fails if the bundle wasn't rebuilt from the locked SDK or imports anything but Node built-ins. The `.mcpb` no longer packs `node_modules`. `npm audit fix` moved zod to 4.6.7 and fast-uri to 3.1.9 first, so the bundle carries no known advisories.
- **Install from the `nocritics` marketplace:** `/plugin marketplace add NoCritics/consult-plugin`, then `/plugin install consult@nocritics`.

## [0.15.0] - 2026-10-29

### Added

- **`codex_generate_image`: GPT images through Codex.** Makes images with OpenAI's image generation under the user's ChatGPT plan (no API key) and saves them as PNG. consult collects them from Codex's generated-images folder, copies them to the output folder (`output_dir`, else the new `codex_image_dir` setting, else `consult-images/` in the project, else `~/Pictures/consult-images`), removes its own leftovers from Codex's folder, and returns path, type, size and dimensions with Codex's reply re-pointed at the copies.
  - Options: `aspect_ratio` (default from `codex_image_aspect_ratio`, else `1:1`; followed only approximately), `transparent_background` (real alpha), `count` 1-4, `exact_prompt`, up to 5 reference `images`.
  - Timeout: `codex_image_timeout_ms`, default 300000, plus 2 minutes per extra image, up to 30; Codex's 10-minute floor does not apply. `timeout_s` overrides.
  - The band shows and times it like `agy_generate_image`. agy stays the default image tool; Claude picks this one when you name GPT, OpenAI, Codex or ChatGPT, or need a transparent background. It spends Codex usage quota.

### Fixed

- **A task started before `/clear` still wakes Claude.** `/clear` gives the session a new id in the same process; the watcher now counts tasks owned by the ids the session had before as its own, so they are no longer taken for another session's.
- **A restart of the consult server no longer stops running tasks.** A `/mcp` reconnect, a plugin reload or a crash gave the server a new id, and about 45 s later every running task of the session was stopped as "the Claude Code session that started it closed". The heartbeat now names the server's session, and a task is stopped for a closed session only when its owner server's heartbeat is stale and no server with a fresh heartbeat names the task's session; the new server also takes over its session's queued and running tasks in this project when it starts and on each heartbeat. A task started with no session id is stopped as before.
- **On Windows, a dev server a worker started and left behind no longer survives a task that works in a copy.** The end-of-run sweep of the worker's descendants ran only when one held the pipes open, and could not reach a process whose parent had already exited. It now runs at every end and stop, and also when the sweep stops a task whose supervisor died. For a task in a copy it also finds the processes created since the worker started whose command line names the copy's folder, follows each up through its living parents that also started during the run, and kills the topmost process of the chain (with its tree) when the chain ends at an exited parent. That covers `Start-Process`, `cmd /c start`, and `npm run dev` / `next dev` (a live launcher over a server that names the copy's path). It does not cover a process that, with everything above it in the chain, never names the copy's folder (a relative `node server.js` under launchers that use relative paths). A program you start yourself from inside the copy during the run is left alone when it descends from a program that was already running, but can be killed if it is started through a launcher that exits. For a task that works in place nothing is killed (the folder is also where your own programs run); the result's `warning` names the processes of the same kind that are still running.
- **A conflict has a way out.** After a merge left conflicts and Claude resolved the markers, `delegate_merge` on the task now checks the listed files for markers (naming any that remain) and marks it `merged`, removing the copy and keeping the branch; a conflict that the merge already reported is no longer listed by `delegate_status` as needing attention. The Delegated tab's confirm for a conflict row no longer says its changes "will be lost": its merged changes stay in the project, and only the copy and its branch `consult/<id>` are removed.
- **A read-only task is told to change nothing, and an agy one is checked.** Every worker's brief now says "answer in text, do not create, edit or delete files" for a read task and asks for findings, not "what you changed". agy can't be fenced, so after an agy read task consult compares the folder with how it was before the run and, if files changed, `delegate_result` (`warning`) names them and the wake notice says how many (never the names: a worker picks them, and a notice is submitted with your authority).
- **A read-only task whose result Claude hasn't read can be cleared** from the Delegated tab (Clear, after "Claude hasn't read its result. [Yes] [No]").
- **A rate-limit error (429) no longer blocks agy for an hour.** It was recorded as a full limit, so `delegate` refused to start even with `confirm_limit`; it now warns ("agy was rate limited N min ago") for 5 minutes or until its reset time, then clears. Real usage-limit hits are unchanged.
- **A worker busy in one long command is no longer stopped as stuck.** The 10-minute no-output watchdog counted the silence of a long build or test run (codex prints nothing between a command's start and its end). It is now suspended while the worker's stream shows a command or tool started and not finished (codex, agy and pi); the time limit still applies.
- **A follow-up after a conflict no longer rewrites the markers you resolved.** `delegate_merge` now records the commit it merged and the next merge of that task applies only what came after it, instead of the whole change again.
- **A held or paused read-only task can be cleared** from the Delegated tab (Clear, with the "Claude hasn't read its result" question when it is unread); no button was offered for it before.
- **Clear works when the project is no longer a git repository.** Removing the copy ran `git worktree prune` in the project, which threw, so the claim was released and every later Clear failed. The copy and the row now go, and the result notes what git was not told.
- **Elapsed time under ten minutes shows seconds** (`1m36s`, not `1m`).

Open ideas are listed under Roadmap in the README.

## [0.14.0] - 2026-10-27

### Added

- **Delegate: background tasks for Codex, agy and local models.** `/consult:delegate <worker> <task>` (or plain words such as "give the About page to Codex") hands a task to `codex`, `agy`, `local` or `local:<nickname>`; `gpt`, `openai`, `gemini`, `argon`, `qwen`, `llama` and `offline` are accepted as worker words. The task runs in the background while you keep working, and a bare "delegate this" still goes to Claude's own subagents. Eight new tools: `delegate`, `delegate_status`, `delegate_list`, `delegate_result`, `delegate_merge`, `delegate_send`, `delegate_cancel`, `delegate_wait`. Every worker runs with permissions given for that one run; `~/.codex/config.toml`, agy's settings and `~/.pi/agent/*` are never written.
- **A default table** for when you point at consult without naming a worker: code goes to `codex`, research and review to `agy`, private work to `local`, anything else asks you. Each row can also be set to `ask`.
- **Copies and merging.** A task that writes files in a git project works in a git worktree under `~/.claude/consult-delegate/` on the branch `consult/<id>`, started from your folder as it is now (uncommitted and untracked files included). `delegate_merge` applies it file by file without touching your index or committing; conflicts are left as markers for Claude to resolve, and files that run or configure tools (dot-files outside a short inert list, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, mise and eslint/prettier configs) are saved as `<file>.task` and applied only after you say yes. **Workers edit** (Auto, Here or In a copy) is a per-project setting. A project with no git: Claude asks once whether to set it up; if not, workers edit in place. Needs git 2.40 or newer.
- **Claude is woken when a task ends**, stops at a usage limit, conflicts or fails, in interactive sessions, with a notification; the next session is told what ended while Claude Code was closed.
- **The Delegated tab** in the `/consult` pane: one row per task with its state, where it ran, the elapsed time and the one button that fits (**Cancel**, **Clear** or **Discard**, the last two asking first when work would be lost), the usage line, **Stop all** (asking first: "Stop 3 tasks?", with "in all projects" when other projects have tasks going), and the settings folded into one line. A pane under 60 columns draws two lines a task; 60 to 99 one line with short state labels; 100 and up the long labels. Press a task's name for its summary, its folder and log as links, and **Open folder**, **Open report** (the worker's final message) and **Show log** buttons. A task's summary now prefers the first line of prose to a heading. When `delegate` starts a copy and the project has uncommitted changes, the reply says how many the copy includes. A server removes heartbeat files of servers gone for more than a day.
- **Usage limits.** Codex's windows are read from its own run records; at 90 % `delegate` asks before starting, at 100 % it doesn't offer to start anyway, and a named worker is never switched silently. A task that hits a limit midway is kept as `paused · limit` and can be continued after the reset.
- **Several local tasks at once**, decided per model from what the runner reports (`delegate.local_at_once`: `auto` or a ceiling `1`–`8`); a task waits in a queue when the runner can't hold both models.
- **New global settings** in `~/.claude/consult.local.md`: `delegate.code`, `delegate.research`, `delegate.review`, `delegate.private`, `delegate.local_at_once`, `delegate.on_close` (`stop` or `keep`), `delegate.time_limit_min` (default 180). Per-project values (Workers edit, git declined) are kept in `~/.claude/consult-projects.json`.

### Changed

- **The consult pane has a third tab**, **Delegated**, beside Answers and Local models.
- **Local calls don't swap a model out from under a delegated task.** While a task is using the local runner, `ask_local` and a council's local seat are refused with `local runner busy: task <id> …` when they would force a swap, and `local_unload` (and **Save and unload** in the Local models tab) is refused.
- **consult's server instructions** now also say when to use `delegate` and when to leave a task to Claude's own subagents.
- **The Claude Desktop extension has no delegate in this release.** Its manifest sets `CONSULT_DELEGATE=off`, which leaves the eight `delegate_*` tools, their server instructions, the heartbeat and the sweeps out of the server; it still offers the 16 tools it did.

## [0.13.2] - 2026-10-24

### Added

- **LM Studio is recognised** (by its `/lmstudio-greeting`) instead of showing as a second, `openai` runner. Its models come with facts from LM Studio's `/api/v1/models`: size, parameters, quant, images, loaded, and type (MoE for a count like `35B-A3B` or an architecture ending in `moe`). Nicknames are proposed as on Ollama, a name to save is checked against its list, embedding models are left out, and `local_unload` unloads each loaded instance. An older LM Studio without `/api/v1` works by model name, as before.
- **Only models that can reply are listed.** On Ollama a model whose capabilities lack `completion` (an embedding model) and on LM Studio a model whose type isn't `llm` are left out of nicknames, the Models list and the runner line's count; so is a llama-swap or custom-server model with `chat: false` in its metadata.
- **A custom OpenAI-style server can describe its models**: `arch`, `engine`, `decode_tps` and `vision` in a `meta` object on each `/v1/models` entry, the fields llama-swap's `metadata:` uses. The Local models tab lists them.

### Changed

- The Local models tab says a runner that was never set up and isn't running is **not found** (was "not set up").
- A stopped llama-swap no longer brings up the key variable field.
- A tied nickname starts on the first tied model (both marked `(tie)` in the list) instead of a "pick one of the tied models" entry, so Save works without an extra pick.
- A nickname row stays on one line: the `• new` / `• was` / `⚠ images` marks keep their width and only the dim note is cut.
- The MCP server is declared in `.claude-plugin/plugin.json` (`mcpServers`) instead of `.mcp.json`, so a Claude Code session started inside the plugin's folder no longer lists a broken project server named consult.

## [0.13.1] - 2026-10-24

### Added

- **Model facts without writing them down.** The Local models tab's speed for a model with no `decode_tps` in llama-swap's config comes from your own calls: `ask_local` and council's local seat time each answer (tokens after the first over the time from first to last token), keep the last five per runner and model in `~/.claude/consult-speeds.json`, and the tab shows their median as `~N t/s` ("~ measured on your calls"). `ask_local`'s result carries the call's `decode_tps`.
- Ollama models list their type (MoE when Ollama's `/api/show` reports experts, dense otherwise) and engine (Ollama) in the tab.

## [0.13.0] - 2026-10-23

### Added

- **Tabs in the consult pane:** **Answers** (as before) and **Local models**. `/consult` opens on the tab used last; the band's Answers opens Answers.
- **The Local models tab** sets up the local runner with pickers instead of a chat turn: the runner with a dot for its state, one line per nickname (default, fast, vision, vision-best, big; `⚠ images` when a vision nickname's model isn't known to read images), `• was <saved model>` on a nickname changed but not saved yet, ● the saved model and ○ the picked one in a picker's list, the runner's models listed once with their type, engine, decode speed and `images` (from llama-swap's per-model `metadata:`; the description when there is none; unused ones dim), the saved nicknames as text when the runner isn't running, fields for an address, a key variable's name and a start note when needed, the settings diff after each change, **Save** and **Save and unload**. After a save a toast tells you and Claude gets a one-line note. It runs `hooks/scripts/setlocal.js`, `local_setup`'s own code (now in `mcp/lib/local-setup.js`), so the pane and the chat steps save the same lines.
- **`/consult:setlocal` opens that tab** in Claude Code (`/consult:setlocal ollama` on Ollama). Elsewhere (Claude Desktop, the mobile app, a command not typed at the prompt) its chat steps run as before.

### Changed

- `local_setup`'s Ollama proposal lists the models (name, size, GPU fit, vision), as llama-swap's does; a runner that passes names through (LM Studio, llama-server, openai) gets the five nickname rows with what is saved.
- `local_setup` refuses a `key_env` that isn't a variable name (a pasted key), without repeating it.
- llama-swap models read `arch`, `engine`, `decode_tps` and `vision` from the model's `metadata:` in llama-swap's config (`local_setup` lists them).
- `local_setup` answers with the runner's saved nicknames (`saved_nicknames`) and start note (`start`), also when the runner isn't running.

### Fixed

- `hooks/scripts/setlocal.js` ends by itself instead of calling `process.exit()`, which on Windows (Node 24) tripped a libuv assertion while fetch's connections closed: the pane showed "the setup script failed".
- Two health-script tests read the developer's own `~/.claude/consult.local.md`; they use a home of their own.

## [0.12.1] - 2026-10-21

### Changed

- Clean-up, no behaviour change: shared lists, helpers and runner messages live in one place, so a failed `ask_local` and `local_status` word "not running", "needs its key", "key rejected" and "key variable not set" the same way (`local_status` now also says to check the variable holds the runner's current key). Descriptions name llama-swap.

### Fixed

- `mcp/local-test.js` skips instead of crashing when llama-swap can't say which model is loaded.

## [0.12.0] - 2026-10-21

### Added

- **llama-swap support.** consult recognises a llama-swap (from its `/v1/models` or the `"src": "llama-swap"` on a 401), reads its models, aliases and the loaded model (`/running`), sends its key, and proposes nicknames from the gateway's own aliases (`default`, `fast`, `vision`, `big`). `fast:nothink` and the other `:nothink` names pass through as given.
- **Several runners, one in use, switching keeps nicknames.** Per-runner settings are dotted keys in the global file: `local_runner`, `<runner>.url`, `<runner>.key_env`, `<runner>.start`, and `<runner>.default` / `.fast` / `.vision` / `.vision_best` / `.big`, for `llama-swap`, `ollama`, `lmstudio`, `llama-server` and `openai`. A runner is recognised by what answers, not by its port.
- **`/consult:setlocal` sets up and switches runners.** With no argument it probes this machine (11434, 1234, 8080, 9292 and configured addresses), goes straight to the nickname table of the runner in use, and lists the others; `/consult:setlocal <runner>` switches. Every write is shown as a diff first and confirmed once, together with an offer to unload a model another runner holds. The old file is copied to `consult.local.md.bak` before the first write.
- **Keys from the environment.** `<runner>.key_env` names the variable; consult reads it at call time from its own environment or, on Windows, the user environment (`HKCU\Environment`), so a variable created after Claude Code started works. Setup finds `LLAMA_SWAP_API_KEY` by itself on the standard ports.
- **`local_unload`** frees a runner's memory (Ollama: each loaded model by name with `keep_alive: 0`; llama-swap: `/unload`), only after you agree.
- **`ask_local`'s `runner`** uses another configured runner for one call. It is refused while the runner in use holds a model, so two runners never fill memory at once. The result names the runner.
- **Progress while waiting:** local calls stream, and consult sends MCP progress ("waiting for <model> … <its llama-swap description>", then tokens so far).
- **`local_status`** names the runner in use, lists llama-swap's models (name, description, aliases, loaded, vision) and the saved nicknames with whether each resolves, other runners and what they hold, and settings warnings.
- **Settings warnings** for unknown keys, unknown runners, indented lines and runner lines in a project file, each with file and line, in `local_status`, `local_setup`, the server log and the session-start check. Both settings readers (server and band) share the rules and a test file.

### Changed

- **A model that stops sending tokens for 2 minutes** after it started ends the call as `INCOMPLETE:` with what it had; running out of time while still thinking says so (with `reasoning_effort: "none"` as the fix), instead of "slow to first token". Reasoning, and llama-swap's loading messages, are never answer text.
- **One slow floor, 20 minutes** (`local_slow_floor_ms` in `defaults.json`, was 10): every llama-swap call and an Ollama model that doesn't fit the GPU, unless `timeout_s` or `local_timeout_ms` is set. The band's bar uses the same number. A refused connection, a missing key or any other HTTP error still fails at once.
- **Images:** a model you name keeps the images unless it is known not to read them (llama-swap reports vision only for the loaded model); an implicit default switches to the `vision` nickname. A runner refusing images is reported as "`<model>` can't read images" with the models that can.
- **Errors name the runner and what to do:** "No local model runner is listening at … (llama-swap). Start it: <your start hint>", "needs its key: add `llama-swap.key_env` …", "The environment variable … is not set", "rejected the key from …".
- **The result's `model` is the name consult asked for** (llama-server reports its GGUF file path).
- **The council's local member, the SessionStart check and the band's health** use the runner in use; local counts as configured when `local_runner` is set (or 0.11.0's `local_model`). A llama-swap that wants its key shows `local ✗ needs its key`.

### Security

- **"On this machine" is an exact check:** a literal 127.x.x.x address, `[::1]` or `localhost`. Before, any name starting with `127.` (such as `127.example.com`) and `0.0.0.0` counted.
- **A key from the environment goes only to an address on this machine, never follows a redirect,** and is never shown. Outside setup, a key goes only to the address configured with it.
- **Setup only saves addresses on this machine** and refuses others before contacting them: a tool call can't point consult's prompts off the machine. A remote runner is a line you write by hand.
- **Runner settings are read from the global file only;** a project's file can't choose a runner, an address or a key variable.

## [0.11.0] - 2026-10-19

### Added

- **Local model nicknames: `/consult:setlocal` and the `local_setup` tool.** With Ollama, consult reads the model list live (`/api/tags`, never a fixed list) and proposes one model per role: default (`local_model`), `fast`, `vision`, `vision-best` and `big`, from facts only: size, parameters, quant, whether the model reads images, and whether it fits the GPU (`nvidia-smi`'s memory minus 1 GiB, or the new `local_vram_mb`). Claude shows the table with a reason per row and saves only what you confirm, as `local_model` and `local_model_fast` / `_vision` / `_vision_best` / `_big` lines in the settings file in effect; every other line and comment stays as it was. Equal models are a tie you pick.
- **`ask_local`'s `model` takes a nickname, a full name or a fragment** that matches one installed model; `local_model` takes a name or a nickname. A bare name means `:latest`, as in Ollama. Two names for one model (`qwen3.5-9b:latest` and its tag) count once.
- **`local_status`** adds each model's facts (`models_detail`), `vram_mb` and the saved nicknames, each marked installed or replaced.

### Changed

- **A saved model swapped for another quant keeps working.** When it is gone and exactly one other quant of the same model is installed, calls use that one and the result says `quant_swapped`. A model that is gone entirely stops with an error naming `/consult:setlocal`; with several quants left, the error names them instead of picking.
- **Images go to the `vision` nickname** when the chosen model can't read them (`switched_for_images`), in `ask_local` and in a council's local member.
- **Models that don't fit the GPU get at least 10 minutes** (`local_slow_floor_ms` in `defaults.json`), unless `local_timeout_ms` or `timeout_s` is set. The band's bar for local calls always assumes this floor, so a slow call is never settled as timed out while it still runs.
- **The SessionStart check** judges `local_model` the way `ask_local` will: a nickname or a swapped quant is fine, and a deleted model points to `/consult:setlocal` instead of `ollama pull`.
- **The slash commands and the second-opinion skill named the tools `mcp__consult__*`**; the plugin's tools are `mcp__plugin_consult_consult__*`. All six commands and the skill now use those names.

## [0.10.0] - 2026-10-19

### Added

- **The band, the pane and the health line in Claude Code.** A function-hooks module (`hooks/register.tsx`, listed under `modules` in `hooks/hooks.json` beside the SessionStart check) gives consult an interface in Claude Code's terminal. Nothing changes in what Claude receives from consult, except on Cancel, and a fault in the module passes the call through as if it were absent.
  - **The band:** one row per running call (`ask_codex`, `ask_agy`, `ask_local`, `ask_gemini`, `agy_generate_image`, the chats and `council_vote`) with provider, model and effort, a bar against the call's limit (`timeout_s`, else the limit worked out from your settings the way the server does; warning colour past 75 %, error past 90 %), elapsed / limit, and **Cancel**, which stops that call alone: Claude reads "Cancelled by the user from the consult band." and its turn goes on. A call Claude Code moves to the background at 120 s keeps its row until its task notification brings the result (60 s past its limit it ends as a timeout); its Cancel then stops the task with TaskStop, or a toast says to ask Claude if Claude Code refuses. The band sits in a rounded box. A council's bar spans its two rounds. After the last call ends, a slim row with the summary or a count stays until your next prompt.
  - **A toast** for every finished call, and a push notification request for calls of `notify_after_s` (120) seconds or more (Claude Code decides whether it goes out; delivery to a phone is not yet confirmed).
  - **`/consult`** (or `/consult-answers` if the name is taken) and the band's **Answers** toggle a pane: health marks, this session's calls, earlier sessions' history (`history_size`, 50). The calls for one prompt share a rounded box headed by the question, answers parted by a rule, ten boxes at a time. Entries expand to the answer as Markdown with Copy answer / Copy prompt (a toast confirms each copy); image entries have a `file:///` link, Open (image files only), Show in folder and Copy path.
  - **The status line** (Claude Code shows it after `⚠ consult:`): `checking…`, then `codex ✓ agy ✓ local –` at the start of an interactive session, resumes included; it clears at your first prompt. A node script (`hooks/scripts/health.js`) runs the checks, outside Claude's tool permissions, and never contacts a `local_base_url` that is not on this machine (that shows `?`). A call failing because a service is signed out, missing or unreachable pins `<service> ✗ <reason>` until a call to it answers. Earlier history entries whose answer was only Claude Code's background notice are hidden.
  - **Settings** in `consult.local.md`: `notify_after_s`, `history_size`, `summary_model` (`haiku` writes summaries with Claude Code's haiku).
- **`mcp/lib/defaults.json`**: the time-limit defaults the server and the module share, so the bars span the limits the server enforces. The server's behaviour is unchanged.
- **`agy_generate_image` options**, from agy 1.4.2's own `generate_image` schema and live tests:
  - `aspect_ratio` (`1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9` or `auto`; default from the new `agy_image_aspect_ratio` setting, else `1:1`). It is always sent unless `auto`, because agy left to itself picks a ratio from the content.
  - `tier` (`inherit`, `flash`, `pro`): the agy subagent that writes the image prompt and judges the result. The tool description tells Claude when to choose each.
  - `count` (1–4): each image its own generation. The timeout grows by 2 minutes per extra image (capped at 30), and the band's bar follows. A short result carries a warning.
  - `exact_prompt`: the prompt goes to the image model word for word.
  - The result echoes `aspect_ratio`, `tier` and `count`.

### Changed

- **`agy_generate_image` refuses more than 3 reference images**, before agy runs. agy's image tool takes at most 3 and silently dropped the rest.
- **The tool description gave every image as 1024×1024.** It now gives the real ~1K sizes (1024×1024 at 1:1, 768×1376 at 9:16, 1376×768 at 16:9) and about a minute per image.

### Fixed

- **README and the example settings said the project file overrides the global one key by key.** Only the first file found is used (project, then global), as `settings.js` has always done.

### Verified

- `claude plugin test .` (105 tests), `claude plugin validate .`, `tsc` and `npm test` pass. A `--plugin-dir` copy overrides the installed consult for that session, so development needs no disabling.

## [0.9.2] - 2026-10-17

### Added

- **A per-call time limit, `timeout_s`.** Calls kept timing out at whatever the settings allowed, and the only fix was editing `consult.local.md`. `ask_codex`, `ask_agy`, `ask_local`, `ask_gemini`, `agy_generate_image`, `consult_chat_start`, `consult_chat_send` and `council_vote` now take `timeout_s`, 30 to 1800 seconds, which overrides every settings-derived limit for that call, codex's 10-minute floor included; for a council it is the limit of each member's call in each round. Out-of-range values are refused before anything starts. The ceiling is Claude Code's idle timeout for a stdio MCP server (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 30 minutes by default, per the docs): consult sends nothing while a call runs, so a longer call would be cut off by the host instead of ending in consult's own `INCOMPLETE:` result. The tool descriptions, server instructions and skill tell Claude when to raise it; the slash commands take `--timeout <seconds>` or `--timeout 20m`.
- **Timeout messages say what to retry with.** An `INCOMPLETE:` result, a CLI timeout and a local-model timeout now suggest `timeout_s` at about twice the limit that ran out (at most 1800), still naming the setting for a lasting change, and say so when the call already had the maximum. Claude may retry once with it.

### Fixed

- **Short agy limits ended in consult's kill, not agy's own deadline.** agy's print timeout was 90% of the call's limit with a 30 s floor, and its clock starts after its own start-up, so at 30 s consult killed agy first: no partial answer, and the message named the generic `timeout_ms` instead of `agy_timeout_ms`. The margin is now 10% but at least 8 s (floor 10 s), so a 30 s call gives agy 22 s and returns its partial; limits above 80 s are unchanged. The `INCOMPLETE:` text reports the call's own limit, so the suggested retry doubles the number the caller set.

### Verified live

- `timeout_s: 30` cut a high-effort codex essay off at ~31 s (codex's 10-minute floor overridden) and an agy essay at ~29 s on agy's own deadline, both suggesting `timeout_s: 60`. `test:live` still passes. The council path is covered by code review, not a live run.

## [0.9.1] - 2026-10-14

### Added

- **`agy_generate_image`: image generation through Antigravity.** agy 1.2+ hands image requests to a built-in `image-generator` subagent and saves each result, a 1024x1024 JPEG, in the top level of the conversation's `brain/<id>/` folder. consult could not use it: `ask_agy` tells agy to answer in text only, and since 0.9.0 the conversation, images included, is deleted after the answer. The new tool sends `AGY_IMAGE_PREAMBLE` instead ("generate with your image tool, touch nothing else, reply with the paths"), copies every distinct top-level image out before the conversation is deleted, and returns their paths, type, size and dimensions, with agy's reply re-pointed at the copies. Reference images (`images`) are named in the prompt the way `ask_agy` attaches images; agy's `.tempmediaStorage/` cache of viewed images is skipped, and a reference saved at the top level is skipped by content hash.
  - Output folder: `output_dir`, else the `agy_image_dir` setting, else `consult-images/` in the project. A server started in the home directory, at a drive root, inside its own folder, or inside an app or system folder (`%LOCALAPPDATA%`, `%APPDATA%`, Program Files, `ProgramData`, `SystemRoot`; `/Applications` and `~/Library` on macOS; `/usr`, `/opt`, `/snap` on Linux) uses `~/Pictures/consult-images`. Claude Desktop 2.37 starts the server in its own install folder, `%LOCALAPPDATA%\AnthropicClaude\app-<version>` (from its log), which an update replaces. The folder is created before agy starts, so an unwritable one fails at once, not after two minutes. Existing files are never overwritten (`name-1.jpg`, `name-2.jpg`).
  - Timeout: `agy_image_timeout_ms`, default 300000.
  - Images survive a failed finish. The copy runs before the conversation is deleted on every path, so when agy saves some images and then hits its print timeout or an error, the call returns them with a `warning` instead of an error. A call with no images still fails with agy's error. Verified live: three images asked for with a 2-minute timeout returned the two finished ones and a warning naming `agy_image_timeout_ms`; no conversation was left behind.
  - Verified live: one image in 56 s, two images from a reference in 134 s, a reference-guided recolour in 92 s; the agy conversation count was the same before and after each call. `npm run test:image` runs the end-to-end check. Unit tests cover the folder choice, image discovery, no-overwrite copying and path re-pointing.

### Fixed

- **Deleting an agy conversation left its subagents' conversations behind.** A subagent, such as the image generator, runs as a conversation of its own (~2 MB: a db plus a `brain/` folder), recorded in the parent's `brain/<id>/.system_generated/subagents/<subagent-id>.json`. `agyChatEnd` now deletes those first (up to three levels deep) and reports `subagents_removed`. This covers `consult_chat_end`, one-shot `ask_agy` and council cleanup as well as image generation. Verified live on the two probe conversations from this release.

### Changed

- Model examples: agy now lists `claude-opus-5-5-{low,medium,high}` and `claude-sonnet-5-5-{low,medium,high}`; the 4.6 Claude ids named in 0.9.0 are gone.

## [0.9.0] - 2026-10-14

CLI re-check: codex 0.160 -> 0.162.1, agy 1.2.17 -> 1.3.5, Claude Code 2.1.289 -> 2.1.299, Gemini CLI 0.62.0. MCP SDK 1.32.1 is still the latest v1 release.

### Added

- **New effort levels.** Codex 0.16x lists `ultra` for gpt-6.1-sol, gpt-6-astra, gpt-6-sol and gpt-5.6-sol/terra (from `~/.codex/models_cache.json`); consult rejected it. agy 1.3 takes `--effort xhigh` and `max`; consult allowed only low/medium/high. Both enums are widened (`REASONING_EFFORTS`, `AGY_EFFORTS`); the `ask_agy` schema now uses `AGY_EFFORTS` instead of its own hard-coded list. Levels stay model-dependent, and an unsupported one fails with the CLI's own message, e.g. `gemini-3.8-flash has no "xhigh" effort (available: low, medium, high)`. Verified live: codex `ultra` answered in 9.8 s on gpt-6-astra.

### Fixed

- **One-shot agy asks left a conversation on disk every time.** Each is ~600 KB (`conversations/<id>.db` plus `brain/<id>/`), and `ask_agy` and every council round that used agy kept theirs. Of the 208 agy conversations on this machine, 44 carry consult's answer-only preamble and take 83 MB (~1.9 MB each); older consult ones, from before the preamble, cannot be told apart from the user's own. `askAgy` now deletes its conversation once the envelope is read, on success and on failure, reading the id from whatever JSON agy printed (`conversationIdFrom`). The delete is best effort and never turns an answer into an error. Chats are unchanged: `consult_chat_start` uses the inner `runAgyTurn` and keeps its conversation until `consult_chat_end`. One-shot results no longer return a `session_id` that pointed at a deleted conversation. A call killed before agy prints its envelope (timeout, cancel) can still leave one. Verified live: 212 files before and after an `ask_agy`; 213 during a chat, 212 after `chat_end`; unchanged after a failed ask. Four unit tests. agy keeps a ~1 KB row per conversation in its own index (`conversation_summaries.db`, `jetbox_summaries_proto.pb`) and never prunes rows whose files are gone; rows from `consult_chat_end` deletions in August are still there. consult does not edit agy's internal databases, so each one-shot leaves such a row instead of ~1.9 MB. It is harmless: resuming such an id prints `conversation "<id>" not found` and starts a new conversation.
- **The Gemini ineligible-tier hint pointed at the wrong replacement.** It suggested `ask_codex` and `ask_local`; it now names `ask_agy`.
- `consult_chat_start` described `reasoning_effort` as "Codex only", but it is also passed to agy.

### Changed

- Model examples follow what the CLIs offer now: agy 1.3.5 lists `gemini-3.8-flash-{low,medium,high}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking` and `gpt-oss-120b-medium` (Gemini 3.7, 3.6 and 3.1 Pro are gone), and accepts a base id such as `gemini-3.8-flash` without an effort (1.3.4). Codex examples lead with `gpt-6.1-sol`, the bundled default since codex 0.161.
- README: Gemini 4 Argon, the agy token figure (~20-29k input tokens on 1.3.5), and the codex default model.

### Verified unchanged

- **codex 0.162.1:** `exec --json` events, `-o`, `--ephemeral`, the rollout's `turn_context` model and effort, `exec resume` with the pinned model and effort, `codex delete --force`. All re-run live.
- **agy 1.3.5:** the JSON envelope (`conversation_id`, `status`, `response`, `usage`, `denied_actions`), print mode inferred from piped stdin (consult never passes `-p`, which 1.3 now treats as taking the next argument as the prompt), `--print-timeout`, `--disable-slash-commands`, and the answer-only preamble. Without the preamble a "PONG" prompt made agy try a shell command and return an empty answer.
- **Claude Code 2.1.299:** the stripped council participant (`--safe-mode --tools "" --strict-mcp-config --no-session-persistence --disable-slash-commands`) answered on Haiku 5.5 for $0.0007. 2.1.296 raised the server-instructions limit to 4,096 characters; consult keeps its ~1,250 under the old 2,048 for other hosts.
- **Gemini CLI 0.62.0:** still `IneligibleTierError` on an individual account; it does not offer Gemini 4 Argon.

### Found

- **Gemini 4 Argon** (`gemini-4-argon`, generally available 2026-10-13) reaches Antigravity on Google AI Ultra plans. agy rejects it on this account (`model gemini-4-argon is not recognized`, listing the six available models), so it is a plan gate, not an id mismatch. No code change needed: model ids pass through, and `agy_status` will list it once the account has it.

## [0.8.8] - 2026-10-08

### Fixed

- **A cancelled call kept its CLI running.** The request handler ignored the host's abort signal, so when a host cancelled a call or gave up on it, codex (or agy, gemini, claude) ran on to the end, up to 10 minutes, spending tokens, and could overlap a retry. Found from a Cowork chat that hit its 4-minute limit on `ask_codex` and retried. The handler now runs each call with its signal in an `AsyncLocalStorage` context; `runCli` kills the process tree on abort (kind `cancelled`) and the local client aborts its request. Verified live: after a cancelled `ask_codex`, no `codex.exe` was left, where 0.8.7 left it running. Three unit tests (abort mid-run, already aborted, prompt stop).
- **CLIs installed under a path with a space failed to start on Windows.** Under `shell: true`, cmd.exe split an unquoted executable path at the first space ("'C:\Program' is not recognized"), which affects any CLI under `Program Files` or a profile such as `C:\Users\Jane Doe`. `spawnableCmd` quotes such paths at all three spawn sites (`runCli`, codex device login, the SessionStart hook).

### Found

- **Cowork stops waiting after 4 minutes.** The message comes from Cowork's side of the bridge, not from Desktop's local code or from consult. The failed attempt was codex at the configured `xhigh`, which also read one of the user's codex skills (`~/.codex/.sandbox/sandbox.<date>.log` shows a `Get-Content` on `~/.codex/skills/...` in both attempts). Documented in the README with the workaround (lower effort for quick questions).
- **Codex's agent features cost about 4 s and 3k tokens per call.** On a trivial prompt at low effort, consult's call took 9.2 s and 18.3k input tokens; with plugins, apps, browser and computer use, multi-agent, image generation and skill search disabled, 5.0 s and 15.1k, with the same answer. Not changed yet.

## [0.8.7] - 2026-10-08

### Fixed

- **Trailing comments in `consult.local.md`.** `key: value  # note` kept the note as part of the value, so most such keys were dropped as invalid and a model name carried the comment with it. The loader now strips ` # ...` as YAML does; a quoted value or a `#` with no space before it (a URL fragment) is kept. Two unit tests.
- **The example settings file set live values.** Copying `examples/consult.local.md` into a project silently overrode the global config (`timeout_ms: 180000` beat a global `600000`). Every line is now commented out.

### Changed

- **Docs and comments trimmed** (about 500 lines net). The README drops its investigation notes (now only in this changelog), merges the two timeout caveats into one, removes stale lines ("plan mode" in the diagram; chats said to be codex/gemini only), and drops a hardcoded user path. The example settings file lists every key in one line each. The six slash commands share a five-line file-handling summary that points to the skill reference, keeping the council and local size limits. Code comments lose benchmark tables and cost asides; the numbers stay in the README.
- `loadImage` and `CliError` are no longer exported (nothing imported them). A dead `.gitignore` rule is gone.

## [0.8.6] - 2026-10-07

### Added

- **Codex results name the model and effort that ran.** `model` used to read `(codex default)` whenever Claude had not passed one, and there was no effort field. Now `model` and `reasoning_effort` give the requested value, or codex's default with the name filled in (`gpt-6-astra (codex default)`). Chats read them from the session's rollout (`turn_context`), which is exact. One-shot asks are `--ephemeral`, so they read `config.toml` under `$CODEX_HOME` or `~/.codex`, including the active profile.

### Fixed

- **Chat turns kept switching to the config defaults.** `codex exec resume` re-reads `config.toml` for model and effort, so a chat started at `low` answered its next turns at the configured `xhigh` (and a chat started with an explicit model fell back to the default one). `consult_chat_send` now passes the session's last model and effort back with `-m` and `-c`. Verified live: start, send and send all ran at `low`. `chat_send` also used to report `(codex default)` even for a chat started with an explicit model.

### Removed

- **The always-load setting from 0.8.5.** Desktop's Chat and Cowork both ignored `_meta["anthropic/alwaysLoad"]` on extension tools, so the setting cost nothing but did nothing either. The finding is recorded in the README under *Tool loading*.

### Tests

Unit tests for the config.toml reader (top-level keys, other tables ignored, profiles, quoted profile names), the rollout reader (last turn wins) and the default label.

## [0.8.5] - 2026-10-07

### Added

- **Always-loaded tools for Claude Desktop.** Desktop ignores server instructions (see 0.8.4), so Claude still searched before its first consult call. `CONSULT_ALWAYS_LOAD` (comma-separated tool names) marks those tools `_meta["anthropic/alwaysLoad"]`, which asks the host to load them at session start instead of behind tool search; unknown names are ignored with a stderr warning. Only the Desktop manifest sets it, from a new *Always-loaded tools* extension setting that defaults to `ask_codex,ask_agy` (about 1,300 tokens per chat). Claude Code leaves it unset and pays nothing. The smoke test checks that no tool is flagged by default and that the manifest default flags exactly those tools.

## [0.8.4] - 2026-10-07

### Added

- **Server instructions.** Claude Code and Claude Desktop both defer MCP tool definitions (tool search), so Claude had to search -- in one observed Desktop chat, three times -- before its first consult call. The server now sends `instructions` at startup (~1,250 chars; Claude Code truncates at 2,048): what consult is for, when to use it, every tool name, a request to load all needed tools in a single search, and the two rules that matter most (the other model cannot see the conversation; `INCOMPLETE:` is not an answer). The smoke test checks they are present, under the limit, and name every tool.

### Found

- **Claude Desktop's unpacked install is a copy, not a link**: a full snapshot of the folder (tests included; `.mcpbignore` applies only to `mcpb pack`) under `%APPDATA%\Claude\Claude Extensions\local.unpacked.<author>.<name>\`. Repo edits reach Desktop only after installing again. Desktop also keeps no log of extension stderr here. Recorded in the README.
- **Claude Desktop does not use server instructions yet.** With 0.8.4 installed (verified in its copy), a chat asking for codex and agy still ran three tool searches. Claude Code reads them (documented).

## [0.8.3] - 2026-10-07

### Added

- **Claude Desktop extension.** `mcp/manifest.json` (MCPB manifest v0.4, validated with `mcpb validate`) makes `mcp/` installable through Settings → Extensions → *Install unpacked extension*, or packed as `dist/consult-<version>.mcpb` via `mcpb pack` (gitignored; `mcp/.mcpbignore` leaves tests out). It launches the same `consult.js` with `${__dirname}`, so the Claude Code plugin, which reads `.claude-plugin/plugin.json` and `.mcp.json`, is unchanged. Desktop gets all 13 tools; slash commands, the skill and the SessionStart check stay Claude Code-only.
- A startup line on stderr, `[consult] <version> started: <path> cwd=<dir> node=<version>`, which hosts write to their MCP log.

### Changed

- **Settings when started in the home directory.** If the server's cwd is the home folder, `<cwd>/.claude/consult.local.md` *is* the global file. It used to be read as a project file and given the project-scope security warnings; it is now read once, as global.

### Investigated, no change needed

- **Plugin-only env vars:** none. `CLAUDE_PLUGIN_ROOT` appears only in `.mcp.json`.
- **How Desktop runs extensions:** with *Use built-in Node.js* on, as an Electron utility process of `claude.exe` (`--utility-sub-type=node.mojom.NodeService`), not a `node.exe` child. consult does not use `process.execPath` or `argv`.
- **A reduced environment:** started with an EMPTY environment and cwd `C:\Windows\System32`, `codex_login_status`, `agy_status` and `ask_codex` all worked. They also worked with an experimental env fallback disabled, so the fallback was dropped. `resolve-cmd` already derives its install-location paths from the home directory, Node falls back to `cmd.exe` without `ComSpec`, and both CLIs find their sign-in unaided.

### Tests

244 unit assertions (was 240): settings when cwd is home, and version lockstep across `plugin.json`, `package.json` and `manifest.json`. The smoke test checks that `manifest.json`'s tool list matches `tools/list`. The packed bundle, unpacked, serves all 13 tools.

## [0.8.2] - 2026-10-05

Cleanup release: removes dead code and stale docs, net about -430 lines. No tool schema changes.

### Removed

- **`agy_mode`.** Ignored since 0.7.0 but still validated, defaulted, warned about and documented. An old `agy_mode:` line in a config file still loads -- unknown keys are inert.
- **The agy plan-stub guard** (`isPlanStub`). It caught a "click Proceed" reply that only `--mode plan` produced, and consult never passes `--mode`.
- **The pre-`codex delete` fallback** in `consult_chat_end` (a file walk for codex versions without the subcommand).
- **`.github/workflows/`.** GitHub only reads workflows from the repo root, and this monorepo has no remote, so neither file could run; `live-tests.yml` still targeted gemini.
- **The hook's private copies of the CLI resolver and config parser.** `auth-check.js` now imports `mcp/lib/resolve-cmd.js` and `mcp/lib/settings.js` (built-ins only, verified), so it can't drift: it now uses the same quote handling, validation and install-location fallbacks as the server.

### Fixed

- **A missing CLI was reported as a generic error.** `ensureCmd` threw a plain `Error` before spawning anything, but `agyStatus` and `codexLoginStatus` detect "missing" by `kind === 'spawn_error'`, so `agy_status` said `reason: "error"` instead of `binary_missing` with the install hint. The throw now carries the kind.
- **`test:chat` leaked sessions** (about 600 KB per agy conversation); it now ends both, including when a turn fails.
- The example config quoted an agy error ("returned PARTIAL output") that consult no longer prints; CONTRIBUTING said Node >= 18 against `engines: >=20`; the server header still described "Codex, Gemini, and Claude CLIs".

### Changed

- Code comments state current behaviour and why; the version-by-version history they carried is in this file. The README roadmap lists only open ideas (it also repeated shipped history and had two entries for structured output), and the changelog no longer keeps a second copy of it. CONTRIBUTING's PR/issue boilerplate became a short change checklist, and its design constraints now cover argv quoting and the hook's imports.

### Tests

240 unit assertions: tests for the removed code went with it; added a missing-CLI `kind` test. Live: `test:live`, `test:chat` (cleans up after itself, including on failure), `agy_status` (14 models, `write_posture: home_trusted`), and the hook run healthy and with a configured-but-down local runner.

## [0.8.1] - 2026-10-05

### Added

- **Per-call `run_hooks`** on `ask_codex`, `consult_chat_start`, `consult_chat_send` and `council_vote` (codex participant). 0.8.0 turned codex hooks off for consult calls with only a config-file switch, so the calling model could neither see nor change it. Precedence: the call's `run_hooks` → `codex_hooks` in `consult.local.md` → off. Chat turns choose independently (hooks are a per-invocation flag on `exec resume` too).
- **Discoverable from the MCP itself**: the parameter is in each tool's input schema with a description of the default and when to use it, the `ask_codex` description says hooks are off by default and how to enable them, and every codex result reports `hooks_ran: true|false`. The second-opinion skill says to pass it only when the user asks for their hooks.

### Tests

251 unit assertions (was 245): precedence rules for `codexRunHooks`. The smoke test now fails if `run_hooks` is missing from any of the four schemas or from the `ask_codex` description. Live through the MCP server: default → `hooks_ran: false`, `run_hooks: true` → `true`, `run_hooks: false` → `false`.

## [0.8.0] - 2026-10-05

Fixes a field-reported failure: two `ask_codex` image reviews (2026-10-05, gpt-6-astra, one at `high` and one at `medium` effort) both died with `codex exec timed out after 180000ms` while codex was still composing a long structured answer, and the caller got only a raw stderr tail it could not tell was incomplete. Also the two-week re-check: agy 1.2.7 → 1.2.17, codex 0.154 → 0.160, Claude Code 2.1.278 → 2.1.289, MCP SDK 1.30.0 → 1.32.1.

### Root cause (measured on codex-cli 0.160.0)

- `runCli` kills codex at `timeout_ms` (180 s default). `askCodex` never reaches its `-o` file, which codex writes only at exit, so the error was the last 2000 chars of **stderr**.
- **Codex does not stream text.** Each agent message reaches stderr (and stdout, and `--json`) in one piece when it completes — an 8 KB answer landed as a single stderr chunk at 77 s. So a mid-answer kill loses the message being written; what the caller saw was the tail of an *earlier, completed* message, starting mid-sentence because it was a tail.
- **The user's own codex hooks ran on every consult call.** `~/.codex/hooks.json` has an Impeccable "Design deep pass" Stop hook (30 s budget). Every consult call printed `hook: Stop … Failed` (~1–4 s), and a Stop hook that blocks the stop makes codex keep working after its answer is complete — on a design review in a design project, a second pass racing the timeout.

### Changed

- **`codex_timeout_ms`**, defaulting to `max(timeout_ms, 600000)`: codex gets at least 10 minutes unless you set it. Chosen over raising the global `timeout_ms` because a global 10 minutes would also apply to `ask_local` (a wedged runner would hang that long) and to every council judge round; codex at high effort with images is the one provider that legitimately needs it. Applies to `ask_codex`, codex chat, and the codex council participant. Claude Code backgrounds MCP calls after 120 s, so a long codex call does not block the session.
- **A codex timeout now says INCOMPLETE and returns the partial, labelled.** `askCodex` runs with `--json` alongside `-o` (verified compatible), so the completed `agent_message` events survive a kill. The error's first line is `INCOMPLETE: codex did not finish within …ms`, names `codex_timeout_ms`, says what codex was busy with (`web_search`, `reasoning`, …), and fences the **last complete message** between `BEGIN/END PARTIAL CODEX OUTPUT` markers, warning that it may be a progress note. Up to 30 000 chars, keeping the beginning. If `-o` comes back empty on a non-timeout exit, codex's own `turn.failed` reason from the JSONL is reported instead of "returned no content".
- **agy partials use the same format** (`util.js incompleteError`): the print-timeout case now shows the partial as a labelled block (it previously showed a 300-char tail), and the message names agy's actual `--print-timeout`. New for agy ≥ 1.2.10: a run that streamed part of an answer and then hit a model error exits 3 with the partial in its JSON envelope — consult now returns it as `INCOMPLETE: agy failed mid-answer (exit 3): …`, noting when agy marked the error retryable. Previously the partial was dropped.
- **Codex hooks are off on consult calls** (`--disable hooks`, codex's per-invocation feature toggle; verified on `exec` and `exec resume`). `codex_hooks: true` restores them.
- **Tool failures are tool results.** Errors used to escape the handler as JSON-RPC errors (-32603), so the caller got a bare message. They now return `{ isError: true, content: [text] }`, per the MCP spec, so the calling model reads them as the tool's output. Unknown tool names remain protocol errors.
- `ask_codex` description, `/consult:codex`, and the second-opinion skill tell the caller how to handle `INCOMPLETE:` — never present the partial as the answer.
- MCP SDK `^1.30.0` → `^1.32.1` (1.32's only behaviour change is same-origin redirects on HTTP transports; consult is stdio).

### Fixed

- **Settings-defaults unit test read the developer's real `~/.claude/consult.local.md`.** It asserted `timeout_ms === 180000` and failed the moment a global file with `timeout_ms: 600000` existed. It now runs with cwd and home pointed at empty temp dirs.
- **Live tests were stale**: `test:live`, `test:chat` and `test:chat-end` exercised gemini (fails on individual accounts) instead of agy, and checked `msg.error`, which the `isError` change would have made silently pass. Ported to agy, with a shared `toolError()` helper; the agy chat-end check accounts for its `brain/` directory. All four live suites pass against real codex and agy.
- Missing-CLI errors and the second-opinion skill still said "restart Claude Code" after installing a CLI; only a new terminal picks up the PATH change (established in v0.6.1). Corrected.
- Publishing docs pointed at the old `stuff-local` marketplace. Now `ouroboros`, and the manual refresh uses `git archive HEAD -- .` from `plugins/consult/` — a bare `git archive HEAD` inside the monorepo would export every plugin into consult's cache, and the tree-ish form `HEAD:plugins/consult` silently produces an empty archive under Git Bash.

### Verified unchanged

- codex 0.160: `exec` flags identical to 0.154; JSONL event shapes, `-o`, `--ephemeral`, `exec resume`, `codex delete --force` all re-run live.
- agy 1.2.17: envelope, error envelope for an unknown `--model`, model list. 1.2.15's "respects a permission denial instead of working around it" only helps consult.

### Tests

245 unit assertions (was 202), smoke test now asserts the `isError` contract and the unknown-tool protocol error. Live: forced 45 s codex timeout through the MCP server returned the labelled INCOMPLETE result with codex's progress note and `busy with: web_search`; `test:live`, `test:chat`, `test:chat-end` pass.

## [0.7.2] - 2026-09-25

Prompt-surface audit (`/claude-api prompt-audit`, target Claude Opus 5.5): descriptions and instructions brought back in line with what the code does. No behavior change in the server.

### Fixed

- **`consult_chat_start` no longer implies every chat is read-only.** It said "Codex or Gemini ... read-only sandbox / plan mode"; it now names agy and says agy can edit files in directories the user trusts in agy.
- **`council_vote` describes the current council**: default participants claude/codex/agy, 2-5 via `participants`, 2 calls per participant plus a retry for an unparseable ranking (was "Claude, Codex, and Gemini ... ~6 calls").
- **`codex_login_status` states its known false positive** (stored-credential check can say authenticated while the token is dead), which was only in the skill.
- `chat.md` and `file-handling.md` list every participant / prompt-taking tool instead of the pre-agy set.

### Changed

- **second-opinion skill description**: ~38 enumerated trigger phrases replaced by intent categories. Routing probe on Opus 5.5 (old vs new, only consult loaded): explicit "ask codex ... screenshot" and "get a second opinion" route the same; a plain "what's wrong in this screenshot?" stays with Claude under both (3/3 each).
- `ask_gemini` and `codex_login_start` descriptions state their conditions at normal volume instead of "OPT-IN / Do NOT" and "Use ONLY".
- History phrasing ("agy replaced gemini", "Google withdrew ...") in `agy.md` / `council.md` restated as the current rule.
- `file-handling.md`: dropped a developer note ("don't add a `--file` flag") and a fourth restatement of the no-truncation rule.

## [0.7.1] - 2026-09-21

Weekly re-check against agy 1.2.7 (was 1.2.1), Claude Code 2.1.278 (was 2.1.268), codex 0.155.1 available (0.154.0 installed — its updater script fails under PowerShell strict mode; the only 0.155.1 change is a TUI reasoning-summary default, so nothing here depends on it). MCP SDK 1.30.0 still latest.

### Changed

- **agy structured failures are read, not just tail-dumped.** agy 1.2.6 made headless failures machine-readable: exit 1 plus a JSON envelope with `status: "ERROR"` and an `error` string (e.g. unknown `--model`, which now lists the valid ids), or exit 3 plus an `AGY_ERROR: {...}` line on stderr with status, HTTP/gRPC code, retryability and error id for agent/model-API failures. consult now runs agy with non-zero exits allowed and reports the envelope's own message; an `AGY_ERROR` line becomes an error with `kind: "retryable"` when agy says so, and the parsed object rides on `err.agy_error`. Verified live for the envelope path; the stderr-line path is unit-tested only (it needs the backend to fail).
- **`agy_mode` plumbing removed.** It was ignored since 0.7.0 but still threaded through `askAgy`, chat start/send, the council and the tool dispatch. Gone; the one-time "this is ignored" warning moved to the settings loader so it fires once per process, names the file, and does not depend on a call being made.

### Verified unchanged on agy 1.2.7

- JSON envelope and `usage` shape; `denied_actions` on a refused write; the `[agy] print timeout ... returning partial output` stderr marker (still status SUCCESS, exit 0) — the partial-output guard still fires.
- The 1.2.6 change of the headless default timeout to *unlimited* does not affect consult, which always passes `--print-timeout`; it does mean a bare `agy` run outside consult can now block indefinitely.
- Claude Code 2.1.274 fixed `--strict-mcp-config` holding the first headless turn and 2.1.277 made `claude -p` exit 1 on internal errors instead of hanging — both only improve the stripped council participant; no consult change needed.
- Gemini CLI: still `IneligibleTierError` on an individual account (0.60.0 released; not installed, not needed).

### Tests

202 unit assertions (was 197): `parseAgyErrorLine` shapes. Live: unknown-model envelope through `askAgy`, then a normal ask.

## [0.7.0] - 2026-09-11

A re-validation release. Every provider CLI was re-tested against its current version (codex-cli 0.154.0, agy 1.2.1, Claude Code 2.1.268, gemini-cli 0.54.4, MCP SDK 1.30.0 — already current) and the wrappers updated for what changed. Two of the findings are corrections to things earlier releases stated as fact.

### Fixed

- **Antigravity was never read-only, and v0.5–0.6.1 said it was.** Measured on agy 1.2.1: headless agy auto-denies *shell commands* everywhere, but **creates and edits files without asking inside any directory in its own `trustedWorkspaces`** (`~/.gemini/antigravity-cli/settings.json`), regardless of the cwd it was launched from — and this machine trusts the whole home directory. `--mode plan` and `--sandbox` change nothing about that. The earlier "refuses writes (4/4)" measurement only ever asked it to run a shell command. There is no per-call override: no flag, and `JETSKI_APP_DATA_DIR` is not honoured, so consult cannot ship a private settings file.

  What v0.7.0 does instead: prepends an *answer in text only, do not touch files* instruction to every agy prompt (held 2/2 against an explicit "edit this file" request that the bare prompt lost 3/3), always passes `--disable-slash-commands`, surfaces `denied_actions`, and reports the posture from `agy_status` (`write_posture.level`: `denied` / `home_trusted` / `workspaces_trusted` / `untrusted`, plus the trusted list). The verified hardening — `"permissions": { "deny": ["write_file(**)", "command(**)"] }` in agy's settings.json — is documented in the README and the `agy_status` note; it applies to interactive agy too, so it is the user's call. Tool description, README, example config and `/agy` + `/chat` commands corrected.

- **agy expanded a prompt starting with `/` as a slash command.** Piping `/help` returned agy's command table (`conversation_id: ""`, zero tokens, no model call) as if it were an answer. `--disable-slash-commands` is now always passed; a `/`-prefixed prompt verified to reach the model.

- **agy ≥ 1.1.28 returns truncated text as a success.** When `--print-timeout` expires mid-turn the CLI now "returns the partial output it has and exits successfully with a warning on stderr" — `status: SUCCESS`, exit 0, `duration_seconds: 0`, all usage counters 0, response cut mid-sentence. consult detects the stderr marker and raises a `timeout` error carrying the partial tail instead of handing a half-answer to the caller or a council judge.

- **`--tools ""` would have been silently dropped on Windows.** Under `shell:true` (required for `.cmd` shims) Node joins args with spaces and does not escape them, so an empty element vanishes and `--tools` would swallow the next flag; an arg containing whitespace is split into several. Verified on Node 24. `runCli` now quotes whitespace-bearing args, passes `""` for an intended empty, and refuses args containing cmd.exe metacharacters (`" & | < > ^ % !`) — nothing legitimate needs them, and an image path that has one is better rejected than spliced into a command line. Codex's `-c model_reasoning_effort="high"` was the one arg that carried a quote; it is now passed unquoted (a bare word is not valid TOML, so codex takes it as a raw string — verified).

- **`consult_chat_end` for codex left a dangling state-DB row.** Codex 0.15x keeps sessions in a SQLite state DB as well as the rollout file; deleting only the file made `codex doctor` report "state DB rows point at missing rollout files". Now uses `codex delete --force <uuid>` (removes both; verified), with the file walk kept as a fallback for CLIs without the subcommand.

- **Codex's standalone installer was invisible to the PATH-less resolver.** Codex 0.15x installs to `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` (not npm). Added to `knownLocations` in both the server and the SessionStart hook.

- README contained three literal control characters (BEL/BS) where `\a`/`\b` in a path had been interpreted. Repaired.

### Changed

- **Claude council participant runs stripped: ~9x cheaper.** The default (subscription/OAuth) path loaded the full Claude Code environment — CLAUDE.md, plugins, hooks and *every configured MCP server, including consult itself*, spawned per call — and wrote a session to disk. It now passes `--safe-mode --tools "" --strict-mcp-config --no-session-persistence --disable-slash-commands`. Measured on Claude Code 2.1.268 with haiku, same one-word answer: 37k → 3.7k tokens, $0.042 → $0.005, 5.3s → 1.2s. `--bare` still requires `ANTHROPIC_API_KEY` (verified: OAuth is never read in bare mode) and gets the same stripped flags.

- **Codex `reasoning_effort` accepts the full API enum**: `minimal | low | medium | high | xhigh | max` (was `low | medium | high`). Which values a model honours is model-dependent — gpt-6-astra (the current CLI default) accepts `low`..`max` and rejects `minimal` with a clear 400 naming its own list, which consult passes through unchanged.

- **One-shot codex asks pass `--ephemeral`** — no rollout file or state-DB row per `ask_codex` call. Chat sessions still persist (they must).

- **`agy_mode` is accepted but ignored.** `--mode plan` is implemented as slash-command expansion, so it is a no-op alongside `--disable-slash-commands` (agy prints a warning saying so), and it never prevented writes. The setting still validates so old config files load; consult prints one stderr warning if it is set. The plan-stub guard stays as a cheap check.

- **MCP tool annotations.** Every tool now carries `title` and `annotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) per the 2025-03-26+ spec: asks and status probes are read-only, chat start/send write a session, `consult_chat_end` is destructive, `codex_login_start` is open-world. Clients that auto-approve on these hints now get accurate signals.

- agy result carries `denied_actions` (names of auto-denied tools, agy ≥ 1.1.27) when an answer was produced despite a refusal; the empty-response error names them too.

### Verified unchanged

- Codex `--json` event shapes (`thread.started`, `item.completed`/`agent_message`, `turn.failed`) on 0.154.0. Resume now also emits `thread.started`; harmless.
- Gemini CLI (0.54.4, 0.59.0 available) still fails with `IneligibleTierError` on an individual account; remains opt-in.
- `agy --json-schema` works (`structured_output` field) — still a v0.7.x target, not wired up.
- Ollama is no longer installed on the development machine and LM Studio's server was not running, so the local provider was validated by unit tests only this release.

### Tests

197 unit assertions (was 158): partial-output detection, `denied_actions` shaping, the effort enum, the Claude flag contract, `shellSafeArgs` quoting/rejection, and `agyWritePosture` levels against synthetic settings files. Live-validated through the MCP server: `/`-prefixed agy prompt, agy write refusal with the preamble, codex `xhigh` and `minimal`, codex chat start → `codex delete`, tool annotations on the wire.

## [0.6.1] - 2026-08-11

Two field-reported bugs in the v0.5/v0.6 agy work, both found by using it rather than by testing it.

### Fixed

- **`agy` was unreachable whenever PATH lookup failed, which on Windows is the normal state right after installing it.** The installer edits the user PATH *registry*; Windows broadcasts `WM_SETTINGCHANGE`, but console processes ignore it. A terminal keeps the environment it captured at launch and hands that stale copy to every child — so Claude Code, and therefore the MCP server, stayed blind to `agy` even across a Claude Code restart. My v0.5 advice ("restart Claude Code") was wrong: only a **new terminal** propagates it.

  `resolveCmd` now falls back to canonical install locations when `where` finds nothing — `%LOCALAPPDATA%\agy\bin\agy.exe` for agy, `%APPDATA%\npm\<name>.cmd` for the npm-installed CLIs, plus the usual POSIX prefixes. PATH is no longer required for any provider. The SessionStart hook's inlined copy of the resolver got the same treatment, and its warning text now says "open a NEW terminal" instead of the incomplete advice.

- **`agy_mode: plan` was the wrong default and is no longer set.** It was chosen to mirror codex's read-only sandbox, on the assumption that "plan" meant read-only. It does not — it is a planning *workflow*. Measured against agy 1.1.11 with `"Reply with exactly: PONG"`:

  | mode | result |
  |---|---|
  | `--mode plan` | **2 of 3 runs** returned *"I have created the implementation plan … click Proceed to approve it"* instead of an answer — and wrote a `plan_*.md` file |
  | *(no `--mode`)* | **4 of 4 runs** answered correctly; a direct request to overwrite a file was refused, file untouched |

  So plan mode was simultaneously less reliable *and* less read-only than the default. `--mode` is now omitted unless explicitly configured; `plan` and `accept-edits` remain valid values.

- **An empty agy response was returned as a successful empty answer.** agy replies `status: SUCCESS` with `response: ""` when it silently declines an action it lacks permission for. That now raises an error explaining agy answers questions but will not act headlessly.

- **A plan-approval stub is now detected and raised** rather than passed back as the model's answer, for anyone who sets `agy_mode: plan` deliberately. Exposed as `isPlanStub()` so it is unit-testable — agy only emits the stub about a third of the time, which makes a live test flaky in both directions.

### Changed

- Default `agy_mode` is now unset (was `plan`). The settings enum accepts `null` explicitly.

150 -> **158 offline assertions**.

## [0.6.0] - 2026-08-10

Vision. `ask_codex`, `ask_agy`, `ask_local`, and `council_vote` accept an `images` array of file paths.

### Added

- **`images` parameter on the three vision-capable providers and the council.** Each uses a genuinely different transport, discovered by probing the CLIs rather than assuming:
  - **codex** — native `-i <file>` flag, repeated per image. Bytes never enter this process.
  - **agy** — has *no* image flag, but opens images off disk itself when the absolute path appears in the prompt. Verified against agy 1.1.11: one turn, and no `--add-dir` needed even for paths outside the cwd.
  - **local** — OpenAI `image_url` content parts with base64 data URIs. The only provider where image bytes transit the MCP server.
- **`mcp/lib/image.js`** — signature-based format detection (PNG/JPEG/GIF/WebP), header-only dimension parsing for all four, and a **dependency-free PNG decoder, box-filter downscaler, and re-encoder** built on the standard-library `zlib`.
- **Automatic PNG downscaling for `ask_local`,** governed by the new `local_image_max_edge` setting (default 1024). Measured on Ollama 0.30.7 + qwen3.5:9b, identical image and identical one-word answer: **3000x2000 costs 4084 prompt tokens, 1024x683 costs 700, 96x96 costs 37.** Ollama tiles images rather than charging a flat rate, so cost tracks pixel count directly. What was resized is reported back in `image_warnings`.
- **`local_image_max_edge` setting.**

### Changed

- **A council given `images` now fails fast if any participant cannot see them.** `claude` and the legacy `gemini` have no image path, so they would have answered text-only and then been ranked against candidates that saw the picture — a skewed tournament that looks perfectly normal in the output. The error names the working subset (`codex`, `agy`, `local`) so the fix is a copy-paste. Exported as `VISION_PARTICIPANTS`.
- **Images attach to the council's generation round only.** Judges rank candidate text and never look at the image, so sending it to every judge would multiply cost for a round that cannot use it.

### Fixed

- **`decodePng` crashed the server on a truncated PNG.** The PNG signature is only 8 bytes, so a corrupt 9-byte file passed detection and then threw `ERR_OUT_OF_RANGE` from `readUInt32BE(16)`. Callers expect `null` ("cannot resize"), never an exception. Found by a unit test, not in production.
- **JPEG dimension parsing missed markers near the end of the buffer** — the scan bound was one byte too conservative for the widest read in the loop.
- **`jpegSize` returned `{height, width}`** while the other three parsers returned `{width, height}`, so shapes could not be compared uniformly.

### Notes

- **Only PNG can be downscaled.** JPEG/GIF/WebP need a real codec, which would mean adding an image dependency to a server that has exactly one. Oversized images in those formats are sent at full size **with a warning** that names the cost and the fix. Screenshots — the dominant case for a coding tool — are PNG.
- **Use a 9B+ local model for vision.** qwen3.5:4b described a blue square on a yellow background as *"Three square frames divided a solid blue background"*; 9b was exact. Same plumbing, so this is a model-size cliff, not a bug.
- Coverage 118 -> **150 offline assertions**, adding format detection, dimension parsing per format, PNG resize round-trips, and corrupt-input guards.

## [0.5.0] - 2026-08-09

Antigravity (`agy`) replaces the legacy Gemini CLI as the default Google-side provider.

**Why:** Google withdrew Gemini CLI free-tier access for individual accounts (`IneligibleTierError` / `UNSUPPORTED_CLIENT`, "migrate to the Antigravity suite"). A default council containing `gemini` now fails for most users, so the default lineup had to change.

### Added

- **Antigravity provider (`mcp/lib/agy.js`).** Two new tools — tool count 11 → 13:
  - **`ask_agy`** — single-shot prompt. Now the default Google-side provider.
  - **`agy_status`** — auth check + model inventory. No inference, so no tokens.
- **Full chat parity for `agy`.** `consult_chat_start` / `_send` / `_end` accept `participant: "agy"`, relaying agy's own `conversation_id` — the same pattern used for codex and gemini.
- **`agy` in the council defaults.** `DEFAULT_PARTICIPANTS` is now `["claude","codex","agy"]`.
- **`/consult:agy` slash command** with `--model` and `--effort` flags.
- **New settings:** `agy_model`, `agy_effort`, `agy_mode` (default `plan`, read-only), `agy_timeout_ms`.
- **`agy` fronts non-Google models too** — `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium` alongside the Gemini family. Tool descriptions point at `agy_status` rather than encouraging guesses, since ids encode an effort suffix.

### Changed

- **BREAKING (defaults): `gemini` is no longer a council participant by default.** It remains fully supported as an opt-in via `participants: [... , "gemini"]`, for users with a paid `GEMINI_API_KEY`. `ask_gemini`, `gemini_auth_status`, and `/consult:gemini` are all still present and unchanged in behaviour — only their default/priority status moved. Tool descriptions, the skill, and the command now steer to `agy` and tell the model not to silently substitute one for the other.
- **SessionStart hook checks `agy` instead of `gemini`.** Warning about a provider that is no longer a default was pure noise.
- **`ensureCmd` install hints cover all four CLIs** and mention the restart requirement.

### Fixed

- **Missing-binary detection never fired on Windows.** The hook treated only exit 127 as "not on PATH", but with `shell:true` on Windows `cmd.exe` returns **9009** ("is not recognized as an internal or external command") and no spawn `error` event — so the hint never appeared on the one platform where the "installer updated PATH but this process can't see it" case actually bites. Now matches 127, 9009, and the message text.

### Internal

- **`extractJson` moved to `util.js`** and is shared by the gemini and agy providers instead of being duplicated.
- **`removeTree` helper** added for providers that store per-conversation state as a directory. `agy` keeps ~600KB+ per conversation (`conversations/<id>.db` + `-shm` + `-wal`, plus a `brain/<id>/` tree); `agyChatEnd` removes all of it.
- **`ALL_PARTICIPANTS` / `DEFAULT_PARTICIPANTS` are exported** so tests assert against the real values rather than a copy.
- Coverage 88 → **118 offline assertions**, adding `extractJson` edge cases (braces inside strings, escaped quotes, unbalanced input), agy validators, agy settings, and a guard on the council participant policy itself.

### Notes

- **Prompts go to `agy` via stdin, not argv.** Measured: `agy -p "<prompt>"` works but puts the prompt on the command line; `agy -p "" < stdin` fails with "empty prompt"; **omitting `-p` and piping stdin works**. The third form is used, so large inlined files can't hit the Windows ~32k argv limit.
- **`agy` carries a large built-in system prompt** — ~31k input tokens even for a one-word question. Fast in wall-clock, not cheap in tokens.

### v0.5 targets (superseded — see v0.6 above)

- Vision / image input for codex and gemini.
- Gemini grounded search with citations.
- Optional structured JSON output (response-schema arg).
- Token / cost telemetry surfaced from the CLIs' own usage stats (`ask_local` already reports exact counts).
- Multi-turn chat for local models — requires the MCP server to own conversation history on disk, since local HTTP endpoints have no session store to relay.
- (Stretch) streaming via MCP progress notifications, `@path` file-attachment passthrough, `consult_compare` tool, opt-in local LRU cache.

## [0.4.0] - 2026-08-08

Local model support, plus a cleanup pass over the whole plugin.

### Added

- **Local model provider (`mcp/lib/local.js`).** Two new tools bring the tool count to 11:
  - **`ask_local`** — single-shot prompt against a local model. Free, private, no tokens spent.
  - **`local_status`** — reachability check + model inventory. Free and instant; the local analogue of `codex_login_status` / `gemini_auth_status`.

  Speaks the OpenAI-compatible `/v1/chat/completions` API rather than wrapping a CLI, so one client covers **Ollama** (default, `:11434/v1`), **LM Studio** (`:1234/v1`), **llama.cpp / llama-server** (`:8080/v1`), **vLLM** (`:8000/v1`), and any remote OpenAI-compatible endpoint. This is the only provider that spawns no subprocess.
- **`local` as an opt-in council participant.** Never a default — `participants` must name it explicitly, so existing council calls are unchanged. Enables a free 4th voice, or a near-free 2-way tournament. `councilVote` now fails fast if `local` is requested without `local_model` configured, rather than dying mid-tournament after paid calls have already been made.
- **Reasoning-model handling.** Chain-of-thought is stripped from responses across all three runner dialects: Ollama's `reasoning` field, vLLM/DeepSeek's `reasoning_content`, and inline `<think>` / `<thinking>` / `<reasoning>` blocks (LM Studio, llama.cpp). An unclosed opener — generation cut off mid-thought — drops the remainder rather than leaking partial reasoning as the answer.
- **`local_reasoning_effort` setting.** Measured on Ollama 0.30.7 + qwen3.5:2b answering *"what is 2+2, one word"*: omitted → ~2578 completion tokens / ~16s and sometimes no answer at all; `none` → **2 tokens / <1s**; `low` → 4076 tokens and an *empty* answer. Ollama honours `reasoning_effort` but silently ignores `think:false` and `chat_template_kwargs`, so that is the parameter used.
- **New settings:** `local_base_url`, `local_model`, `local_api_key`, `local_temperature`, `local_reasoning_effort`, `local_timeout_ms`.
- **`/consult:local` slash command** — one-shot passthrough with `--model` and `--think` / `--no-think` flags, matching the existing per-provider commands. Documents tighter file-inlining limits than the cloud commands, since local context windows are typically 4k–32k rather than 200k+.
- **`mcp/local-test.js`** — end-to-end integration test that costs nothing (inference is local), so it can run on every change. Skips cleanly with exit 0 when no runner is listening.
- **npm scripts** (`test`, `test:local`, `test:live`, `test:chat`, `test:chat-end`, `test:council`) separating free tests from paid ones.

### Security

- **Prompt-exfiltration guard for local endpoints.** `local_base_url` names a network destination, so it is deliberately **not** a tool argument — only config sets it, which means a prompt injection cannot redirect prompts to an attacker's host. Additionally, a *project-scoped* config setting it to a non-loopback address now prints a warning at load, mirroring the existing `codex_sandbox: danger-full-access` warning. An untrusted repo's checked-in config could otherwise ship every prompt off-box silently.
- **`codex_login_start` no longer leaks unscrubbed CLI output.** `raw_preview` returned raw stdout/stderr without `scrubPii`, unlike every other surfaced error path.

### Fixed

- **Gemini failures were misdiagnosed as `unknown`.** `classifyError` sliced the error message from the *front*, but gemini-cli's stderr opens with a truecolor warning — so the real cause was cut off and every failure fell through to the generic bucket. Details are now taken from the tail, where CLI errors actually live.
- **Added `ineligible_tier` detection.** Google has withdrawn Gemini CLI free-tier access for individual accounts (`IneligibleTierError` / `UNSUPPORTED_CLIENT`). It presents as an auth error, so the old code advised re-authenticating — advice that cannot possibly work. It is now classified first, flagged `fatal: true`, and carries a hint pointing at the two real options (paid `GEMINI_API_KEY`, or drop the gemini participant). Also added `rate_limited` classification. `gemini_auth_status` no longer overwrites the reason-specific hint with the generic "run gemini interactively" message.
- **Codex failure events were being discarded.** `parseCodexJsonl` ignored `{"type":"error"}` and `{"type":"turn.failed"}`, so an expired token surfaced as the generic *"returned no agent_message"* plus 2KB of log tail instead of the one-line reason the CLI already provides. Failures are now parsed and reported directly, with a re-auth hint when the message looks token-related.
- **Float settings were silently dropped.** The frontmatter parser only recognised integers, so `local_temperature: 0.7` parsed as a string and got discarded by `sanitize`.

### Changed

- **Dead "explore mode" plumbing removed.** The `cwd` parameter threaded through `askCodex` → `runCli`, and `util.js`'s `validateDirectory`, supported tools that were never built. Also removed an unused `validateDirectory` import in `gemini.js`.
- **`@modelcontextprotocol/sdk` 1.29.0 → 1.30.0**, plus `npm audit fix` on the transitive dependency tree (`hono`, `body-parser`, `fast-uri` — all belonging to the SDK's HTTP transports, which this stdio-only server never loads). 0 vulnerabilities remaining. The low-level `Server` API is retained deliberately: migrating to `McpServer`/`registerTool` would be churn on working code for little gain at this tool count.
- **Node 18 dropped** (EOL April 2025). `engines` is now `>=20`; the CI matrix moves to 20/22/24. The local provider relies on `fetch` and `AbortSignal.timeout`.
- **`test-helpers.js` resolves the server path relative to itself** instead of the caller's cwd, so tests work from both the repo root and `mcp/`.
- **`live-tests.yml` is honest about its requirements.** It targeted `ubuntu-latest`, where the unauthenticated CLIs guarantee failure. It now takes a `runner_label` input defaulting to `self-hosted` and pre-flights for CLI presence and codex auth, failing fast with an actionable message instead of timing out test by test.

### Testing

- **Unit tests no longer test copies of the code.** The council tie-break assertions re-implemented `tiedAtTop` inline, so the real function could break with tests still green; the settings test admitted in its own comment that it wasn't testing what it intended. `bordaScores`, `tiedAtTop`, and `parseRanking` are now exported from `council.js` and imported by the tests, `councilVote` calls the same extracted functions, and settings coverage drives the real `parseFrontmatter` / `sanitize` / project-scoped `loadSettings` paths. Verified by mutation: breaking `tiedAtTop` now fails 3 assertions.
- Coverage grew from ~20 to **88 offline assertions**, adding the local provider's reasoning stripping, message extraction across runner dialects, base-URL guards, settings validation, and gemini error classification.
- **Verified live against the installed CLIs**, not just in theory: codex 0.137.0's `thread.started` / `item.completed` / `agent_message` events (chat start → send → end, with continuity confirmed), and a 2-way `["codex","local"]` council in which qwen3.5:9b produced a valid strict-format ranking and placed codex above itself.

### Repository

- **`git init`.** The repo had `.github/workflows`, a CHANGELOG, and a CONTRIBUTING guide but no git history at all.

## [0.3.4] - 2026-05-24

### Changed

- **Inlined file blocks now carry line numbers.** Format: `<right-padded number> | <line content>`, width matched to the last line being emitted, ` | ` separator. Numbers reflect SOURCE file lines (so sending `:10-50` starts at 10, not 1). Skipped for files < 20 lines (avoids noise). This lets the consulted model say "line 42 has a race condition" instead of describing locations vaguely. Convention applied across `commands/codex.md`, `commands/gemini.md`, `commands/chat.md`, `commands/council.md`, `skills/second-opinion/SKILL.md`, and the canonical `skills/second-opinion/references/file-handling.md` (full algorithm + edge cases + updated examples).
- No code or schema changes; behaviour is identical from the MCP server's perspective — the change is in the orchestrator-side instructions for how Claude builds the prompt body before calling `ask_codex` / `ask_gemini` / `consult_chat_*` / `council_vote`.

## [0.3.3] - 2026-05-24

Second hardening pass driven by a 4-way parallel review (code-reviewer agent + code-simplifier agent + Codex + Gemini). False-positive findings (Codex hallucinated missing imports; Gemini misread `--prompt=` as argv-injection and claimed a missing `clearTimeout`) were filtered out before applying anything.

### Fixed

- **`codex chat_end` substring match** could delete unrelated session files when a partial session_id was passed. Now anchored to the filename suffix `-<full session_id>.jsonl`, matching the precision `gemini chat_end` already had.
- **`claude.js` error paths leaked raw stdout** without `scrubPii`. All three throws (JSON parse failure, `is_error`, missing `.result`) now scrub before surfacing.
- **`spawn-cli.js` buffer-cap gate** was per-stream — capping stdout didn't stop stderr from accumulating between the kill signal and process death. A single `bufferOverflow` flag now gates `onChunk` for both streams.
- **`hooks/scripts/auth-check.js`** could keep a zombie Node process alive by holding stdin referenced. Added `process.stdin.unref()` after the drain so the hook exits promptly once `main()` returns.
- **`gemini.js extractJson`** ran on `stdout + stderr` combined, so a stderr-emitted JSON-shaped warning before stdout's real payload could hijack the parse. Tries `stdout` first; falls back to combined only when stdout has no `{`.

### Performance

- **`consult.js appendLog`** switched from sync `appendFileSync` / `mkdirSync` to async `appendFile` / `mkdir`. Concurrent tool calls with `log_calls: true` no longer serialise the event loop on disk I/O.

### Internal

- **Dead `model` parameter** removed from `codexChatSend` and `geminiChatSend`. The MCP schema for `consult_chat_send` never exposed it (chat-send inherits the model from the session that `chat_start` created), so the lib-side `model` arg, its `validateModel` call, and the `-m` push were unreachable code.
- **`mcp/package.json`**: added `"license": "MIT"` and `"engines": { "node": ">=18" }`; pinned `@modelcontextprotocol/sdk` from `^1.0.0` to `^1.29.0` (the version actually installed and tested).
- **`LICENSE`** (MIT) and **`CONTRIBUTING.md`** added.
- **GitHub Actions workflows** added: `.github/workflows/ci.yml` runs smoke + unit on every push/PR across Ubuntu + Windows, Node 18/20/22 (no token cost). `.github/workflows/live-tests.yml` is a manual `workflow_dispatch` for the paid suites (live, chat, chat-end, council); skeleton-only until codex/gemini headless CI auth is provisioned.

## [0.3.2] - 2026-05-24

Documentation accuracy and test-harness deduplication. No runtime behaviour changes.

### Changed

- `README.md` Borda explanation now describes the general `N-1` formula (was N=3 only); roadmap section restructured to reflect the v0.4 plan, the v0.5 stretch items, and the v1.0 visual-council north star.
- `commands/council.md` shape example now includes `tied_at_top`; tied-output formatting instructs Claude to show only the tied candidates instead of all three.
- `mcp/package.json` description mentions all three CLIs and the council tournament (was Codex+Gemini only).
- `mcp/test-helpers.js` extracted: `startServer`, `unpack`, `handshake`. Smoke, live, chat, chat-end, and council tests now ~30 lines lighter each.

### Added

- `CHANGELOG.md` (this file).

## [0.3.1] - 2026-05-24

Bug-fix and hardening pass. No new features; no breaking changes.

### Fixed

- **Council shuffle**: replaced `randomBytes(1)[0] % n` with `crypto.randomInt` to remove modulo bias when assigning anonymized A/B/C labels.
- **3-way tie surfacing**: `council_vote` now returns `tied_at_top: string[]` listing every label sharing the top Borda score. Previously a 3-way tie was indistinguishable from a 2-way tie in the response.
- **Gemini `chat_end` collision safety**: matching on the 8-hex session shortId is now a candidate filter only; the file head (64 KiB) is read and the full UUID must appear before unlinking. Protects against birthday collisions at scale.
- **Settings cache**: `loadSettings` now caches by `(path, mtimeMs)` and falls through cleanly when a higher-priority `cwd` config is created or deleted between calls. Previously every MCP dispatch re-read the file.
- **PII scrub on errors**: `scrubPii` redacts `sk-`, `sk-proj-`, `sk-ant-`, `AIza`, `ghp_`, `Bearer`/`Token <jwt>`, `api_key=...`, and the home-directory path from any error message that embeds raw CLI stderr/stdout before it reaches MCP clients. Defence-in-depth — raw streams remain on the error object for internal diagnostics.

### Security

- **Project-scoped privilege-escalation warning**: emits a one-time stderr warning per mtime when `.claude/consult.local.md` in a project's cwd sets `codex_sandbox: danger-full-access`. Behavior is unchanged (warning, not block) so existing project configs keep working.

### Internal

- New `mcp/lib/util.js` helpers: `readHead`, `scrubPii`, and a `verify(fullPath)` callback option on `walkAndDelete`.
- `mcp/unit-test.js` offline test harness covering scrubPii patterns, readHead, walkAndDelete-with-verify, tied_at_top math, and settings caching (21 checks).

## [0.3.0] - prior

Multi-turn chat (`consult_chat_start` / `consult_chat_send` / `consult_chat_end`) for codex and gemini. Centralized subprocess runner (`mcp/lib/spawn-cli.js`) with EPIPE safety, 8 MiB per-stream buffer cap, and Windows tree-kill via `taskkill /T /F`. Validators hoisted to `mcp/lib/util.js`.

## [0.2.x] - prior

Council tournament (`council_vote`) with anonymized A/B/C labels, Borda-count aggregation, and graceful degradation when one model fails.

## [0.1.0] - prior

Initial release: `ask_codex`, `ask_gemini`, `codex_login_status`, `codex_login_start`, `gemini_auth_status`. Slash commands and second-opinion skill.
