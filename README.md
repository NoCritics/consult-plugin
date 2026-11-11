# consult

Ask other AI models from Claude Code or Claude Desktop: Codex, Antigravity (`agy`), local models (llama-swap, Ollama, LM Studio, llama-server or any OpenAI-compatible server) and the legacy Gemini CLI.

- Questions and multi-turn chats, with images.
- A council: several models answer, then rank each other's answers.
- Image generation with agy or with GPT through Codex.
- Background tasks for Codex, agy or a local model while you keep working (Claude Code only).

## Install

Needs Node.js 20 or newer. In Claude Code:

```
/plugin marketplace add NoCritics/consult-plugin
/plugin install consult@nocritics
```

Restart Claude Code. There is nothing to `npm install`.

Then set up the providers you want. Each one is optional; a tool whose provider is missing tells you what to do.

| Provider | Setup | Used by |
|---|---|---|
| Codex | install the `codex` CLI, run `codex login` | questions, chats, council, GPT images, background tasks |
| Antigravity | install `agy` from [antigravity.google](https://antigravity.google), run `agy` once to sign in | questions, chats, council, images, background tasks |
| Local model | a running runner, then `/consult:setlocal` | questions, council, background tasks (these also need the `pi` CLI) |
| Claude | the `claude` CLI | council |
| Gemini CLI (legacy) | the `gemini` CLI and a paid `GEMINI_API_KEY`; the free tier no longer works | `ask_gemini` |

Installing agy on Windows:

```
curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd
```

consult finds agy in its install folder even before your PATH picks it up.

## Use

Ask in plain words, or use a slash command.

| To | Say or type |
|---|---|
| Get a second opinion | "Get a second opinion on this approach" |
| Ask one model | "Ask codex why …", or `/consult:codex`, `/consult:agy`, `/consult:local`, `/consult:gemini` |
| Include files | "Ask codex about src/utils.py". Claude puts the file in the prompt, since the other model can't read your disk. |
| Show an image | "Ask codex what's wrong with C:\shots\err.png" |
| Chat | "Start a chat with codex about …", then keep replying, or `/consult:chat` |
| Run a council | "Run the council on this", or `/consult:council` |
| Make an image | "Make an image of a lighthouse at dusk". Say "with GPT" for Codex. |
| Hand off a task | `/consult:delegate codex <task>` |
| Check status | "Is codex signed in?", "Is my local runner up?" (free) |

**Time limits.** The default is 3 minutes, and at least 10 for Codex. Any call can set its own limit from 30 seconds to 30 minutes: say "give codex 20 minutes", or add `--timeout 20m` to a slash command. A call that runs out returns what arrived so far, marked `INCOMPLETE:`.

## In Claude Code

- **The band.** While a call runs, a row above the prompt shows what kind of call it is (`ask`, `chat`, `image`, `council`), the model, a bar against its time limit, and **Cancel**, which stops that call only. A background task gets a `delegate` row for as long as it runs, with its time against the task's limit and a Cancel of its own (a task whose fence is lifted leads with `unfenced`); with only tasks shown, the band's button opens the Delegated tab. A row that ends while others still run stays as its result line (the three newest; older ones fold into one line); when the last one ends, one short row says how it went. Either stays until your next prompt. The rows fit a band narrowed by the `/consult` pane.
- **The `/consult` pane** has three tabs:
  - **Answers:** this session's and earlier sessions' answers (the last 50), with copy buttons. Image entries can be opened, shown in their folder or copied as a path. kitty and Ghostty display PNGs in the pane.
  - **Local models:** choose the runner and a model for each nickname. Shows the settings change before you save.
  - **Delegated:** your background tasks, with Cancel, Clear, Discard, their reports and logs.
- **The status line** checks your providers when a session starts, e.g. `codex ✓ agy ✓ local –`.
- **Notifications:** a toast when a call ends, and a push notification for calls that take 2 minutes or more.

## Local models

`/consult:setlocal` finds the runner on this machine and proposes a model for each nickname: `default`, `fast`, `vision`, `vision-best` and `big`. It shows you the change and writes only what you confirm.

- **llama-swap:** uses its own aliases. Give its address once if it isn't on port 9292 or 8080.
- **Ollama and LM Studio:** proposes models by size, quantization, vision support and whether they fit your GPU.
- **llama-server and other OpenAI-compatible servers:** model names as they are. Your own server can describe its models by adding a `meta` object to each `/v1/models` entry, e.g. `{"arch": "MoE", "engine": "vLLM", "decode_tps": 40, "vision": true}`. `"chat": false` hides a model, such as an embedding model.

Several runners can be set up, and one is in use: `/consult:setlocal ollama` switches. Use the nicknames anywhere: "ask local fast …", `/consult:local --model big …`.

Runner settings live in `~/.claude/consult.local.md` only; a project's file can't change them. For a key, write the name of the environment variable that holds it (`llama-swap.key_env: LLAMA_SWAP_API_KEY`). consult reads the variable at call time and sends the key only to this machine.

- **Thinking models** can spend the whole call thinking. `/consult:local --no-think` (`reasoning_effort: none`) turns it off. Use it when you see "produced only reasoning".
- **Images** cost tokens per pixel, so consult shrinks PNGs to 1024 px on the long edge (`local_image_max_edge`). Use a model of 9B parameters or more for images.
- **Slow models:** every llama-swap call, and any Ollama model that doesn't fit your GPU, gets at least 20 minutes.

## Background tasks

`/consult:delegate <worker> <task>` hands work to Codex, agy or a local model. It runs in the background. When it ends, Claude is woken up, reviews the result and merges it. Claude Code only.

- **Workers:** `codex`, `agy`, `local` or `local:<nickname>`; `gpt`, `gemini` and `qwen` work too. With no worker named, Claude picks one by the kind of task and tells you which:
  - code goes to Codex;
  - research and reviews go to agy;
  - private work goes to a local model.

  Change these in the Delegated tab's settings.
- **Fencing:** each project has a fence per worker, set in the Delegated tab's settings. All three workers have a real fence by default. Codex: its own sandbox (`fenced`, or `full access`, where write tasks can change any file and run any command on this PC; read tasks still change nothing, but may read anywhere). A fenced Codex write task in a folder that holds consult's own files is refused, as for agy below. agy: `fenced` writes only in the task's folder, because consult starts it with `--settings` naming that folder as its one trusted workspace (a read task trusts none); this depends on agy honouring `--settings`, so an agy update could change it. A fenced agy write task in a folder that holds consult's own files (its task data, `~/.claude/consult-projects.json`, the sandbox-check file or the plugin itself, as with a task in your home folder) is refused: run it in a project folder, or lift agy's fence for that project. The local worker (pi): `fenced` runs pi inside Codex's sandbox, so it can write only in the task's folder (the shared temp folder is not writable to it); Codex can be installed just for its sandbox, and it needs no sign-in. consult runs a self-test per Codex version before it trusts the sandbox (a pass is kept; a failure is retried after an hour; an inconclusive check runs again next task). If Codex is missing, is inside the project, or fails that self-test, or the folder is your home folder, a drive root or a folder that holds consult's own files, pi gets the guard only: consult checks its file edits, but commands are not checked, and the task says so. The guard also refuses edits to consult's own files inside the folder. The first `codex sandbox` run on a PC may do a one-time setup; if it can't, local tasks run with consult's guard only. If the sandbox cannot start a task, the task fails; it never falls back silently. Known limits: fenced workers can still read anywhere, agy has network access, and Codex's permission entries stay on work folders, as they already do for Codex tasks. *anywhere* / *full access* lifts a fence; a stored `soft` now reads as `fenced`. Changes a worker makes with a lifted fence don't go through the copy and can't be undone. A task keeps the fence it started with: every run uses the stricter of that and the project's current setting, so lifting a fence never widens a task already started, while putting it back narrows it on the next resume.
- **Copies:** in a git project (git 2.40 or newer, at least one commit), a task that edits files works in a separate copy that includes your uncommitted changes.
  - Claude merges the copy back file by file. A file changed on both sides gets conflict markers.
  - Nothing is committed, and your branch and staged changes are left alone.
  - Files that configure tools (dot-files, `CLAUDE.md`, `AGENTS.md`, lint configs) are saved as `<file>.task` until you approve them.
  - Without git, tasks edit in place. Claude offers once to set git up.
- **Usage limits:** consult reads Codex's usage and asks before starting at 90 % or more. A task that hits a limit pauses and can continue after the reset.
- **Local tasks** never swap out a model another task is using.
- **Stopping:**
  - Tasks stop when Claude Code closes, unless you set them to keep running.
  - Each has a time limit (3 hours by default) and is stopped after 10 minutes with no output.
  - When a task ends, consult stops the processes the worker started. On Windows it also stops a dev server that a task in a copy left running. For a task in your own folder it only warns you, since it can't tell that server from yours.
- **Storage:** task data lives in `~/.claude/consult-delegate/`. consult never commits, stashes or resets in your project.

## Claude Desktop

The server also installs as a Claude Desktop extension, for Chat and Cowork.

- **Install:** download `consult-<version>.mcpb` from the [releases page](https://github.com/NoCritics/consult-plugin/releases), then go to Settings → Extensions → Advanced → *Install extension*. Don't use Customize → Plugins: that adds a second copy to Claude Code.
- **Requirements:** leave *Use built-in Node.js for MCP* on. codex and agy must be installed and signed in.
- **What's included:** Desktop gets 17 tools, but no slash commands, band, pane or background tasks. Ask for a model by name ("ask codex …").
- **Settings** come from `~/.claude/consult.local.md`.
- **Cowork** stops waiting for a tool after 4 minutes, and consult can't change that. For quick answers there, ask for low effort.
- **Updating:** install the new file and start a new chat.

## Images

- **Image tools:** `agy_generate_image` is the default. `codex_generate_image` is used when you name GPT, OpenAI, ChatGPT or Codex, or need a transparent background.
- **Where they're saved:** `consult-images/` in the project, else `~/Pictures/consult-images`, or the folder set in `agy_image_dir` or `codex_image_dir`. Existing files are never overwritten.
- **Options:**
  - aspect ratio;
  - 1–4 images;
  - your prompt word for word;
  - reference images (agy up to 3, Codex up to 5);
  - a transparent background (Codex only).
- **agy:** JPEG at about 1024 px, about a minute per image.
- **Codex:** PNG, about 45 seconds per image. It uses your ChatGPT plan's Codex quota; no API key needed.
- **Reading images:** `ask_codex`, `ask_agy`, `ask_local` and the council take image files (PNG, JPEG, GIF, WebP).

## Council

`/consult:council` has Claude, Codex and agy each answer, then each ranks all the answers without knowing who wrote which. Points are added up (Borda count) and the highest wins.

- If one model fails, the council continues with two. A tie is shown to you to pick.
- Gemini and local models take part only when named: `--participants claude,codex,agy,local`.
- The Claude participant runs without your `CLAUDE.md`, plugins or MCP servers, which keeps it cheap.
- With images, only the answering round sees them, and a council that includes Claude or Gemini refuses them.

## Settings

Optional. They go in `~/.claude/consult.local.md` (global) or `<project>/.claude/consult.local.md`.

- **Which file is used:** the project file when it exists, else the global one.
- **Global-only settings:** runner and background-task settings come from the global file only.
- **Every key:** [examples/consult.local.md](./examples/consult.local.md) lists each one with its default.
- **Mistakes:** `local_status` reports unknown keys and lines it can't read.

## Good to know

- **Antigravity can write files, and consult can't stop it.**
  - agy creates and edits files without asking in any folder listed in its `trustedWorkspaces` (`~/.gemini/antigravity-cli/settings.json`).
  - consult tells it not to and reports what it tried. `agy_status` shows your setting.
  - To block writes, add this to that file:
    ```json
    "permissions": { "deny": ["write_file(**)", "command(**)"] }
    ```
- **Codex:**
  - It is read-only by default (`codex_sandbox`), and a one-off question leaves no saved session.
  - Your `~/.codex/hooks.json` doesn't run on consult calls unless you ask, or set `codex_hooks: true`.
  - `codex_login_status` can report "Logged in" after the sign-in has expired. If calls fail with a token error, run `codex login`.
- **Cost:**
  - Every call uses tokens on its provider, except local models.
  - agy uses about 20,000–29,000 input tokens per call, even for a short question.
- **Cleanup:**
  - Cancelling a call stops the CLI behind it.
  - agy's saved conversation is deleted after a one-off question. A chat keeps its conversation until you end the chat.
- **Long answers:** in Claude Code, an answer over 40,000 bytes is saved in full to `~/.claude/consult-answers/`, which keeps the last 100. Claude gets the first 8,000 characters and the file's path.
- **Remote servers:** no tool takes a server address, so a prompt can't send your prompts elsewhere. consult warns if a project's settings point a local runner at another machine.

## More

- [CHANGELOG.md](./CHANGELOG.md) lists what changed in each version.
- [CONTRIBUTING.md](./CONTRIBUTING.md) covers the tests, the file layout and design notes.
- Tests run on Linux, macOS and Windows for every push.
