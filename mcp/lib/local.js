// Local / self-hosted model provider. Unlike codex/gemini/claude this one is
// pure HTTP -- there is no CLI to spawn, so none of the spawn-cli.js machinery
// (shell shims, tree-kill, EPIPE guards) applies.
//
// Speaks the OpenAI-compatible `/v1/chat/completions` API, which every common
// local runner implements:
//
//   Ollama          http://127.0.0.1:11434/v1
//   LM Studio       http://127.0.0.1:1234/v1
//   llama.cpp       http://127.0.0.1:8080/v1   (llama-server)
//   llama-swap      no standard port (often 9292, or 8080 when started bare)
//   vLLM            http://127.0.0.1:8000/v1
//
// One client covers all of them (and any remote OpenAI-compatible endpoint),
// which is why this isn't an Ollama-specific module. Which runner is in use,
// its key and its nicknames are local-runners.js's business.
//
// `base_url` is deliberately NOT a per-call tool argument -- it comes from
// settings only. It names a network destination, and letting the model choose
// it would turn a prompt injection into a data-exfiltration primitive.

import { requireString, scrubPii, callSignal, timeoutRetryHint, incompleteError } from './util.js';
import { loadImages, prepareImagesForLocal, DEFAULT_MAX_EDGE } from './image.js';
import { recordSpeed } from './local-speeds.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

// Mirrors spawn-cli.js's BUFFER_CAP. A misbehaving runner (or a model stuck in
// a repetition loop) can stream indefinitely; without a cap we'd OOM the MCP
// server before the timeout fires.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Reasoning models emit chain-of-thought that must not reach the caller: a
// council judge would read the reasoning as the answer, and `parseRanking`
// would fail on it. Runners expose it three different ways, so we handle all
// three (verified against Ollama 0.30.7 + qwen3.5, which uses `reasoning`):
//
//   message.reasoning          Ollama's OAI shim
//   message.reasoning_content  DeepSeek-style, vLLM
//   <think>...</think> inline  LM Studio / llama.cpp, which don't split it out
const THINK_BLOCK_RE = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
// An unclosed opener means generation was cut mid-reasoning (hit max_tokens).
// Everything after it is chain-of-thought with no answer -- drop the remainder.
const UNCLOSED_THINK_RE = /<(think|thinking|reasoning)>[\s\S]*$/i;

export function stripReasoning(text) {
  if (typeof text !== 'string') return '';
  return text.replace(THINK_BLOCK_RE, '').replace(UNCLOSED_THINK_RE, '').trim();
}

// Pull the answer out of a choices[0].message, separating it from reasoning.
// Returns { response, reasoning } -- reasoning is surfaced for observability
// (it explains latency and token spend) but never mixed into the response.
export function extractMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('response choice has no message object');
  }
  const raw = typeof message.content === 'string' ? message.content : '';
  const separate = message.reasoning ?? message.reasoning_content ?? null;
  const response = stripReasoning(raw);
  return {
    response,
    reasoning: typeof separate === 'string' && separate.trim() ? separate : null
  };
}

// `none` is the meaningful one on Ollama today; the rest pass through for
// runners that implement the full OpenAI tiering. Kept separate from util.js's
// validateReasoningEffort, which is Codex's low|medium|high and has no `none`.
export const LOCAL_REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high']);

export function validateLocalReasoningEffort(effort) {
  if (effort && !LOCAL_REASONING_EFFORTS.includes(effort)) {
    throw new Error(
      `Invalid local reasoning_effort: ${JSON.stringify(effort)}. Allowed: ${LOCAL_REASONING_EFFORTS.join(' | ')}`
    );
  }
}

export function validateBaseUrl(base_url) {
  let u;
  try { u = new URL(base_url); }
  catch (_) { throw new Error(`Invalid local_base_url: ${JSON.stringify(base_url)}. Expected an absolute http(s) URL.`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`local_base_url must be http or https, got ${JSON.stringify(u.protocol)}.`);
  }
  return u;
}

