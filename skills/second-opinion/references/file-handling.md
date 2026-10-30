# File handling for consult tool invocations

Canonical rules for detecting and inlining files into prompts before calling any consult tool that takes a `prompt` (`ask_codex`, `ask_agy`, `ask_gemini`, `ask_local`, `consult_chat_start`/`consult_chat_send`, `council_vote`). The external models have no access to your filesystem; images go in the separate `images` argument. Whatever they need to see must travel inside the prompt string.

## Detection (apply BEFORE calling any consult MCP tool)

Run these in order. Stop at the first matching rule.

### 1. Explicit file paths in user input

Scan the user's request (whether typed in chat or passed via `$ARGUMENTS`) for tokens that look like file paths and resolve to real readable files. Patterns to detect:

- Relative: `src/foo.py`, `./utils.js`, `lib/helpers.ts`
- Absolute: `C:\Users\...\foo.py`, `/home/user/foo.py`
- With line range hints: `src/foo.py:10-50`, `src/foo.py#L10-L50`
- Backtick-wrapped: `` `src/foo.py` ``
- Glob mentions: `src/*.py`, `tests/test_*.py` - expand via Glob, confirm count with user if > 5 matches

For each detected path:
- Verify the file exists (`Read` will tell you).
- Read the relevant portion (full file by default; just the requested line range if specified).
- Inline using the wrapper format below.

### 2. Already-inlined code blocks

If the user has pasted code fenced in triple backticks within their prompt, leave it alone. It's already part of the prompt string. Just pass through.

### 3. References to recent conversation context

Phrases like:
- "this file" / "that script" / "the function above"
- "what we just looked at" / "the change I made"
- "review this" / "consult on this" (with no file or code following)

Look at the most recent `Read` tool result in the conversation. If exactly one file fits the reference, use it. If ambiguous (multiple recent reads, no clear antecedent), ask one short clarifying question - **do not guess**.

### 4. Multiple files

If the user mentions several paths (e.g., "compare auth.py and login.py", "review src/handlers/"), inline each in its own block in the order mentioned. For directory mentions, list contents via Glob first, confirm with the user before reading more than ~5 files.

### 5. No file referenced

If the user's request has no file path, code block, or "this file" reference, just pass the prompt through as-is. Many consultations are pure text (definitions, explanations, opinions).

## Wrapper format

Use **standard markdown** with **line-numbered file bodies**. Every LLM parses both natively without special instructions, and the line numbers let the consulted model reference specific lines back in its response ("line 42 has a race condition") instead of describing them by name.

Use a language hint matching the file extension when one is obvious (`python`, `javascript`, `typescript`, `go`, `rust`, `sh`, `json`, `yaml`, `md`, etc.). If unsure, omit the language hint.

### Line numbering — convention

Format per line: `<right-padded line number> | <line content>`

- **Width** = digits in the LAST line number being emitted. A 35-line file → width 2 (` 1 | ...` to `35 | ...`). A 1200-line file → width 4 (`   1 | ...` to `1200 | ...`).
- **Separator**: ` | ` (space, pipe, space).
- **Numbers reflect the SOURCE file's line numbers.** If you're sending only `lines 10-50`, numbering starts at 10, not 1. This is the whole point — the consulted model should be able to say "line 42" and mean what the file's editor says.

### When to apply numbering

- File **≥ 20 lines** → number it.
- File **< 20 lines** → don't bother. Tiny snippets are just noise with numbers, and the model can quote the relevant fragment directly.
- Non-code files (markdown prose, JSON config) → number only if they're long AND the user is likely to want line-level references back.

### Single file (≥ 20 lines, with line numbers)

````
`path/to/file.ext`:

```python
  1 | import fs from 'node:fs';
  2 | 
  3 | function foo() {
  4 |   return 42;
... up to last line
 35 | export default foo;
```
````

### Single file with line range (numbers start at the source line)

````
`path/to/file.ext` (lines 10-50):

```python
 10 | import fs from 'node:fs';
 11 | 
 12 | function foo() {
... 
 50 | export default foo;
```
````

### Short file (< 20 lines, no numbering)

````
`scripts/tiny.sh`:

```sh
#!/usr/bin/env bash
set -euo pipefail
echo "hello"
```
````

### Multiple files

