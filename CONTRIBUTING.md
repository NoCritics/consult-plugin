# Contributing to consult

Thanks for considering a contribution. This is a small plugin with a small surface — bug reports, focused fixes, and well-scoped features are all welcome.

## Repository layout

See [File layout](./README.md#file-layout) in the README. `mcp/` is both the Claude Code MCP server and the Claude Desktop extension (`mcp/manifest.json`).

## Setup

`npm install` brings in the MCP SDK and esbuild. Only the tests and the vendor build use them: the plugin itself runs without `node_modules`.

```bash
cd mcp
npm install
node smoke-test.js        # initialise + tools/list + codex_login_status (no LLM cost)
node unit-test.js         # offline assertions on lib helpers (no LLM cost)
```

The band, pane and health line (the function-hooks module in `hooks/`) have their own tests in `tests/`, run from the plugin's folder:

```bash
claude plugin test .
claude plugin validate .
```

To try them live, start Claude Code with `claude --plugin-dir <your clone>`: that copy overrides the installed consult for the session.

The `live-test.js`, `chat-test.js`, `chat-end-test.js`, `council-test.js` and `image-test.js` scripts call the real CLIs and spend tokens, so run them deliberately (codex and agy must be signed in). There is no CI; `npm test` is the gate before every release.

## Design constraints (please read before editing)

The plugin runs on Windows + POSIX. Several patterns look unusual but are deliberate — don't "fix" them without understanding why:

- **`shell: true` on Windows in `mcp/lib/resolve-cmd.js`.** Required to launch `.cmd` shims. Node 18.20+ refuses to spawn `.cmd` directly without it (CVE-2024-27980). The DEP0190 suppression in `mcp/consult.js` is the consequence.
- **`mcp/lib/spawn-cli.js` `runCli` is the only subprocess entry point.** It owns EPIPE safety, the 8 MiB per-stream buffer cap, Windows tree-kill via `taskkill /T /F`, and PII scrubbing on error messages. New subprocess work should go through it.
- **`mcp/lib/util.js` validators are mandatory** for any path that takes `model`, `session_id`, or `reasoning_effort`. They close the argv-injection surface created by `shell: true`.
- **`mcp/lib/util.js` `scrubPii`** wraps every error string that embeds raw CLI stdout/stderr before it crosses the MCP boundary. New error paths embedding raw output must do the same.
- **`codexLoginStart` is bespoke** (not via `runCli`) because the lifecycle is genuinely different — it resolves mid-stream when the verification URL appears and unrefs the child.
- **`hooks/scripts/auth-check.js` imports `mcp/lib/resolve-cmd.js` and `mcp/lib/settings.js`** rather than copying them. Keep those two modules -- and everything they import -- free of npm dependencies (no `@modelcontextprotocol/sdk`), so the hook stays fast and never depends on `node_modules`.
- **Arguments go through `shellSafeArgs`** (in `runCli`). Under `shell: true` Node joins argv with spaces unescaped: whitespace splits an arg, `''` vanishes (use `EMPTY_ARG`), and cmd.exe metacharacters are refused. Prompts always travel via stdin, never argv.
- **Codex `exec resume` does NOT accept `-s` or `--color`.** Both are inherited from the original session. Adding them silently breaks chat-send.
- **Gemini uses `--prompt=` (empty attached form), not `-p ""`.** The latter collapses to a single empty token under cmd.exe `shell:true` on Windows.
- **The function-hooks module (`hooks/register.tsx`, `hooks/mod/`, `hooks/ui/`) runs with no Node and no DOM.** Files, processes, time and settings go through `$`. The engine refuses a module that passes `$` to anything but a function declared at the top of the same file or imported, that hooks `session.start` twice without a matcher, or that reads or writes `$.state` through an atom created in another file: each file declares the atoms it uses (`hooks/mod/state.ts` holds only their initial values).
- **The `tool.call` hook never changes what Claude receives, except on Cancel,** and its `.catch` passes the call on. Keep it that way: consult must behave as if the module were absent when the module fails.
- **Only `mcp/consult.js` imports the MCP SDK, and only from `mcp/vendor/mcp-sdk.js`.** A bare `@modelcontextprotocol/sdk` import works in a clone with `node_modules` and fails in every install.
- **`mcp/lib/defaults.json` is shared.** The server reads it through `defaults.js`; the module reads it with `$.fs`. Change a default there, not in `settings.js`.

## Making a change

1. **Keep changes focused**, and don't change a public MCP tool schema without a minor-version bump.
2. **Run `npm test`** (in `mcp/`) and, if you touched `hooks/`, `claude plugin test .` and `claude plugin validate .`. If you touched a provider, chat or council path, also run the matching paid test.
3. **Add a CHANGELOG entry** for the release, and bump the version in `.claude-plugin/plugin.json`, `mcp/package.json` AND `mcp/manifest.json` (the Desktop extension) -- a unit test fails if they differ -- then `npm install --package-lock-only`. If the tool list changed, update `tools` in `mcp/manifest.json` too (the smoke test checks it).
4. **Try it in Claude Code** with `claude --plugin-dir <your clone>`. An installed copy of consult does not change when you edit a clone: Claude Code runs the copy it made at install time. For Claude Desktop, reinstall the extension (README, *Claude Desktop*).

## Updating the bundled SDK

The server's only npm dependency, `@modelcontextprotocol/sdk`, is bundled into `mcp/vendor/mcp-sdk.js` so an install needs no `node_modules`. After changing the SDK version in `mcp/package.json`:

```bash
cd mcp
npm install
npm run build:vendor      # rewrites vendor/mcp-sdk.js and vendor/THIRD_PARTY_LICENSES.md
npm test                  # fails if the bundle wasn't rebuilt from the locked SDK
```

Commit the two files in `vendor/` with the change. Don't edit them by hand.

## Reporting bugs

Include:
- Plugin version (`.claude-plugin/plugin.json`)
- Node version (`node --version`)
- OS + shell
- The MCP tool you called and the arguments
- The full error message (`scrubPii` already redacts secrets — the message is safe to paste)
- A minimal repro if you can

## Code style

- ESM modules, Node ≥ 20.
- No build step for consult's own code: the source is what runs. The one generated file is `mcp/vendor/mcp-sdk.js` (see *Updating the bundled SDK*).
- Comments explain WHY, not WHAT. Don't add a comment if the code already reads cleanly.
- Don't add lint configs / prettier / TypeScript. The plugin is small enough that house style is enforced by reviewers, not tooling.

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see [LICENSE](./LICENSE)).