// True for addresses that never leave the machine: a literal IPv4 address in
// 127.0.0.0/8, ::1, or localhost (a trailing dot allowed). Nothing else -- not
// a name that merely starts with "127." (127.example.com resolves anywhere),
// and not 0.0.0.0, which is "every interface", not "this machine". Used by
// settings.js to warn when a PROJECT-scoped config points the provider at a
// remote host, and to decide where a key from the environment may be sent.
export function isLoopback(base_url) {
  let u;
  try { u = new URL(base_url); } catch (_) { return false; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === 'localhost.' || host === '::1') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;
  for (let index = 1; index <= 3; index++) {
    if (Number(octets[index]) > 255) return false;
  }
  return true;
}

function joinUrl(base_url, suffix) {
  return `${String(base_url).replace(/\/+$/, '')}${suffix}`;
}

function authHeaders(api_key) {
  // Ollama and llama.cpp ignore auth entirely; LM Studio and vLLM may require
  // it. Always send a placeholder -- some OpenAI SDK-compatible servers reject
  // a request with no Authorization header at all.
  return { Authorization: `Bearer ${api_key || 'not-needed'}` };
}

// How to start each kind of runner, when the settings give no `start` hint.
const USUAL_START = Object.freeze({
  ollama: '`ollama serve`, or the Ollama app',
  'llama-swap': 'llama-swap (your start script or shortcut), or set `llama-swap.start` to show the command here',
  lmstudio: "LM Studio's local server",
  'llama-server': 'llama-server'
});

// The messages a call and local_status (swapStatus in local-runners.js) share
// for a runner that isn't listening or wants a key, so each says one thing.
export function notListeningMessage(base_url, runner_label, start_hint = null) {
  const how = start_hint || USUAL_START[runner_label] || 'the runner';
  return `No local model runner is listening at ${base_url} (${runner_label}). Start it: ${how}.`;
}

export function needsKeyMessage(base_url, runner_label) {
  return `${runner_label} at ${base_url} needs its key: add \`${runner_label}.key_env: <NAME>\` to ~/.claude/consult.local.md ` +
    '(the name of the environment variable that holds the key), or run /consult:setlocal.';
}

export function keyRejectedMessage(base_url, runner_label, key_env) {
  return `${runner_label} at ${base_url} rejected the key from ${key_env ?? 'local_api_key'}. Check that the variable holds the runner's current key.`;
}

export function keyMissingMessage(key_env) {
  return `The environment variable ${key_env} is not set (checked this process and your user environment). Set it, then try again.`;
}

// Turn transport-level failures into messages that name the fix. The dominant
// failure here is "the runner isn't running", which a raw fetch TypeError
// ("fetch failed") does nothing to convey.
function describeFetchError(err, base_url, { runner_label = null, start_hint = null } = {}) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return { kind: 'timeout', message: null }; // caller has the duration
  }
  const cause = err?.cause?.code || err?.code || '';
  if (cause === 'ECONNREFUSED') {
    if (runner_label) return { kind: 'unreachable', message: notListeningMessage(base_url, runner_label, start_hint) };
    return {
      kind: 'unreachable',
      message: `No local model runner is listening at ${base_url}. Start one (e.g. \`ollama serve\`, or launch LM Studio's server) or fix \`local_base_url\`.`
    };
  }
  // A request that carries a key never follows a redirect: the key could go
  // off this machine with it.
  if (/redirect/i.test(String(err?.cause?.message ?? '')) || /redirect/i.test(String(err?.message ?? ''))) {
    return { kind: 'unknown', message: `The runner at ${base_url} answered with a redirect, which consult does not follow for a request that carries a key.` };
  }
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
    return { kind: 'unreachable', message: `Cannot resolve the host in ${base_url} (${cause}). Check \`local_base_url\`.` };
  }
  if (cause === 'ECONNRESET' || cause === 'EPIPE') {
    return { kind: 'unreachable', message: `Connection to ${base_url} dropped (${cause}). The runner may have crashed or run out of memory loading the model.` };
  }
  return { kind: 'unknown', message: `Request to ${base_url} failed: ${err?.message || String(err)}` };
}

