---
description: Run a council tournament - send a prompt to Claude, Codex, and Antigravity in parallel, have each model rank all three answers anonymously, return the Borda-count winner
argument-hint: "[--verbose] [--bare | --no-bare] [--participants claude,codex,agy,gemini,local] <prompt>"
allowed-tools: ["mcp__plugin_consult_consult__council_vote"]
---

# /consult:council

Run a tournament across Claude, Codex, and Antigravity (`agy`) and return the consensus best answer.

The default participants are `claude`, `codex` and `agy`. `gemini` (legacy CLI, needs a paid `GEMINI_API_KEY`) and `local` (needs a local runner from `/consult:setlocal`) are opt-in. A local model can join as a free fourth voice via `--participants claude,codex,agy,local`.

## Steps

1. Read `$ARGUMENTS`. Parse it for optional flags before the prompt body.

2. **Flag parsing** (consume from start of `$ARGUMENTS`):
   - `--verbose` -> set `verbose: true` in the tool args
   - `--timeout <seconds>` (or `<n>m` for minutes, e.g. `15m`) -> set `timeout_s` in the tool args, 30-1800 seconds (the limit for each member's call in each round)
   - Any image paths mentioned in the prompt (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) -> collect into `images` and remove them from the prompt body. Images require vision-capable participants only: `codex`, `agy`, `local`. If the participant list would include `claude` or `gemini`, drop them and tell the user why -- the tool refuses a mixed council rather than ranking blind participants against sighted ones.
   - `--bare` -> set `use_bare: true`
   - `--no-bare` -> set `use_bare: false`
   - `--participants <comma,list>` -> parse as array, e.g. `--participants claude,agy` -> `participants: ["claude", "agy"]`. Valid values: `claude`, `codex`, `agy`, `gemini`, `local`. Default (flag omitted) is `claude,codex,agy`. Both `gemini` (legacy, needs a paid API key) and `local` (needs a local runner from `/consult:setlocal`) are opt-in only. Minimum 2 participants.
   - Anything else is part of the prompt.

   The flags are optional; the user may not include any. The remainder is the prompt.

3. If the remaining prompt is empty after flag parsing, ask: "What should the council vote on?" and stop. Do not invent a prompt.

4. **Detect any file references in the remaining prompt and inline them.** See the "File handling" section below. The council sends the prompt 6 times - size guardrails are tighter (50KB single / 150KB total). Build the final prompt with file blocks first, the user's question last.

5. Call `mcp__plugin_consult_consult__council_vote` with the parsed args (using the built prompt). Tournaments take 30-60 seconds; before calling, briefly tell the user "Running council vote across N models, this takes ~30-60s..." (N = number of participants) so they aren't left guessing.

6. Format the result for the user. The shape is:
   ```json
   {
     "winner": "B",
     "winner_model": "codex",
     "winner_response": "...",
     "scores": {"A":{"model":"claude","borda":3}, ...},
     "tied": false,
     "tied_at_top": ["B"],      // every label sharing the top Borda score
     "degraded": false,
     "failures": [...],         // present only if any model failed
     "total_latency_ms": 32145,
     "candidates": {...},       // present iff tied OR verbose
     "rankings": [...]          // present iff verbose
   }
   ```
   `tied_at_top` always lists every winner-tied label, so a 3-way tie is `["A","B","C"]` and a 2-way is `["A","B"]`. Use it to decide which candidates to show on tied output.

## Output format (compact - default)

When `tied: false` and `verbose: false` (the default):

```
Council verdict (Borda 6 / max 6, total 32.1s):

  Winner: codex (B) - 5 pts
  claude (A): 3 pts | agy (C): 4 pts

<winner_response verbatim, no edits>
```

If `degraded: true`, prepend a single line note:
```
Note: <participant> failed (<reason>). Council ran 2-way.
```

## Output format (tied)

When `tied: true`, show only the candidates listed in `tied_at_top` (a 2-way tie omits the non-tied loser; a 3-way tie shows all three):

```
Council vote tied at <N> pts. Candidates tied for first - your call:

[<model_a> (<label>): <borda> pts]
<response_a>

[<model_b> (<label>): <borda> pts]
<response_b>
```

End with: "Reply with the label letter or the model name to lock in your pick."

## Output format (verbose)

When `verbose: true`, after the compact verdict, also print:

```
---

Per-judge rankings:
- claude:  B > C > A
- codex:   B > A > C
- agy:     C > B > A

All candidates:

[claude (A): 3 pts]
<response_a>

[codex (B): 5 pts]
<response_b>

[agy (C): 4 pts]
<response_c>
```

## Failure handling

- If `mcp__plugin_consult_consult__council_vote` throws, surface the error verbatim. Don't try to compose your own answer; the user wanted the council's verdict.
- Common failure: `use_bare=true requested but ANTHROPIC_API_KEY env var is not set`. Tell the user to either set the env var, omit `--bare`, or pass `--no-bare`.

## File handling (always on)

The CLI subprocesses have no access to your filesystem. Inline any file the user references into the prompt before calling the tool. Same heuristics as the other consult commands, but with TIGHTER size limits because the council sends the prompt 6 times.

- **Detect:** explicit paths (with ranges like `src/api.py:50-80`), "this file" (the most recent file you `Read`; ask if ambiguous), directory mentions (Glob; confirm if > 5 files). Pasted code passes through as is.
- **Inline** each file as `` `path` `` followed by a fenced block. For files of 20+ lines, prefix each line with its source line number, right-aligned, then ` | ` (a `:50-80` range starts at 50). Files first, the question last.
- **Guardrails:** missing path -> ask; binary -> refuse; single file > 50KB or total > 150KB (the council sends the prompt 6 times) -> ask before sending. Never truncate silently.
- Edge cases and examples: `skills/second-opinion/references/file-handling.md` in this plugin.

## Notes

- Don't synthesize, edit, or summarize the winner's response. Pass it through verbatim.
- Don't add your own analysis on top unless the user explicitly asks.
- Each council vote spawns ~6 fresh CLI subprocesses (3 generations + 3 rankings). Each model judges all three candidates anonymously (labeled A/B/C in random order); shared model weights mean a judge could plausibly recognize its own writing style, but Borda count across 3 judges smooths residual self-favoring.
- **Adding `local`:** makes it a 4-way tournament (8 calls, but the 2 local calls are free and run on this machine, with no API tokens). Two caveats worth passing to the user if relevant: small local models often fail the strict `1st: A` ranking format — the council retries once, then drops that vote and continues, so it degrades rather than breaks — and a weak local candidate usually places last, which is informative but adds latency. Prefer a 9B+ local model as a judge. `--participants local,agy` gives a cheap 2-way tournament.
- Don't add `local` or `gemini` on your own initiative. If the user wants a cheaper council, suggest `local`; don't silently change the participant list.
- **`gemini` is opt-in and usually broken.** It fails with an ineligible-tier error on individual accounts. If the user explicitly asks for it, pass it through and report the failure honestly rather than substituting `agy`.
