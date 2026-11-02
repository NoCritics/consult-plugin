---
# consult settings (sample). Every line is commented out, so copying this file
# changes nothing until you uncomment what you want.
#
# Where it goes: `~/.claude/consult.local.md` (global) or
# `<project>/.claude/consult.local.md` (project). The first file found is used,
# the project's before the global one; they don't merge.
# Only this frontmatter is read. Invalid values are dropped and the default
# is used. This file lists every key with its default.

# ----- Codex (OpenAI) -----
# Omit both to use codex's own defaults (`model`, `model_reasoning_effort` in
# ~/.codex/config.toml). Results show what ran, e.g. "gpt-6-astra (codex default)".
# codex_model: gpt-6.1-sol
# codex_reasoning_effort: high          # minimal | low | medium | high | xhigh | max | ultra (model-dependent)
# codex_sandbox: read-only              # read-only | workspace-write | danger-full-access
# codex_timeout_ms: 900000              # default: max(timeout_ms, 600000)
# codex_hooks: true                     # run ~/.codex/hooks.json on consult calls (default false)

# ----- Antigravity / agy (Google; the default Google provider) -----
# Model ids encode effort and rotate; the agy_status tool lists them.
# agy_model: gemini-3.8-flash-high
# agy_effort: high                      # low | medium | high | xhigh | max (model-dependent)
# agy_timeout_ms: 300000                # default: timeout_ms
# agy_image_dir: C:\Users\me\Pictures\ai  # agy_generate_image output; default: <project>/consult-images, else ~/Pictures/consult-images
# agy_image_timeout_ms: 300000          # agy_generate_image takes ~1 min per image; +2 min per extra image
# agy_image_aspect_ratio: 1:1           # 1:1 2:3 3:2 3:4 4:3 9:16 16:9, or auto (agy picks)
# codex_image_dir: C:\Users\me\Pictures\ai  # codex_generate_image output; default: <project>/consult-images, else ~/Pictures/consult-images
# codex_image_timeout_ms: 300000        # codex_generate_image takes ~1 min per image; +2 min per extra image
# codex_image_aspect_ratio: 1:1         # 1:1 2:3 3:2 3:4 4:3 9:16 16:9, or auto (the model picks)
# File writes are governed by agy's own settings, not here: see the README, "Good to know".

# ----- Gemini CLI (legacy; needs a paid GEMINI_API_KEY) -----
# gemini_model: gemini-3.1-pro-preview  # leave unset: preview names rotate
# gemini_approval_mode: plan            # default | auto_edit | yolo | plan (read-only, default)

# ----- Local runners (llama-swap, Ollama, LM Studio, llama-server, any OpenAI-compatible) -----
# /consult:setlocal writes these after you confirm a diff. Runner settings are read
# from the GLOBAL file (~/.claude/consult.local.md) only; a project file's are ignored.
# local_runner: llama-swap              # llama-swap | ollama | lmstudio | llama-server | openai
# llama-swap.url: http://127.0.0.1:9292/v1          # llama-swap has no standard port
# llama-swap.key_env: LLAMA_SWAP_API_KEY            # the NAME of the variable holding the key
# llama-swap.start: Desktop shortcut "llama-swap"   # shown when it isn't running; never run
# llama-swap.default: qwen3.6-35b-a3b
# llama-swap.fast: qwen3.5-4b
# llama-swap.vision: qwen3.5-4b
# llama-swap.vision_best: qwen3.5-4b
# llama-swap.big: flash-next
# ollama.url: http://127.0.0.1:11434/v1             # optional: the standard address
# ollama.default: qwen3.8-9b-distill:q4_k_m
# ollama.fast: qwen3.5:4b
# Shared by every runner:
# local_temperature: 0.7                # 0.0-2.0
# local_reasoning_effort: none          # none | low | medium | high; `none` turns thinking off
# local_timeout_ms: 300000              # default: timeout_ms, at least 20 min on llama-swap and for an Ollama model that doesn't fit the GPU
# local_image_max_edge: 1024            # PNGs larger than this are downscaled
# local_vram_mb: 8151                   # Ollama: default nvidia-smi's reading; decides which models fit the GPU
# The 0.11.0 way (used while local_runner is unset; with local_runner: ollama these are Ollama's):
# local_base_url: http://127.0.0.1:11434/v1   # keep non-loopback URLs in the GLOBAL file only
# local_model: qwen3.5:9b
# local_api_key: null                   # prefer <runner>.key_env
# local_model_fast: qwen3.5:4b
# local_model_vision: qwen3.5:4b
# local_model_vision_best: qwen3.8-27b:ud-iq4_xs
# local_model_big: qwen3.6-35b-a3b:ud-iq3_xxs

# ----- Council (council_vote) -----
# claude_model: claude-sonnet-5-5
# council_use_bare: true                # default: bare iff ANTHROPIC_API_KEY is set
# council_timeout_ms: 240000            # default: timeout_ms

# ----- Common -----
# timeout_ms: 180000                    # default for providers without their own
# log_calls: true                       # metadata only, to ~/.claude/consult-log.jsonl

# ----- Claude Code band and pane -----
# notify_after_s: 120                   # request a push notification after calls this long; 0 = never
# history_size: 50                      # calls kept across sessions for /consult (1-200)
# summary_model: haiku                  # unset: summary = the answer's first paragraph

# ----- Delegate (background tasks); global file only, also set from the Delegated tab -----
# delegate.code: codex                  # worker for writing, building, editing: codex | agy | local | ask
# delegate.research: agy
# delegate.review: agy
# delegate.private: local               # private or offline work
# delegate.local_at_once: auto          # auto, or a ceiling 1-8 for local tasks at once
# delegate.on_close: stop               # stop | keep: what happens to running tasks when Claude Code closes
# delegate.time_limit_min: 180          # per task, 10-1440
# Worker fences are set per project in the Delegated tab (/consult), not in this file.
---