// HTTP-level failures. 404 is overwhelmingly "model not pulled", which is
// worth naming explicitly since the fix is a single command.
function describeHttpError(status, bodyText, { base_url, model, runner_label = null, has_key = false, key_env = null }) {
  const tail = scrubPii(String(bodyText || '').slice(0, 500));
  if (status === 404) {
    if (runner_label && runner_label !== 'ollama') {
      return `Model ${JSON.stringify(model)} is not available at ${base_url} (${runner_label}). Call \`local_status\` for the models it lists, or run /consult:setlocal. Server said: ${tail}`;
    }
    return `Model ${JSON.stringify(model)} is not available at ${base_url}. Pull it first (\`ollama pull ${model}\`) or set \`local_model\` to one you have. Server said: ${tail}`;
  }
  if ((status === 401 || status === 403) && runner_label) {
    return has_key ? keyRejectedMessage(base_url, runner_label, key_env) : needsKeyMessage(base_url, runner_label);
  }
  if (status === 401 || status === 403) {
    return `Local runner at ${base_url} rejected the request (${status}). If it requires a key, set \`local_api_key\`. Server said: ${tail}`;
  }
  if (status === 400) {
    return `Local runner rejected the request (400). Often an unsupported parameter for this model/runner. Server said: ${tail}`;
  }
  if (status >= 500) {
    return `Local runner at ${base_url} errored (${status}). Common causes: model too large for available VRAM/RAM, or the runner crashed mid-load. Server said: ${tail}`;
  }
  return `Local runner at ${base_url} returned HTTP ${status}. Server said: ${tail}`;
}

