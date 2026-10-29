#!/usr/bin/env node
// `consult` MCP server: exposes the Codex and Antigravity (agy) CLIs, the
// legacy Gemini CLI, and any local OpenAI-compatible runner as tools -- one-shot
// asks, multi-turn chat, and a council tournament (with the Claude CLI as a
// participant) that ranks parallel answers by Borda count.

// Suppress Node's DEP0190 deprecation. We must use spawn(.., {shell:true}) on
// Windows to launch .cmd shims (CVE-2024-27980); the warning is informational.
// We replace the default warning listener so other warnings still surface.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.code === 'DEP0190') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

// The MCP SDK, bundled by build-vendor.js so an install needs no node_modules.
import {
  Server,
  StdioServerTransport,
  CallToolRequestSchema,
  ListToolsRequestSchema
} from './vendor/mcp-sdk.js';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { askCodex, codexChatStart, codexChatSend, codexChatEnd, codexLoginStatus, codexLoginStart, codexTimeoutMs, codexRunHooks } from './lib/codex.js';
import { askGemini, geminiChatStart, geminiChatSend, geminiChatEnd, geminiAuthCheck } from './lib/gemini.js';
import { codexGenerateImage } from './lib/codex-image.js';
import { CODEX_IMAGE_ASPECT_RATIOS } from './lib/image.js';
import { askAgy, agyChatStart, agyChatSend, agyChatEnd, agyStatus, agyGenerateImage, AGY_EFFORTS, AGY_IMAGE_ASPECT_RATIOS, AGY_IMAGE_TIERS } from './lib/agy.js';
import { askLocal, localStatus } from './lib/local.js';
import { liveFacts, savedNicknames, resolveModel } from './lib/local-models.js';
import {
  RUNNER_TYPES, runnerKey, runnerInventory, prepareRunnerCall, checkDoubleLoad, forgetCachedKey, swapStatus,
  otherRunners, asOllamaSettings, seeingModels
} from './lib/local-runners.js';
import { setupLocal, unloadLocal } from './lib/local-setup.js';
import { guardOneShot } from './lib/delegate-local.js';
import { DELEGATE_TOOLS, DELEGATE_TOOL_NAMES, DELEGATE_TOOL_META, DELEGATE_ROUTING_TEXT, callDelegateTool } from './lib/delegate.js';
import { startDelegateBackground } from './lib/delegate-sweep.js';
import { councilVote } from './lib/council.js';
import { loadSettings, runnerSettings, runnerFor, configuredRunners } from './lib/settings.js';
import { scrubPii, REASONING_EFFORTS, callContext, timeoutMsFromSeconds, TIMEOUT_S_MIN, TIMEOUT_S_MAX } from './lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

// The Claude Desktop extension sets CONSULT_DELEGATE=off (manifest.json): it has no
// delegate tools, no delegate text in the instructions, no heartbeat and no sweeps.
const DELEGATE_ENABLED = process.env.CONSULT_DELEGATE !== 'off';

// Server instructions: hosts that defer MCP tool definitions (tool search)
// still put these in the system prompt at session start, so this is what
// lets Claude go straight to the right tool instead of searching blind.
// Claude Code truncates them at 2,048 chars -- most important first.
const SERVER_INSTRUCTIONS = [
  'consult asks OTHER AI models for a second opinion via their local CLIs: Codex (OpenAI GPT), Antigravity/agy (Google Gemini; also Claude and GPT-OSS models), local models (llama-swap, Ollama, LM Studio, llama-server), and the legacy Gemini CLI.',
  'Use it when the user names one of those models or asks for a second opinion, another model\'s view, a review by another AI, or a council/vote between models. Also when the user wants an image generated (agy_generate_image, or codex_generate_image for GPT/OpenAI images).',
  'Tools: ask_codex, ask_agy, ask_local, ask_gemini (one-shot; ask_codex/ask_agy/ask_local accept image paths); agy_generate_image (makes images and saves them to disk, ~1 min each); codex_generate_image (GPT images via Codex, saved to disk, ~1 min each); consult_chat_start / consult_chat_send / consult_chat_end (multi-turn); council_vote (models answer and rank each other); agy_status, local_status, codex_login_status, codex_login_start, gemini_auth_status (diagnostics); local_setup (runner and nicknames, only when the user asks); local_unload (only after the user agrees).',
  ...(DELEGATE_ENABLED ? [`${DELEGATE_ROUTING_TEXT} Delegate tools: delegate (starts it, returns at once), delegate_status, delegate_list, delegate_result, delegate_merge, delegate_send, delegate_cancel, delegate_wait.`] : []),
  'If these tools are deferred, load every one you need in a SINGLE tool search rather than one search per tool.',
  'Prefer ask_agy over ask_gemini for Google models. The other model cannot see this conversation or the user\'s files: put everything it needs, including file contents, in the prompt.',
  'Long codex calls can take minutes; pass timeout_s (30-1800 s). A result starting with "INCOMPLETE:" is not an answer: say so, show the partial only as partial; one retry with its suggested timeout_s is fine.'
].join('\n');