Stack them in order. Add a brief lead-in sentence so the LLM knows what's coming. Each file's numbering is independent (resets per file, starts at that file's line 1 or its slice start).

````
Files for review:

`src/auth.py`:

```python
  1 | <line-numbered contents>
```

`src/login.py`:

```python
  1 | <line-numbered contents>
```

<original user question goes here, after the last file block>
````

### Important: file blocks come FIRST, question LAST

Put file blocks at the top of the prompt, the actual question at the end. LLMs respond best when context is loaded before the ask. Do NOT scatter file blocks throughout or paste them as appendices.

### What NOT to do with numbering

- **Don't restart numbering at 1 when sending a line-range slice** — the source numbers are the whole point.
- **Don't strip numbers from already-pasted code blocks.** If the user already pasted code (with or without numbers), pass it through unchanged.
- **Don't number prose-only files** (e.g. a `.md` description) unless they're long enough that line references are likely useful.
- **Don't insert numbers if the language is whitespace-significant in a way that confuses the model** (rare — Python and YAML both handle the `NN | ` prefix fine).

## Guardrails

### Path doesn't exist

Tell the user immediately. Don't guess at a corrected path. Example:

> I don't see `src/utls.py` in this project. Did you mean `src/utils.py`? Or is that path relative to a different root?

### Binary file

Reading binary files yields garbage that breaks the prompt. Detect via extension (`.pdf`, `.zip`, `.so`, `.dll`, `.exe`, `.bin`, etc.) OR via Read failure on a file that isn't valid UTF-8. Images (`.png .jpg .jpeg .gif .webp`) are not inlined as text: pass them in `images` for codex, agy and local. For other binary files, tell the user:

> `assets/data.bin` is a binary file - I can't inline it as text. What should I extract from it (e.g., dimensions, metadata)? Or did you mean a different file?

### Size thresholds

Compute total bytes that would be inlined. Use these thresholds:

| Limit | Action |
|---|---|
| Single file > 100KB | Pause and ask: "This file is N KB. Excerpt to relevant section, or send the whole thing?" |
| Total inlined > 300KB | Pause and ask: "Total is N KB across M files. Split into multiple consults, excerpt, or send all?" |
| For `council_vote`: apply at HALF the thresholds (50KB / 150KB) | Same questions. Council sends the prompt 6 times - tokens add up. |

Do not silently truncate. The user must consent to losing context.

### File outside the project / cwd

If the path is absolute and outside the user's project directory, read it (you have access) but prepend the full absolute path in the file label so the external CLI knows where it came from. Don't bring up the location as a concern unless it looks suspicious (e.g., `/etc/passwd`).

## Examples

### Example 1: explicit path

User: `/consult:codex review src/utils.py for thread safety issues`

Built prompt (assume `src/utils.py` is 42 lines, so width 2):

````
`src/utils.py`:

```python
 1 | import threading
 2 | 
 3 | _lock = threading.Lock()
 ... (lines 4-41 elided here for example brevity; in the real prompt include every line)
42 | __all__ = ['SafeCounter']
```

Review for thread safety issues.
````

### Example 2: pasted code

User: *"ask gemini if this is idiomatic Go:* ```go func foo() {} ```*"*

Built prompt: pass through verbatim. No detection needed - the code is already in the prompt.

### Example 3: "this file" reference

Earlier in conversation, Claude `Read` `src/auth.py`. User then says: *"council vote on whether this needs refactoring"*

Built prompt:

````
`src/auth.py`:

```python
<contents>
```

Should this be refactored? Vote.
````

### Example 4: multiple files

User: `/consult:council compare auth.py and oauth.py - which approach is cleaner?`

Built prompt:

````
Files for comparison:

`auth.py`:

```python
<contents>
```

`oauth.py`:

```python
<contents>
```

Which approach is cleaner? Justify briefly.
````

### Example 5: line range

User: *"ask codex what's wrong with src/api.py lines 50-80"*

Built prompt (numbers reflect source file lines, not 1-31):

````
`src/api.py` (lines 50-80):

```python
50 | @app.route('/users/<int:uid>')
51 | def get_user(uid):
52 |     user = db.query(User).get(uid)
 ...
80 |     return jsonify(user.to_dict())
```

What's wrong with this section?
````

### Example 6: directory mention

User: *"have the council review src/handlers/"*

First, list the directory via Glob. If 1-5 files, proceed with all of them. If > 5, ask: "I see 12 files in src/handlers/. Should I send all of them (~N KB total), or pick a subset?"

### Example 7: refuse silently truncating

User: *"council vote on the whole codebase, src/"* (total > 1MB)

Don't truncate. Don't pick arbitrary files. Tell the user:

> src/ contains 47 files totaling 1.2 MB. That's too much to inline (the council would receive it 6 times). Options: (a) name specific files, (b) I'll grep for the most relevant N functions, (c) send a high-level overview I generate from listing the structure. Which?

## Failure modes to handle gracefully

| Situation | Handling |
|---|---|
| Path looks valid but Read errors with ENOENT | Tell user the path doesn't exist; suggest closest match if obvious |
| Path is a directory, not a file | List contents, ask user which file(s) |
| File is empty | Inline it anyway with an empty block; mention "(empty file)" in the label |
| File is huge | Use the size guardrail; never auto-truncate |
| Read returns binary garbage | Detect (non-UTF8 sequences); refuse with binary-file message |
| User mentions a path that's gitignored or outside cwd | Read works; don't second-guess - just inline |

## What NOT to do

- **Don't paraphrase or summarize file contents** when inlining. Pass them through verbatim. The LLM judge wants to see the actual code.
- **Don't strip comments, blank lines, or formatting.** The judge may care about style.
- **Don't reorder file contents.** Preserve original line order.
- **Don't translate language tags.** Use the obvious one or none.
- **Don't add commentary inside the file block.** Your context goes outside.
- **Don't combine multiple files into one block.** Each file gets its own block with its own path label.
- **Don't read files outside what the user asked for** "just to be helpful." That's scope creep and inflates the prompt.
