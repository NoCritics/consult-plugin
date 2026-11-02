// Shared by tests/settings.test.ts (the mod) and mcp/unit-test.js (the server):
// both frontmatter readers must agree on these consult.local.md texts.
export const SETTINGS_CASES = [
  {
    "name": "plain timeout_ms",
    "text": "---\ntimeout_ms: 600000\n---\n",
    "expect": { "raw": { "timeout_ms": 600000 }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null }
  },
  {
    "name": "trailing comment",
    "text": "---\nnotify_after_s: 30 # half a minute\n---\n",
    "expect": { "raw": { "notify_after_s": 30 }, "notifyAfterS": 30, "historySize": 50, "summaryModel": null }
  },
  {
    "name": "quoted value containing #",
    "text": "---\ncodex_model: \"gpt-6 #2\" # a note\nhistory_size: 20\n---\n",
    "expect": { "raw": { "codex_model": "gpt-6 #2", "history_size": 20 }, "notifyAfterS": 120, "historySize": 20, "summaryModel": null }
  },
  {
    "name": "BOM before the opening fence",
    "text": "﻿---\r\nagy_timeout_ms: 240000\r\nnotify_after_s: 0\r\n---\r\n",
    "expect": { "raw": { "agy_timeout_ms": 240000, "notify_after_s": 0 }, "notifyAfterS": 0, "historySize": 50, "summaryModel": null }
  },
  {
    "name": "negative notify_after_s falls back",
    "text": "---\nnotify_after_s: -5\n---\n",
    "expect": { "raw": { "notify_after_s": -5 }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null }
  },
  {
    "name": "fractional notify_after_s falls back",
    "text": "---\nnotify_after_s: 2.5\n---\n",
    "expect": { "raw": { "notify_after_s": 2.5 }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null }
  },
  {
    "name": "history_size above 200 falls back",
    "text": "---\nhistory_size: 500\n---\n",
    "expect": { "raw": { "history_size": 500 }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null }
  },
  {
    "name": "summary_model haiku",
    "text": "---\nsummary_model: haiku\n---\n",
    "expect": { "raw": { "summary_model": "haiku" }, "notifyAfterS": 120, "historySize": 50, "summaryModel": "haiku" }
  },
  {
    "name": "summary_model other than haiku",
    "text": "---\nsummary_model: gpt\n---\n",
    "expect": { "raw": { "summary_model": "gpt" }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null }
  },
  {
    "name": "null and empty values",
    "text": "---\ncodex_model: null\nlocal_model:\nlog_calls: true\n---\n",
    "expect": { "raw": { "codex_model": null, "local_model": null, "log_calls": true }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null }
  },
  {
    "name": "no frontmatter",
    "text": "timeout_ms: 600000\n",
    "expect": { "raw": {}, "notifyAfterS": 120, "historySize": 50, "summaryModel": null }
  },
  // v0.12.0: runner settings. `warnings` are the global file's, without the
  // file name the loaders put in front; `runner` is the runner in use when
  // this text is the global file. Cases without them expect [] and null.
  {
    "name": "dotted runner keys",
    "text": "---\nlocal_runner: llama-swap\nllama-swap.default: qwen3.6-35b-a3b\nllama-swap.key_env: LLAMA_SWAP_API_KEY\n---\n",
    "expect": { "raw": { "local_runner": "llama-swap", "llama-swap.default": "qwen3.6-35b-a3b", "llama-swap.key_env": "LLAMA_SWAP_API_KEY" }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null, "warnings": [], "runner": "llama-swap" }
  },
  {
    "name": "indented line ignored and warned",
    "text": "---\nlocal_runner: ollama\nllama-swap:\n  fast: qwen3.5-4b\n---\n",
    "expect": { "raw": { "local_runner": "ollama", "llama-swap": null }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null, "warnings": ["line 3: unknown setting `llama-swap`", "line 4: indented lines aren't supported; write `runner.key: value`"], "runner": "ollama" }
  },
  {
    "name": "unknown key, unknown runner, bad local_runner",
    "text": "---\nlocal_runner: olama\nllama-swap.defualt: x\nollamma.fast: y\ntimeout_msx: 5\n---\n",
    "expect": { "raw": { "ollamma.fast": "y" }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null, "warnings": ["line 2: `local_runner` must be one of ollama, llama-swap, lmstudio, llama-server, openai", "line 3: unknown setting `llama-swap.defualt`", "line 4: unknown runner `ollamma` in `ollamma.fast`", "line 5: unknown setting `timeout_msx`"], "runner": null }
  },
  {
    "name": "runner settings without local_runner",
    "text": "---\nlocal_model: qwen3.5:4b\nllama-swap.fast: qwen3.5-4b\n---\n",
    "expect": { "raw": { "local_model": "qwen3.5:4b", "llama-swap.fast": "qwen3.5-4b" }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null, "warnings": ["`local_runner` isn't set, so the runner settings (llama-swap.fast) are not used"], "runner": null }
  },
  {
    "name": "a key set twice: the last counts, and it is warned",
    "text": "---\nlocal_runner: llama-swap\ntimeout_ms: 1000\ntimeout_ms: 2000\n---\n",
    "expect": { "raw": { "local_runner": "llama-swap", "timeout_ms": 2000 }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null, "warnings": ["line 4: `timeout_ms` is set again (line 3); only the last one counts"], "runner": "llama-swap" }
  },
  {
    "name": "comments and blank lines are not warned about",
    "text": "---\n# a note\n\n  # an indented note\nlocal_runner: llama-swap # in use\n---\n",
    "expect": { "raw": { "local_runner": "llama-swap" }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null, "warnings": [], "runner": "llama-swap" }
  },
  {
    "name": "delegate keys are known in the global file",
    "text": "---\ndelegate.on_close: keep\ndelegate.time_limit_min: 90\n---\n",
    "expect": { "raw": { "delegate.on_close": "keep", "delegate.time_limit_min": 90 }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null, "warnings": [] }
  },
  {
    "name": "a fence is not a settings key: delegate.fence.codex is unknown",
    "text": "---\ndelegate.on_close: keep\ndelegate.fence.codex: full\n---\n",
    "expect": { "raw": { "delegate.on_close": "keep" }, "notifyAfterS": 120, "historySize": 50, "summaryModel": null, "warnings": ["line 3: unknown setting `delegate.fence.codex`"] }
  }
];