const server = new Server(
  { name: 'consult', version: pkg.version },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

// The per-call timeout every long-running tool takes. Claude Code's idle
// timeout for a stdio server (30 min by default) is why the ceiling sits there.
const TIMEOUT_S_PROP = {
  type: 'number', minimum: TIMEOUT_S_MIN, maximum: TIMEOUT_S_MAX,
  description:
    'Optional time limit for this call, in seconds (30-1800). Overrides the settings for this call only. ' +
    'Raise it for big inlined files, high/xhigh/max/ultra effort, several images, or a council; ' +
    'retry with a larger value when a result starts with "INCOMPLETE:". Under Cowork anything past 4 minutes is cut off regardless.'
};

const TOOLS = [
  {
    name: 'ask_codex',
    description:
      'Send a prompt to the Codex CLI (OpenAI) headless and return the model\'s clean text response. ' +
      'Use this for a second opinion, code review, or any task you want Codex (GPT-family) to weigh in on. ' +
      'Codex runs in read-only sandbox - it cannot write to disk. Long prompts are fine. ' +
      'Image reviews at high reasoning effort can take several minutes (the timeout is 10 minutes by default; pass `timeout_s` for more, up to 30 minutes). ' +
      'If the result starts with "INCOMPLETE:", codex ran out of time: the fenced text is only the last message it had finished - possibly just a progress note - so do not present it as Codex\'s answer. ' +
      'The user\'s codex hooks are OFF by default on consult calls; pass run_hooks: true to run them.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to Codex.' },
        model: { type: 'string', description: 'Optional model override (e.g. "gpt-6.1-sol", "gpt-6-astra"). Omit to use the Codex CLI default (config.toml). Note: on a ChatGPT-account login the "-codex" model variants are rejected.' },
        reasoning_effort: { type: 'string', enum: [...REASONING_EFFORTS], description: 'Optional reasoning effort. Model-dependent: gpt-6.1-sol and gpt-6-astra take low..max and ultra, no current model takes minimal, and codex rejects an unsupported level with a clear error.' },
        images: { type: 'array', items: { type: 'string' }, description: 'Optional list of image file paths to attach (absolute paths, or relative to the session cwd). PNG, JPEG, GIF, WebP - validated by file signature, not extension. Use for screenshots, diagrams, UI mockups, error dialogs, or any question that needs the model to SEE something. Codex reads them natively.' },
        run_hooks: { type: 'boolean', description: "Codex only. Run the user's own codex hooks (~/.codex/hooks.json) on this call. Default: the `codex_hooks` setting, which is false - consult passes --disable hooks, because hooks are written for interactive sessions and a Stop hook can make codex keep working after its answer is done. Set true only when the user asks for their hooks to run (e.g. they want a hook-driven review pass); the result reports `hooks_ran`." },
        timeout_s: TIMEOUT_S_PROP
      },
      required: ['prompt']
    }
  },
  {
    name: 'ask_agy',
    description:
      'Send a prompt to the Antigravity CLI (Google) headless and return the model\'s clean text response. ' +
      'This is the DEFAULT Google-side provider - prefer it over ask_gemini, which no longer works on individual accounts. ' +
      'Use for a second opinion, code review, or any task you want a Gemini-family model to weigh in on. ' +
      'Also fronts non-Google models (Claude Sonnet/Opus, GPT-OSS) - call `agy_status` to list what this account can reach. ' +
      'Ask QUESTIONS only. consult prepends an answer-in-text-only instruction and disables slash-command expansion, but it cannot make agy read-only: headless agy auto-denies shell commands everywhere, yet it WILL create/edit files inside directories the user has marked trusted in agy itself (settings.json trustedWorkspaces - often their whole home dir). ' +
      'Never phrase a prompt as "fix/change/write the file". Results carry a `denied_actions` field when agy was refused a tool, and consult raises a clear error on an empty or partial (timed-out) response. `agy_status` reports the current write posture.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send.' },
        model: { type: 'string', description: 'Optional model override (e.g. "gemini-3.8-flash", "gemini-3.8-flash-high", "claude-opus-5-5-high"). Omit to use the CLI default. Call `agy_status` for the ids this account can reach rather than guessing; a base id without an effort suffix uses that model\'s default effort.' },
        effort: { type: 'string', enum: [...AGY_EFFORTS], description: 'Optional reasoning effort. Model-dependent (gemini-3.8-flash: low, medium, high); agy rejects an unsupported level with a clear error. Redundant when the model id already ends in an effort (e.g. "-high").' },
        images: { type: 'array', items: { type: 'string' }, description: 'Optional list of image file paths to attach (absolute paths, or relative to the session cwd). PNG, JPEG, GIF, WebP - validated by file signature, not extension. Use for screenshots, diagrams, UI mockups, error dialogs, or any question that needs the model to SEE something. agy opens them off disk itself.' },
        timeout_s: TIMEOUT_S_PROP
      },
      required: ['prompt']
    }
  },
  {
    name: 'agy_generate_image',
    description:
      'Generate images with Antigravity (Google\'s built-in image model) and save them to disk. ' +
      'Use when the user asks for an image, illustration, icon, mockup or picture to be made (not described). ' +
      'Describe the image fully in `prompt`; set `count` for several, `aspect_ratio` for the shape. Pass `images` to give up to 3 reference images (edit this photo, keep this face, match this style). ' +
      'Choose `tier`: "pro" for legible text in the image, busy multi-element scenes, or matching 2-3 references (faces, products, a style); "flash" for quick drafts, simple icons and throwaway variations; omit it otherwise. ' +
      'Each image is a ~1K JPEG (1024x1024 at 1:1, 768x1376 at 9:16, 1376x768 at 16:9) and takes about a minute; the timeout is 5 minutes plus 2 per extra image (`agy_image_timeout_ms`; `timeout_s` overrides). ' +
      'Returns the saved file paths: show them to the user (read the files to view them). agy\'s conversation is deleted afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw: subject, style, composition, colours and any text in the image.' },
        aspect_ratio: { type: 'string', enum: AGY_IMAGE_ASPECT_RATIOS, description: 'Shape of the image. Default: the `agy_image_aspect_ratio` setting, else "1:1". Portrait 9:16/3:4/2:3 for phone screens, posters, full-body figures; landscape 16:9/4:3/3:2 for banners, scenes, slides. "auto" lets agy pick from the content.' },
        tier: { type: 'string', enum: AGY_IMAGE_TIERS, description: 'Tier of the agy subagent that writes the image prompt and judges the result (the image model itself is Google\'s choice). "pro": text in the image, complex scenes, 2-3 references. "flash": drafts, simple icons. Default "inherit": the model running the call.' },
        count: { type: 'integer', minimum: 1, maximum: 4, description: 'How many images to make (1-4), each a separate generation. Default 1.' },
        exact_prompt: { type: 'boolean', description: 'true: pass `prompt` to the image model word for word. Default false: agy may expand it. Set true when the prompt is already complete and detailed.' },
        images: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Optional reference image paths, at most 3 (absolute, or relative to the session cwd). PNG, JPEG, GIF, WebP. More than 3 is refused: agy would drop the rest without saying which.' },
        output_dir: { type: 'string', description: 'Optional folder to save into (absolute, or relative to the session cwd); created if missing. Default: the `agy_image_dir` setting, else consult-images/ in the project, else ~/Pictures/consult-images. Existing files are never overwritten.' },
        model: { type: 'string', description: 'Optional agy model that drives the request (the image model itself is fixed). Omit for the CLI default.' },
        timeout_s: TIMEOUT_S_PROP
      },
      required: ['prompt']
    }
  },
  {
    name: 'codex_generate_image',
    description:
      'Generate images with GPT (OpenAI) through the Codex CLI, under the user\'s ChatGPT plan (no API key), and save them to disk as PNG. ' +
      'Use when the user names GPT, OpenAI, Codex or ChatGPT for an image, or needs a transparent background; for other image requests agy_generate_image is the default. ' +
      'Describe the image fully in `prompt`; set `count` for several, `aspect_ratio` for the shape (followed approximately). `transparent_background` gives real transparency. Pass `images` to give up to 5 reference images (edit this photo, keep this face, match this style). ' +
      'Each image takes about 45-60 seconds; the timeout is 5 minutes plus 2 per extra image (`codex_image_timeout_ms`; `timeout_s` overrides). ' +
      'The image model is OpenAI\'s choice and is not reported; `model` only picks the Codex model that drives the run. Prompts that copy copyrighted characters or logos are refused. ' +
      'Returns the saved file paths: show them to the user (read the files to view them). Uses Codex usage quota.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw: subject, style, composition, colours and any text in the image.' },
        aspect_ratio: { type: 'string', enum: CODEX_IMAGE_ASPECT_RATIOS, description: 'Shape of the image, followed approximately. Default: the `codex_image_aspect_ratio` setting, else "1:1". Portrait 9:16/3:4/2:3 for phone screens, posters, full-body figures; landscape 16:9/4:3/3:2 for banners, scenes, slides. "auto" lets the model pick from the content.' },
        transparent_background: { type: 'boolean', description: 'true: the image has a real transparent background (cut-out, sticker, icon, asset). Default false.' },
        count: { type: 'integer', minimum: 1, maximum: 4, description: 'How many images to make (1-4), each a separate generation. Default 1.' },
        exact_prompt: { type: 'boolean', description: 'true: pass `prompt` to the image model word for word. Default false: Codex may expand it. Set true when the prompt is already complete and detailed.' },
        images: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Optional reference image paths, at most 5 (absolute, or relative to the session cwd). PNG, JPEG, GIF, WebP.' },
        output_dir: { type: 'string', description: 'Optional folder to save into (absolute, or relative to the session cwd); created if missing. Default: the `codex_image_dir` setting, else consult-images/ in the project, else ~/Pictures/consult-images. Existing files are never overwritten.' },
        model: { type: 'string', description: 'Optional Codex model that drives the request (the image model itself is OpenAI\'s choice). Omit for the `codex_model` setting or the CLI default.' },
        timeout_s: TIMEOUT_S_PROP
      },
      required: ['prompt']
    }
  },
  {
    name: 'agy_status',
    description:
      'Check whether the Antigravity CLI is authenticated and list the models this account can reach. ' +
      'Costs no tokens (no inference). Call before `ask_agy` when unsure which models exist, and when diagnosing any ask_agy failure.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'ask_gemini',
    description:
      'Send a prompt to the legacy Gemini CLI (Google) headless. ' +
      'Works only with a paid GEMINI_API_KEY: on individual accounts it fails with an ineligible-tier error, and re-authenticating does not help. ' +
      'Use it when the user explicitly asks for the legacy gemini CLI; for Google models otherwise, use `ask_agy`.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to Gemini.' },
        model: { type: 'string', description: 'Optional model override. Omit to let Gemini CLI choose: model names rotate and a pinned one can 404.' },
        timeout_s: TIMEOUT_S_PROP
      },
      required: ['prompt']
    }
  },
  {
    name: 'ask_local',
    description:
      'Send a prompt to a LOCAL model running on this machine (llama-swap, Ollama, LM Studio, llama-server, or another OpenAI-compatible runner) and return its clean text response. ' +
      'Free and private - nothing leaves the machine, no API tokens are spent. ' +
      'Use when the user asks for a "local model", "offline", "private", or names a local runner or model (e.g. "ask qwen", "run it through ollama"), ' +
      'or when they want a cheap extra opinion where cost matters more than peak quality. ' +
      'Uses the runner in use (`local_runner`, set by /consult:setlocal) and its `default` model unless `model` names another: a nickname the user confirmed (fast, vision, vision-best, big), a full name, or a fragment matching one model. ' +
      'Call `local_status` to see the models, which one is loaded, and the saved nicknames. Images go to the `vision` model when the chosen one can\'t read them. ' +
      'llama-swap calls, and Ollama models that don\'t fit the GPU, get at least 20 minutes; a model that stops sending tokens for 2 minutes after it started ends the call as INCOMPLETE. ' +
      'The address comes from settings only - this tool cannot point at an arbitrary host.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to the local model.' },
        model: { type: 'string', description: 'Optional: a nickname from /consult:setlocal (fast, vision, vision-best, big, default), a full model name or alias (e.g. "fast:nothink" on llama-swap), or a fragment matching one model (e.g. "distill"). Omit for the runner\'s default. See `local_status` for what is listed.' },
        runner: {
          type: 'string',
          enum: [...RUNNER_TYPES],
          description: 'Optional: use this runner for this one call instead of the one in use - a runner type the settings configure (or one with a standard address), never an address. Refused while the runner in use has a model loaded (unload it first with `local_unload`, after the user agrees). Omit normally.'
        },
        temperature: { type: 'number', description: 'Optional sampling temperature, 0-2. Omit for the runner default.' },
        reasoning_effort: {
          type: 'string',
          enum: ['none', 'low', 'medium', 'high'],
          description: 'Optional chain-of-thought control for reasoning models. Use "none" to disable thinking entirely - dramatically faster and cheaper, and prevents small models from exhausting their context window mid-thought. On llama.cpp-based runners (llama-swap, llama-server) "low", "medium" and "high" act like the default. Omit for the model default.'
        },
        images: {
          type: 'array', items: { type: 'string' },
          description: 'Optional list of image file paths to attach (absolute paths, or relative to the session cwd). PNG, JPEG, GIF, WebP - validated by file signature, not extension. Use for screenshots, diagrams, UI mockups, error dialogs, or any question that needs the model to SEE something. A model you name keeps the call unless it is known not to read images; otherwise consult switches to the `vision` nickname and says so. Oversized PNGs are downscaled automatically - a 3000x2000 image costs ~4084 prompt tokens versus ~700 at 1024px, for the same answer. Prefer a 9B+ model: smaller ones describe images inaccurately.'
        },
        timeout_s: TIMEOUT_S_PROP
      },
      required: ['prompt']
    }
  },
  {
    name: 'local_status',
    description:
      'Check whether the local runner in use (or `runner`) is reachable and list its models: on llama-swap each model\'s name, description, aliases, whether it is loaded and whether it is known to read images; on Ollama each model\'s size, parameters, quant, vision and GPU fit. ' +
      'Also: the saved nicknames and whether each still resolves, other runners on this machine and what they have loaded (two runners holding models at once can run the machine out of memory), and settings warnings. ' +
      'Free and instant - no inference, no tokens, never loads a model. Call this before `ask_local` when choosing a model or unsure whether the runner is up, ' +
      'and when diagnosing any ask_local failure.',
    inputSchema: {
      type: 'object',
      properties: {
        runner: { type: 'string', enum: [...RUNNER_TYPES], description: 'Optional: a runner other than the one in use.' }
      }
    }
  },
  {
    name: 'local_setup',
    description:
      'Set up local runners and model nicknames. Use ONLY when the user asks to set up or switch their local models (e.g. /consult:setlocal). ' +
      'With no arguments it returns what runs on this machine (`probe`), the configured runners, the one in use, and a nickname proposal for it: one row per role (default, fast, vision, vision_best, big) with the proposed model, a reason and what is saved now (kept, gone, or replaced by another quant), plus `models`. Pass `runner` for another runner\'s proposal. ' +
      'Show the rows as a table and let the user approve, change or drop rows; when a row proposes several models (a tie), ask which. ' +
      'To write: call it first with `preview: true` and the changes (save, use, url, key_env, start), show the user the returned `diff` (and anything another runner has loaded), and only after they confirm in this conversation call it again without `preview`. ' +
      'It writes only runner lines of ~/.claude/consult.local.md (the global file), keeping everything else, after copying the file to consult.local.md.bak.',
    inputSchema: {
      type: 'object',
      properties: {
        runner: { type: 'string', enum: [...RUNNER_TYPES], description: 'The runner to set up; default: the one in use.' },
        save: {
          type: 'object',
          description: 'The confirmed nicknames for that runner, e.g. {"default": "qwen3.6-35b-a3b", "fast": "qwen3.5-4b", "big": null}. Keys: default, fast, vision, vision-best, big; null removes one.',
          additionalProperties: { type: ['string', 'null'] }
        },
        use: { type: 'boolean', description: 'Make this runner the one in use (writes `local_runner`).' },
        url: { type: 'string', description: 'The runner\'s address, e.g. http://127.0.0.1:9292/v1, when it isn\'t the standard one.' },
        key_env: { type: 'string', description: 'The NAME of the environment variable holding the runner\'s key (never the key itself), e.g. LLAMA_SWAP_API_KEY.' },
        start: { type: 'string', description: 'How the user starts this runner, shown in "not running" errors; never executed.' },
        preview: { type: 'boolean', description: 'Return the diff of the settings file and write nothing.' }
      }
    }
  },
  {
    name: 'local_unload',
    description:
      'Unload the models a local runner has in memory (Ollama: each loaded model; llama-swap: /unload). Call it ONLY after the user agreed in this conversation, ' +
      'e.g. when local_status or /consult:setlocal shows another runner holding a model. Nothing is lost but a reload.',
    inputSchema: {
      type: 'object',
      properties: {
        runner: { type: 'string', enum: [...RUNNER_TYPES], description: 'The runner to unload.' }
      },
      required: ['runner']
    }
  },
  {
    name: 'codex_login_status',
    description:
      'Check whether the Codex CLI is currently authenticated. Fast (no network call to OpenAI required). ' +
      'Because it only inspects the stored credentials, it can report authenticated: true while the token is expired or revoked - if ask_codex then fails with a token-refresh error, trust that failure and offer codex_login_start.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'codex_login_start',
    description:
      'Start a Codex device-flow login. Spawns `codex login --device-auth` in the background, captures the verification URL, and returns it. ' +
      'The user opens the URL in a browser to authenticate. After they finish, call `codex_login_status` to confirm. ' +
      'Use it when the user asks to log in, or after codex_login_status reports unauthenticated - it starts a flow the user has to finish in a browser.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'gemini_auth_status',
    description:
      'Check whether the Gemini CLI is currently authenticated by sending a tiny ping prompt. ' +
      'If unauthenticated, the response includes a hint - Gemini has no headless login flow; the user must run `gemini` interactively in a terminal once.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'consult_chat_start',
    description:
      'Start a multi-turn chat session with Codex, Antigravity (agy) or the legacy Gemini CLI. Returns the first response + a `session_id` to use on follow-up turns via `consult_chat_send`. ' +
      'Use when the user wants an ongoing back-and-forth with one external model (e.g., "have a chat with codex about X"), as opposed to a single-shot ask. ' +
      'Each CLI keeps the conversation state on disk; consult relays the session id. Codex runs in a read-only sandbox and Gemini in plan mode, but agy is NOT read-only: it can edit files in directories the user trusts in agy, so phrase agy turns as questions (every turn gets the same answer-only preamble as ask_agy).',
    inputSchema: {
      type: 'object',
      properties: {
        participant: { type: 'string', enum: ['codex', 'agy', 'gemini'], description: 'Which external CLI to chat with. Prefer "agy" over "gemini" for Google models - the legacy gemini CLI no longer works on individual accounts.' },
        prompt: { type: 'string', description: 'First message in the chat.' },
        model: { type: 'string', description: 'Optional model override. Same caveats as ask_codex / ask_gemini - omit to use CLI default.' },
        reasoning_effort: { type: 'string', enum: [...REASONING_EFFORTS], description: 'Codex or agy. Optional reasoning effort, model-dependent: agy takes low..max, codex also ultra; an unsupported level fails with a clear error.' },
        run_hooks: { type: 'boolean', description: "Codex only. Run the user's own codex hooks (~/.codex/hooks.json) on this call. Default: the `codex_hooks` setting, which is false - consult passes --disable hooks, because hooks are written for interactive sessions and a Stop hook can make codex keep working after its answer is done. Set true only when the user asks for their hooks to run (e.g. they want a hook-driven review pass); the result reports `hooks_ran`." },
        timeout_s: TIMEOUT_S_PROP
      },
      required: ['participant', 'prompt']
    }
  },
  {
    name: 'consult_chat_send',
    description:
      'Send a follow-up message to an existing chat session. Requires `session_id` returned by an earlier `consult_chat_start` call (or by a previous `consult_chat_send`). ' +
      'The participant CLI replays its stored conversation history and appends this message - prior turns are remembered without resending them. ' +
      'Token cost grows with conversation length because the CLI sends the full history to the model under the hood.',
    inputSchema: {
      type: 'object',
      properties: {
        participant: { type: 'string', enum: ['codex', 'agy', 'gemini'], description: 'Same participant as the start call. Cannot be changed mid-session.' },
        session_id: { type: 'string', description: 'Session id returned by consult_chat_start (or by a previous consult_chat_send).' },
        prompt: { type: 'string', description: 'Next message in the chat.' },
        run_hooks: { type: 'boolean', description: "Codex only. Run the user's own codex hooks (~/.codex/hooks.json) on this turn (each turn chooses independently). Default: the `codex_hooks` setting, which is false - consult passes --disable hooks, because hooks are written for interactive sessions and a Stop hook can make codex keep working after its answer is done. Set true only when the user asks for their hooks to run (e.g. they want a hook-driven review pass); the result reports `hooks_ran`." },
        timeout_s: TIMEOUT_S_PROP
      },
      required: ['participant', 'session_id', 'prompt']
    }
  },
  {
    name: 'consult_chat_end',
    description:
      'Delete a chat session from disk, freeing space and removing the conversation transcript. ' +
      'Optional - sessions age out naturally and disk usage is small. Call this when the user explicitly says "end the chat", "delete the session", or wants to forget the conversation. ' +
      'Returns the number of files removed; 0 means the session was already gone (aged out, never existed, or stored under a different project for gemini).',
    inputSchema: {
      type: 'object',
      properties: {
        participant: { type: 'string', enum: ['codex', 'agy', 'gemini'], description: 'Which CLI owns the session being deleted. Worth calling for agy: it stores ~600KB+ per conversation (SQLite db + a brain/ directory), far more than the other providers.' },
        session_id: { type: 'string', description: 'The session id returned by consult_chat_start / consult_chat_send.' }
      },
      required: ['participant', 'session_id']
    }
  },
  {
    name: 'council_vote',
    description:
      'Run a tournament: send `prompt` to every participant (default Claude, Codex and Antigravity; 2-5 via `participants`) in parallel as fresh subprocesses; anonymize the answers as A, B, C...; ask each participant to rank all of them; aggregate via Borda count; return the winner. ' +
      'Use this when the user wants several models to compete and vote on one answer. For a plain side-by-side second opinion, call ask_codex and ask_agy instead - a council costs twice the calls. ' +
      'Cost: 2 calls per participant (one answer, one ranking - 6 for the default three), plus one retry for any judge whose ranking does not parse. Latency: 30-60s typically. Each call uses fresh process state - no shared memory between rounds. ' +
      'Returns winner + Borda scores by default (compact). On tie, returns all candidates so the user can choose. With verbose=true, also returns full candidate texts and per-judge rankings.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to all participants.' },
        images: { type: 'array', items: { type: 'string' }, description: 'Optional list of image file paths to attach (absolute paths, or relative to the session cwd). PNG, JPEG, GIF, WebP - validated by file signature, not extension. Use for screenshots, diagrams, UI mockups, error dialogs, or any question that needs the model to SEE something. Sent to every participant, so each judges the same visual evidence. Note the cost multiplies with the participant count.' },
        participants: {
          type: 'array',
          items: { type: 'string', enum: ['claude', 'codex', 'agy', 'gemini', 'local'] },
          description:
            'Optional participant list. Default: ["claude","codex","agy"]. Useful when one CLI is rate-limited. ' +
            '"gemini" and "local" are opt-in only, never defaults. "gemini" is the legacy CLI and fails on individual accounts (use "agy" instead). ' +
            '"local" needs a local runner (/consult:setlocal, or `local_model`) - add it for a free extra voice, or use ["local"] plus one other for a near-free tournament. ' +
            'Small local models often fail the strict ranking format; the council drops those votes and continues, so prefer a 9B+ local model when using it as a judge.'
        },
        use_bare: { type: 'boolean', description: 'Override the bare-mode auto-detect for the Claude participant. true = force --bare (requires ANTHROPIC_API_KEY env var; cheaper). false = force non-bare (subscription/OAuth auth ok; heavier). Omit to auto-detect: bare iff ANTHROPIC_API_KEY is set.' },
        run_hooks: { type: 'boolean', description: "Applies to the codex participant only (generation and judging). Run the user's own codex hooks; default is the `codex_hooks` setting (false)." },
        verbose: { type: 'boolean', description: 'If true, include full candidate texts and per-judge rankings in the result. Default false (compact: winner + scores only). Tied results always include candidate texts regardless of this flag.' },
        timeout_s: TIMEOUT_S_PROP
      },
      required: ['prompt']
    }
  },
  ...(DELEGATE_ENABLED ? DELEGATE_TOOLS : [])
];