// Read a response body with a hard byte ceiling. `response.text()` is
// unbounded, so we stream and abort past the cap.
export async function readCapped(response, cap = MAX_RESPONSE_BYTES) {
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw new Error(`Local runner response exceeded ${cap} bytes and was aborted. The model may be stuck in a repetition loop.`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

// How often a progress line may go out while tokens arrive.
const PROGRESS_EVERY_MS = 2000;

function timedOutError(timeout_ms) {
  return new Error(
    `Local model timed out after ${timeout_ms}ms. Large models on CPU are slow to first token -- ` +
    `use a smaller model, or: ${timeoutRetryHint(timeout_ms, 'local_timeout_ms')}`
  );
}

// A streamed chat completion, read event by event. The answer is built from
// `content` deltas only; `reasoning` / `reasoning_content` deltas (and
// llama-swap's loading messages, which arrive there) count as activity, never
// as answer text. Once the model has started, `stall_ms` without a delta ends
// the call as INCOMPLETE with what it had. A runner that answers with plain
// JSON instead of a stream is read the old way.
async function postStream({ url, body, api_key, timeout_ms, base_url, describe, onProgress, stall_ms, images_sent }) {
  const stallController = new AbortController();
  const signals = [AbortSignal.timeout(timeout_ms), stallController.signal];
  // Also stop when the host cancels the call (see callContext in util.js).
  if (callSignal()) signals.push(callSignal());
  const signal = AbortSignal.any(signals);
  const progress = (phase, tokens) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress({ phase, tokens }); } catch (_) { /* progress is best-effort */ }
  };

  progress('waiting', 0);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(api_key) },
      body: JSON.stringify(body),
      // A key never follows a redirect: it could leave this machine with it.
      redirect: api_key ? 'error' : 'follow',
      signal
    });
  } catch (err) {
    const d = describeFetchError(err, base_url, describe);
    if (d.kind === 'timeout') throw timedOutError(timeout_ms);
    throw new Error(scrubPii(d.message));
  }

  if (!response.ok) {
    const text = await readCapped(response).catch(() => '');
    if (images_sent && (response.status === 400 || response.status >= 500) && /image|mmproj|vision|multimodal/i.test(text)) {
      const refused = new Error(scrubPii(`\`${body.model}\` can't read images (the runner said: ${String(text).slice(0, 300)})`));
      refused.code = 'images_refused';
      throw refused;
    }
    const failed = new Error(scrubPii(describeHttpError(response.status, text, {
      base_url, model: body.model, runner_label: describe.runner_label, has_key: Boolean(api_key), key_env: describe.key_env
    })));
    failed.status = response.status;
    throw failed;
  }

  if (/application\/json/i.test(response.headers.get('content-type') ?? '')) {
    const text = await readCapped(response);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error(scrubPii(`Local runner returned non-JSON (HTTP ${response.status}): ${e.message}. Body head: ${text.slice(0, 500)}`)); }
    const choice = parsed.choices?.[0];
    if (!choice) throw new Error(scrubPii(`Local runner returned no choices: ${JSON.stringify(parsed).slice(0, 500)}`));
    const { response: answer, reasoning } = extractMessage(choice.message);
    return { model: parsed.model, content: answer, reasoning: reasoning ?? '', finish_reason: choice.finish_reason ?? null, usage: parsed.usage ?? null };
  }

  let content = '';
  let reasoning = '';
  let model = null;
  let finish_reason = null;
  let usage = null;
  let deltas = 0;
  // When the first and the last token came, for the decode speed.
  let firstTokenAt = null;
  let lastTokenAt = null;
  let lastProgress = 0;
  let stalled = false;
  let stallTimer = null;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stalled = true; stallController.abort(); }, stall_ms);
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let total = 0;
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (stalled) {
          throw incompleteError({
            provider: 'local', timeout_ms, setting: 'local_timeout_ms', partial: stripReasoning(content),
            reason: `stopped sending tokens for ${Math.round(stall_ms / 1000)} s after it had started answering`
          });
        }
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          if (content.trim()) {
            throw incompleteError({ provider: 'local', timeout_ms, setting: 'local_timeout_ms', partial: stripReasoning(content) });
          }
          // Reasoning only: the model was working, just not answering yet. Say
          // that, not "slow to first token"; the reasoning itself isn't shown.
          if (reasoning) {
            throw incompleteError({
              provider: 'local', timeout_ms, setting: 'local_timeout_ms',
              reason: `was still thinking when the ${Math.round(timeout_ms / 1000)} s limit ran out (${reasoning.length} characters of reasoning, no answer yet)`,
              note: 'Pass `reasoning_effort: "none"` to answer without thinking, give it more time, or narrow the prompt.'
            });
          }
          throw timedOutError(timeout_ms);
        }
        throw new Error(scrubPii(`Connection to ${base_url} dropped while the model was answering: ${err?.message ?? err}`));
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Local runner response exceeded ${MAX_RESPONSE_BYTES} bytes and was aborted. The model may be stuck in a repetition loop.`);
      }
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch (_) { continue; }
        if (event.error) {
          throw new Error(scrubPii(`The runner reported an error mid-answer: ${JSON.stringify(event.error).slice(0, 300)}`));
        }
        if (typeof event.model === 'string') model = event.model;
        if (event.usage) usage = event.usage;
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish_reason = choice.finish_reason;
        const piece = choice.delta ?? {};
        let active = false;
        if (typeof piece.content === 'string' && piece.content !== '') { content += piece.content; active = true; }
        const thought = piece.reasoning_content ?? piece.reasoning;
        if (typeof thought === 'string' && thought !== '') { reasoning += thought; active = true; }
        if (!active) continue;
        deltas++;
        armStall();
        const now = Date.now();
        if (firstTokenAt === null) firstTokenAt = now;
        lastTokenAt = now;
        if (deltas === 1 || now - lastProgress >= PROGRESS_EVERY_MS) {
          lastProgress = now;
          progress('answering', deltas);
        }
      }
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    try { reader.releaseLock(); } catch (_) {}
  }
  return { model, content: stripReasoning(content), reasoning, finish_reason, usage, deltas, firstTokenAt, lastTokenAt };
}

// Decode speed in tokens a second: the tokens after the first, over the time
// from the first to the last. null when the answer is too short to judge.
export function decodeRate({ tokens, firstAt, lastAt }) {
  if (typeof tokens !== 'number' || tokens < 8 || firstAt === null || lastAt === null) return null;
  const seconds = (lastAt - firstAt) / 1000;
  if (seconds < 0.2) return null;
  return Math.round(((tokens - 1) / seconds) * 10) / 10;
}

/**
 * Single-shot completion against a local runner.
 * Return shape intentionally mirrors askCodex / askGemini / askClaude so
 * council.js can treat every participant identically.
 */
export async function askLocal({
  prompt,
  model,
  base_url = DEFAULT_BASE_URL,
  api_key = null,
  temperature = null,
  reasoning_effort = null,
  system_prompt = null,
  images,
  image_max_edge = DEFAULT_MAX_EDGE,
  timeout_ms = 180000,
  runner_label = null,   // the runner type, named in errors and the result
  start_hint = null,     // the runner's `start` setting, shown when it isn't listening
  key_env = null,        // the variable the key came from, named (never shown) in errors
  onProgress = null,     // ({ phase: 'waiting'|'answering', tokens }) while the call runs
  stall_ms = 120000,     // after the first token, this long without one ends the call
  record_speed = false,  // keep the decode speed for the Local models tab (lib/local-speeds.js)
  speeds_home = undefined
}) {
  requireString('prompt', prompt);
  if (key_env && !api_key) throw new Error(keyMissingMessage(key_env));
  if (!model || typeof model !== 'string' || !model.trim()) {
    throw new Error(
      'No local model configured. Set `local_model` in .claude/consult.local.md ' +
      '(e.g. `local_model: qwen3.5:9b`) or pass `model` to the tool. ' +
      'Call `local_status` to list what the runner has available.'
    );
  }
  validateBaseUrl(base_url);
  validateLocalReasoningEffort(reasoning_effort);

  // This is the one provider where image bytes actually transit this process,
  // so it is the only one that needs size handling. Measured on Ollama 0.30.7
  // + qwen3.5:9b: 3000x2000 costs 4084 prompt tokens, the same image at
  // 1024x683 costs 700 -- for an identical answer. Hence downscale-by-default.
  const loaded = images?.length ? loadImages(images) : [];
  const { parts: imageParts, warnings: imageWarnings } =
    loaded.length ? prepareImagesForLocal(loaded, image_max_edge) : { parts: [], warnings: [] };

  const messages = [];
  if (system_prompt) messages.push({ role: 'system', content: system_prompt });
  // Text first, then images: the OpenAI content-part convention, and it keeps
  // the instruction ahead of the payload the way the file-inlining rules do.
  messages.push({
    role: 'user',
    content: imageParts.length ? [{ type: 'text', text: prompt }, ...imageParts] : prompt
  });

  // Streamed, so progress can be reported and a stalled model noticed.
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (typeof temperature === 'number') body.temperature = temperature;
  // Ollama honours only `reasoning_effort` on this endpoint (not `think` or
  // `chat_template_kwargs`), and only as none / not-none; see the README.
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;

  const started = Date.now();
  const streamed = await postStream({
    url: joinUrl(base_url, '/chat/completions'),
    body, api_key, timeout_ms, base_url,
    describe: { runner_label, start_hint, key_env },
    onProgress, stall_ms, images_sent: imageParts.length > 0
  });
  const latency_ms = Date.now() - started;
  const { content: response, reasoning, finish_reason, usage } = streamed;
  // The runner's count when it gives one, else one token a streamed piece.
  const decode_tps = decodeRate({ tokens: usage?.completion_tokens ?? streamed.deltas, firstAt: streamed.firstTokenAt, lastAt: streamed.lastTokenAt });
  if (record_speed && runner_label) recordSpeed({ home: speeds_home, runner: runner_label, model, tps: decode_tps });

  if (!response) {
    // A reasoning model that hit its token ceiling mid-thought produces exactly
    // this: reasoning present, answer empty. Say so instead of "empty response".
    if (reasoning || finish_reason === 'length') {
      throw new Error(
        `Local model produced only reasoning, no answer (finish_reason=${finish_reason}). ` +
        `It hit the context/token ceiling while thinking -- common on small reasoning ` +
        `models. Set \`local_reasoning_effort: none\` to turn thinking off, use a larger ` +
        `model, or shorten the prompt.`
      );
    }
    throw new Error(scrubPii(`Local model returned an empty response: ${JSON.stringify({ model: streamed.model, usage }).slice(0, 500)}`));
  }

  return {
    response,
    // The name consult asked for: llama-server reports its GGUF file path here.
    model,
    latency_ms,
    ...(runner_label ? { runner: runner_label } : {}),
    base_url,
    finish_reason: finish_reason ?? null,
    decode_tps,
    tokens: {
      prompt: usage?.prompt_tokens ?? null,
      completion: usage?.completion_tokens ?? null,
      total: usage?.total_tokens ?? null
    },
    // Length only -- the reasoning text itself is noise for the caller, but its
    // size explains where the latency and tokens went.
    reasoning_chars: reasoning ? reasoning.length : 0,
    ...(loaded.length ? {
      images: loaded.map(i => ({ path: i.path, type: i.type, width: i.width, height: i.height })),
      // Surfaced, not thrown: an oversized image still answers, just slowly.
      ...(imageWarnings.length ? { image_warnings: imageWarnings } : {})
    } : {})
  };
}