// MCP tool annotations (spec 2025-03-26+). Hints only -- clients use them to
// decide what to auto-approve and how to label the tool -- but they are the
// truth here: every ask/status tool is a pure read, chat_end deletes files,
// and codex_login_start opens a browser flow that outlives the call.
const ANNOTATIONS = {
  read:      { readOnlyHint: true,  destructiveHint: false, idempotentHint: false, openWorldHint: true  },
  status:    { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  chat:      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  },  // writes a session file
  chat_end:  { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false },
  login:     { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  },
  generate:  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  },  // writes new image files
  settings_write: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, // rewrites runner lines
  unload:    { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false }, // frees a runner's memory
  delegate_start:   { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }, // starts a worker (and may make a copy)
  delegate_read:    { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false },
  delegate_result:  { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false }, // marks the task seen, removes an empty copy and its branch
  delegate_merge:   { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }, // writes the user's working files
  delegate_control: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  }  // send resumes a worker; cancel stops one
};
const TOOL_META = {
  ask_codex:          ['Ask Codex (OpenAI)',            'read'],
  ask_agy:            ['Ask Antigravity (Google)',      'read'],
  agy_generate_image: ['Generate image (Antigravity)',  'generate'],
  codex_generate_image: ['Generate image (Codex)',       'generate'],
  agy_status:         ['Antigravity status',            'status'],
  ask_gemini:         ['Ask Gemini CLI (legacy)',       'read'],
  ask_local:          ['Ask local model',               'read'],
  local_status:       ['Local runner status',           'status'],
  local_setup:        ['Set up local runners',          'settings_write'],
  local_unload:       ['Unload a local runner',         'unload'],
  codex_login_status: ['Codex login status',            'status'],
  codex_login_start:  ['Start Codex login',             'login'],
  gemini_auth_status: ['Gemini auth status',            'status'],
  consult_chat_start: ['Start multi-turn chat',         'chat'],
  consult_chat_send:  ['Continue multi-turn chat',      'chat'],
  consult_chat_end:   ['End chat and delete session',   'chat_end'],
  council_vote:       ['Council vote (multi-model)',    'read'],
  ...DELEGATE_TOOL_META
};
for (const t of TOOLS) {
  const meta = TOOL_META[t.name];
  if (!meta) throw new Error(`TOOL_META missing entry for ${t.name}`);
  t.title = meta[0];
  t.annotations = { title: meta[0], ...ANNOTATIONS[meta[1]] };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Fire-and-forget log append. Async to keep the request handler off the disk:
// when `log_calls` is enabled and the server gets concurrent tool calls, sync
// appends would serialise the event loop. Errors surface to stderr; the tool
// response is unaffected.
let logDirReady = false;
function appendLog(settings, entry) {
  if (!settings.log_calls) return;
  const logPath = path.join(os.homedir(), '.claude', 'consult-log.jsonl');
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  const write = () => fs.appendFile(logPath, line, 'utf8', (err) => {
    if (err) process.stderr.write(`[consult] log write failed: ${err.message}\n`);
  });
  if (logDirReady) return write();
  fs.mkdir(path.dirname(logPath), { recursive: true }, (err) => {
    if (err) { process.stderr.write(`[consult] log mkdir failed: ${err.message}\n`); return; }
    logDirReady = true;
    write();
  });
}

function asText(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

// Dispatch tables for the polymorphic chat tools. Schema enum on `participant`
// rejects bad values at the MCP boundary, but we still throw a clear error
// here if a CHAT_FNS lookup misses -- defense-in-depth, and clearer than a
// TypeError from `undefined(...)`.
const CHAT_FNS = {
  start: { codex: codexChatStart, agy: agyChatStart, gemini: geminiChatStart },
  send:  { codex: codexChatSend,  agy: agyChatSend,  gemini: geminiChatSend  },
  end:   { codex: codexChatEnd,   agy: agyChatEnd,   gemini: geminiChatEnd   }
};

const CHAT_PARTICIPANTS = Object.keys(CHAT_FNS.start);

// local_status with Ollama's facts: each model's detail, the VRAM it was
// judged against, and the saved nicknames, each marked installed or not.
function withModelDetail(status, live, settings) {
  if (!status.reachable || live.facts === null) return status;
  const saved = savedNicknames(settings);
  const nicknames = {};
  const hints = [];
  for (const [role, name] of Object.entries(saved)) {
    if (typeof name !== 'string') continue;
    let resolved = null;
    try { resolved = resolveModel(role === 'default' ? null : role, live.facts, saved); } catch (e) { hints.push(e.message); }
    nicknames[role] = { model: name, installed: resolved !== null && !resolved.quant_swapped, replacement: resolved?.quant_swapped ? resolved.model : null };
  }
  const out = { ...status, models_detail: live.facts, vram_mb: live.vram_mb, nicknames };
  if (hints.length) out.hint = [status.hint, ...hints].filter(Boolean).join(' ');
  // The configured model may be a nickname or another quant now: judge it by the resolver, not by name.
  if ('configured_model_available' in out) {
    out.configured_model_available = nicknames.default ? nicknames.default.installed || nicknames.default.replacement !== null : out.configured_model_available;
    if (out.configured_model_available && typeof status.hint === 'string' && status.hint.startsWith('Configured')) out.hint = hints.join(' ') || undefined;
  }
  return out;
}

function chatStartArgs(participant, args, settings, callTimeoutMs) {
  if (participant === 'codex') {
    return {
      prompt: args.prompt,
      model: args.model ?? settings.codex_model,
      reasoning_effort: args.reasoning_effort ?? settings.codex_reasoning_effort,
      sandbox: settings.codex_sandbox,
      run_hooks: codexRunHooks(args.run_hooks, settings),
      timeout_ms: callTimeoutMs ?? codexTimeoutMs(settings)
    };
  }
  if (participant === 'agy') {
    return {
      prompt: args.prompt,
      model: args.model ?? settings.agy_model,
      effort: args.reasoning_effort ?? settings.agy_effort,
      timeout_ms: callTimeoutMs ?? settings.agy_timeout_ms ?? settings.timeout_ms
    };
  }
  return {
    prompt: args.prompt,
    model: args.model ?? settings.gemini_model,
    approval_mode: settings.gemini_approval_mode,
    timeout_ms: callTimeoutMs ?? settings.timeout_ms
  };
}

function chatSendArgs(participant, args, settings, callTimeoutMs) {
  if (participant === 'codex') {
    return { session_id: args.session_id, prompt: args.prompt, run_hooks: codexRunHooks(args.run_hooks, settings), timeout_ms: callTimeoutMs ?? codexTimeoutMs(settings) };
  }
  if (participant === 'agy') {
    return {
      session_id: args.session_id,
      prompt: args.prompt,
      timeout_ms: callTimeoutMs ?? settings.agy_timeout_ms ?? settings.timeout_ms
    };
  }
  return {
    session_id: args.session_id,
    prompt: args.prompt,
    approval_mode: settings.gemini_approval_mode,
    timeout_ms: callTimeoutMs ?? settings.timeout_ms
  };
}

function pickChatFn(op, participant) {
  const fn = CHAT_FNS[op]?.[participant];
  if (!fn) throw new Error(`Unknown participant: ${participant}. Expected one of: ${CHAT_PARTICIPANTS.join(', ')}.`);
  return fn;
}

// A provider failing is a TOOL result, not a protocol error. Thrown out of
// the handler, the error became a JSON-RPC error (-32603) and the caller got a
// bare message string; returned with isError the calling model sees it as the
// tool's output and can act on it (MCP spec: tool execution errors belong in
// the result). Unknown tools stay protocol errors.
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  try {
    return await callContext.run({ signal: extra.signal }, () => callTool(req, extra));
  } catch (e) {
    if (e?.unknownTool) throw e;
    return { isError: true, content: [{ type: 'text', text: scrubPii(String(e?.message ?? e)) }] };
  }
});

// Settings warnings go to stderr (the MCP server log) once per change of
// what they say, and into local_status / local_setup results every time.
let lastWarnings = '';
function noteSettingsWarnings(settings) {
  const text = (settings._warnings ?? []).join('\n');
  if (text === lastWarnings) return;
  lastWarnings = text;
  for (const warning of settings._warnings ?? []) process.stderr.write(`[consult] settings: ${warning}\n`);
}

// MCP progress for a local call, when the caller asked for it.
function localProgress(extra, model, description) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || typeof extra?.sendNotification !== 'function') return null;
  const about = description ? ` -- ${description}` : '';
  return ({ phase, tokens }) => {
    const message = phase === 'waiting' ? `waiting for ${model} (loading or reading the prompt)${about}` : `${tokens} token${tokens === 1 ? '' : 's'} so far`;
    extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: tokens, message } }).catch(() => {});
  };
}

// This server's id: its heartbeat file in the delegate data folder is named by it,
// and a delegated task records it as its owner.
const instanceId = randomUUID();

// What the delegate tools need to know about the call: the session's project
// (Claude Code sets CLAUDE_PROJECT_DIR; the server's cwd is the fallback) and session.
function delegateContext(settings) {
  return {
    settings,
    project: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    instanceId
  };
}

// The runner for a local call: `runner` when given (a type, never an
// address), else the one in use.
function chosenRunner(settings, requested) {
  if (requested === undefined || requested === null || requested === '') return runnerSettings(settings);
  return runnerFor(settings, requested);
}