/**
 * Reachability + inventory check. Free, no inference, no tokens.
 * The local analogue of codex_login_status / gemini_auth_status.
 */
export async function localStatus({
  base_url = DEFAULT_BASE_URL,
  api_key = null,
  configured_model = null,
  timeout_ms = 10000
} = {}) {
  try { validateBaseUrl(base_url); }
  catch (e) { return { reachable: false, base_url, reason: 'bad_config', details: e.message }; }

  let response;
  try {
    response = await fetch(joinUrl(base_url, '/models'), {
      headers: authHeaders(api_key),
      signal: AbortSignal.timeout(timeout_ms)
    });
  } catch (err) {
    const d = describeFetchError(err, base_url);
    return {
      reachable: false,
      base_url,
      reason: d.kind === 'timeout' ? 'timeout' : d.kind,
      details: scrubPii(d.message || `No response within ${timeout_ms}ms.`)
    };
  }

  if (!response.ok) {
    const text = await readCapped(response).catch(() => '');
    return {
      reachable: false,
      base_url,
      reason: 'http_error',
      details: scrubPii(describeHttpError(response.status, text, { base_url, model: configured_model }))
    };
  }

  let models = [];
  try {
    const parsed = JSON.parse(await readCapped(response));
    models = (parsed.data || []).map(m => m.id).filter(Boolean).sort();
  } catch (_) { /* reachable but unparseable inventory -- not fatal */ }

  const result = { reachable: true, base_url, models, model_count: models.length };
  if (configured_model) {
    result.configured_model = configured_model;
    result.configured_model_available = models.includes(configured_model);
    if (models.length && !result.configured_model_available) {
      result.hint = `Configured \`local_model\` (${configured_model}) is not in the runner's inventory. Pull it or pick one of: ${models.slice(0, 10).join(', ')}`;
    }
  }
  if (!models.length) {
    result.hint = `Runner is up but reports no models. Pull one (e.g. \`ollama pull qwen3.5:9b\`).`;
  }
  return result;
}