async function askOnRunner({ runner, settings, args, callTimeoutMs, extra }) {
  const { api_key, key_env } = await runnerKey(runner);
  const inventory = await runnerInventory(runner, api_key, settings);
  const prepared = prepareRunnerCall({ runner, requested: args.model, images: args.images, settings, callTimeoutMs, inventory });
  await guardOneShot({ runner, model: prepared.model, key: api_key, settings, inventory });
  let description = null;
  if (Array.isArray(inventory)) {
    for (const fact of inventory) {
      if (fact && typeof fact === 'object' && fact.id === prepared.model && fact.description) description = fact.description;
    }
  }
  const ask = (key) => askLocal({
    prompt: args.prompt,
    model: prepared.model,
    base_url: runner.url,
    api_key: key,
    key_env,
    runner_label: runner.type,
    start_hint: runner.start,
    temperature: args.temperature ?? settings.local_temperature,
    reasoning_effort: args.reasoning_effort ?? settings.local_reasoning_effort,
    images: args.images,
    image_max_edge: settings.local_image_max_edge,
    timeout_ms: prepared.timeout_ms,
    onProgress: localProgress(extra, prepared.model, description),
    record_speed: true
  });
  try {
    return { ...(await ask(api_key)), ...prepared.notes };
  } catch (error) {
    // A key changed in the user environment since it was cached: read it again, once.
    if (error?.status === 401 && key_env) {
      forgetCachedKey(key_env);
      const again = await runnerKey(runner);
      if (again.api_key && again.api_key !== api_key) return { ...(await ask(again.api_key)), ...prepared.notes };
    }
    if (error?.code === 'images_refused') {
      const seeing = seeingModels(inventory);
      throw new Error(`${error.message}. Models known to read images: ${seeing.length ? seeing.join(', ') : 'none listed'}.`);
    }
    throw error;
  }
}

// local_status for one runner: Ollama and the 0.11.0 path as before (with
// Ollama's facts), llama-swap from its own endpoints, others by name.
async function runnerStatus(runner, settings) {
  let key;
  try { key = await runnerKey(runner); }
  catch (error) { return { reachable: false, url: runner.url, reason: 'bad_config', details: error.message }; }
  if (runner.type === 'llama-swap') return swapStatus(runner, key.api_key);
  const status = await localStatus({ base_url: runner.url, api_key: key.api_key, configured_model: runner.nicknames.default });
  if (runner.type === null || runner.type === 'ollama') {
    const ollamaView = asOllamaSettings({ ...settings, local_base_url: runner.url }, runner.nicknames);
    return withModelDetail(status, await liveFacts(ollamaView), ollamaView);
  }
  return status;
}

async function callTool(req, extra) {
  const { name, arguments: args = {} } = req.params;
  const settings = loadSettings();
  noteSettingsWarnings(settings);
  // The delegate tools take no per-call `timeout_s` of the ask tools' kind (delegate_wait has its own, 1-1800 s).
  if (DELEGATE_ENABLED && DELEGATE_TOOL_NAMES.includes(name)) return callDelegateTool(name, args, delegateContext(settings));
  const callTimeoutMs = timeoutMsFromSeconds(args.timeout_s);

  switch (name) {
    case 'ask_codex': {
      const result = await askCodex({
        prompt: args.prompt,
        model: args.model ?? settings.codex_model,
        reasoning_effort: args.reasoning_effort ?? settings.codex_reasoning_effort,
        sandbox: settings.codex_sandbox,
        images: args.images,
        run_hooks: codexRunHooks(args.run_hooks, settings),
        timeout_ms: callTimeoutMs ?? codexTimeoutMs(settings)
      });
      appendLog(settings, { tool: 'ask_codex', model: result.model, latency_ms: result.latency_ms, prompt_len: args.prompt.length, response_len: result.response.length, images: args.images?.length ?? 0 });
      return asText(result);
    }
    case 'ask_gemini': {
      const result = await askGemini({
        prompt: args.prompt,
        model: args.model ?? settings.gemini_model,
        approval_mode: settings.gemini_approval_mode,
        timeout_ms: callTimeoutMs ?? settings.timeout_ms
      });
      appendLog(settings, { tool: 'ask_gemini', model: result.model, latency_ms: result.latency_ms, prompt_len: args.prompt.length, response_len: result.response.length });
      return asText(result);
    }
    case 'ask_agy': {
      const result = await askAgy({
        prompt: args.prompt,
        model: args.model ?? settings.agy_model,
        effort: args.effort ?? settings.agy_effort,
        images: args.images,
        timeout_ms: callTimeoutMs ?? settings.agy_timeout_ms ?? settings.timeout_ms
      });
      appendLog(settings, {
        tool: 'ask_agy', model: result.model, latency_ms: result.latency_ms,
        prompt_len: args.prompt.length, response_len: result.response.length,
        tokens: result.tokens
      });
      return asText(result);
    }
    case 'agy_generate_image': {
      const result = await agyGenerateImage({
        prompt: args.prompt,
        model: args.model ?? settings.agy_model,
        effort: settings.agy_effort,
        images: args.images,
        output_dir: args.output_dir ?? settings.agy_image_dir,
        serverDir: __dirname,
        aspect_ratio: args.aspect_ratio,
        tier: args.tier,
        count: args.count,
        exact_prompt: args.exact_prompt,
        settings,
        timeout_ms: callTimeoutMs,
        base_timeout_ms: settings.agy_image_timeout_ms
      });
      appendLog(settings, {
        tool: 'agy_generate_image', model: result.model, latency_ms: result.latency_ms,
        prompt_len: args.prompt.length, images_out: result.images.length, tokens: result.tokens
      });
      return asText(result);
    }
    case 'codex_generate_image': {
      const result = await codexGenerateImage({
        prompt: args.prompt,
        model: args.model ?? settings.codex_model,
        images: args.images,
        output_dir: args.output_dir ?? settings.codex_image_dir,
        serverDir: __dirname,
        aspect_ratio: args.aspect_ratio,
        transparent_background: args.transparent_background,
        count: args.count,
        exact_prompt: args.exact_prompt,
        settings,
        timeout_ms: callTimeoutMs,
        base_timeout_ms: settings.codex_image_timeout_ms
      });
      appendLog(settings, {
        tool: 'codex_generate_image', model: result.model, latency_ms: result.latency_ms,
        prompt_len: args.prompt.length, images_out: result.images.length
      });
      return asText(result);
    }
    case 'agy_status': {
      return asText(await agyStatus());
    }
    case 'ask_local': {
      // The address and key come from settings only -- deliberately not tool
      // arguments. They name a network destination, and a prompt-injected
      // caller must not be able to choose where prompts go. `runner` picks
      // among configured runners by type, never by address.
      const runner = chosenRunner(settings, args.runner);
      if (args.runner) {
        const inUse = runnerSettings(settings);
        if (inUse.type && inUse.type !== runner.type) {
          await checkDoubleLoad({ requested: runner.type, inUse, key: (await runnerKey(inUse).catch(() => ({ api_key: null }))).api_key });
        }
      }
      const result = await askOnRunner({ runner, settings, args, callTimeoutMs, extra });
      appendLog(settings, {
        tool: 'ask_local', model: result.model, latency_ms: result.latency_ms,
        prompt_len: args.prompt.length, response_len: result.response.length,
        tokens: result.tokens, reasoning_chars: result.reasoning_chars
      });
      return asText(result);
    }
    case 'local_status': {
      const runner = chosenRunner(settings, args.runner);
      const status = await runnerStatus(runner, settings);
      const others = await otherRunners({ configured: configuredRunners(settings), exceptUrl: runner.url });
      return asText({
        runner: runner.type ?? 'local_base_url (no local_runner set)',
        ...status,
        other_runners: others,
        settings_warnings: settings._warnings ?? []
      });
    }
    case 'local_setup': {
      return asText(await setupLocal(args, settings));
    }
    case 'local_unload': {
      return asText(await unloadLocal(args.runner, settings));
    }
    case 'codex_login_status': {
      return asText(await codexLoginStatus());
    }
    case 'codex_login_start': {
      const info = await codexLoginStart();
      return asText({
        url: info.url,
        instructions: 'Open the URL above in a browser and complete authentication. Then call `codex_login_status` to confirm. The codex login process is running in the background.',
        // Raw CLI output crosses the same trust boundary as every other
        // surfaced stderr -- scrub it. The device-flow URL itself survives
        // (it matches no secret pattern) so the instructions stay actionable.
        raw_preview: scrubPii(info.raw)
      });
    }
    case 'gemini_auth_status': {
      // geminiAuthCheck now supplies a reason-specific hint. Don't overwrite it
      // with the generic "run gemini interactively" advice -- that is wrong for
      // e.g. ineligible_tier, where re-authenticating cannot possibly help.
      return asText(await geminiAuthCheck({ timeout_ms: 30000 }));
    }
    case 'consult_chat_start': {
      const p = args.participant;
      const fn = pickChatFn('start', p);
      const result = await fn(chatStartArgs(p, args, settings, callTimeoutMs));
      appendLog(settings, { tool: 'consult_chat_start', participant: p, model: result.model, latency_ms: result.latency_ms, prompt_len: args.prompt.length, response_len: result.response.length, session_id: result.session_id });
      return asText({ ...result, participant: p });
    }
    case 'consult_chat_send': {
      const p = args.participant;
      const fn = pickChatFn('send', p);
      const result = await fn(chatSendArgs(p, args, settings, callTimeoutMs));
      appendLog(settings, { tool: 'consult_chat_send', participant: p, model: result.model, latency_ms: result.latency_ms, prompt_len: args.prompt.length, response_len: result.response.length, session_id: result.session_id });
      return asText({ ...result, participant: p });
    }
    case 'consult_chat_end': {
      const p = args.participant;
      const fn = pickChatFn('end', p);
      const result = await fn({ session_id: args.session_id });
      appendLog(settings, { tool: 'consult_chat_end', participant: p, session_id: result.session_id, deleted: result.deleted });
      return asText(result);
    }
    case 'council_vote': {
      const result = await councilVote({
        prompt: args.prompt,
        images: args.images,
        participants: args.participants,
        use_bare: args.use_bare,
        verbose: args.verbose,
        // The council reads hooks from settings; fold the per-call choice in.
        settings: { ...settings, codex_hooks: codexRunHooks(args.run_hooks, settings) },
        timeout_ms: callTimeoutMs
      });
      appendLog(settings, {
        tool: 'council_vote',
        winner_model: result.winner_model,
        tied: result.tied,
        degraded: result.degraded,
        latency_ms: result.total_latency_ms,
        prompt_len: args.prompt.length
      });
      return asText(result);
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { unknownTool: true });
  }
}

// One line to stderr, which hosts write to their MCP log (Claude Desktop:
// %APPDATA%\Claude\logs\mcp-server-<name>.log). It answers the questions a
// launch problem raises: which copy of the server is running, from which cwd,
// and on which Node.
process.stderr.write(
  `[consult] ${pkg.version} started: ${fileURLToPath(import.meta.url)} cwd=${process.cwd()} node=${process.version}\n`
);

const transport = new StdioServerTransport();
await server.connect(transport);

// The heartbeat tells a delegate supervisor that this session is alive; the
// sweeps run once now and then every minute. Each is guarded, none can crash the
// server. CONSULT_DELEGATE_TEST_NO_SWEEP=1 (the test servers) keeps only the heartbeat.
if (DELEGATE_ENABLED) {
  startDelegateBackground({
    instanceId, sessionId: process.env.CLAUDE_CODE_SESSION_ID || null, project: process.env.CLAUDE_PROJECT_DIR || process.cwd(), sweeps: process.env.CONSULT_DELEGATE_TEST_NO_SWEEP !== '1'
  });
}
