// Council orchestration: parallel generation, anonymization, parallel judging,
// Borda-count aggregation. All three CLIs are invoked as fresh subprocesses
// for both rounds, so each judge has no shared state with its sibling generator.
//
// Aggregation: Borda count. With N candidates, 1st place earns N-1 points,
// 2nd earns N-2, ..., last earns 0. Summed across all judges.
// 3-way tournament: max=6, min=0 per candidate. 2-way (degraded): max=2, min=0.
//
// Failure rules:
//   - 1 generator fails -> degraded 2-way tournament, judge pool shrinks too
//   - 2+ generators fail -> abort with clear error
//   - Judge produces unparseable ranking -> retry once, then drop that vote
//   - <2 valid rankings -> abort
//
// Anonymization: shuffled A/B/C labels. Judges never learn which model wrote
// what. The result builder maps labels back to model names for the caller.

import { randomInt } from 'node:crypto';
import { askClaude } from './claude.js';
import { askCodex, codexTimeoutMs } from './codex.js';
import { askGemini } from './gemini.js';
import { askLocal } from './local.js';
import { runnerKey, runnerInventory, prepareRunnerCall } from './local-runners.js';
import { runnerSettings, localConfigured } from './settings.js';
import { guardOneShot } from './delegate-local.js';
import { askAgy } from './agy.js';

// `agy` (Antigravity) replaced `gemini` as the default Google-side participant:
// Google withdrew Gemini CLI free-tier access for individual accounts, so a
// default council containing `gemini` fails for most users.
//
// `gemini` and `local` remain valid but are OPT-IN. Defaulting to either would
// silently change every council call -- gemini because it now usually errors,
// local because a small model tends to drag a tournament down.
export const ALL_PARTICIPANTS = Object.freeze(['claude', 'codex', 'agy', 'gemini', 'local']);
export const DEFAULT_PARTICIPANTS = Object.freeze(['claude', 'codex', 'agy']);

// Participants that can actually receive images. `claude` (via `claude -p`)
// and the legacy `gemini` wrapper have no image path, so a council with images
// would silently hand them a text-only prompt and then rank them against
// candidates that could see the picture -- an unfair tournament that looks
// normal in the output. We surface it instead of hiding it.
export const VISION_PARTICIPANTS = Object.freeze(['codex', 'agy', 'local']);
const LABELS_POOL = Object.freeze(['A', 'B', 'C', 'D', 'E']);

function shuffle(arr) {
  const a = [...arr];
  // crypto.randomInt is unbiased; randomBytes(1)[0] % n has modulo bias for n
  // values that don't divide 256 evenly. With 3 candidates the bias is small
  // but real (label A gets a 1/256 boost over B/C), and it leaks "fairer" info
  // to a judge that knows the source order.
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ordinalSuffix(n) {
  if (n === 1) return 'st';
  if (n === 2) return 'nd';
  if (n === 3) return 'rd';
  return 'th';
}

function buildJudgePrompt(originalPrompt, labeledCandidates) {
  const blocks = labeledCandidates
    .map(c => `Candidate ${c.label}:\n<<<\n${c.body}\n>>>`)
    .join('\n\n');
  const lines = labeledCandidates
    .map((_, i) => `${i + 1}${ordinalSuffix(i + 1)}: <letter>`)
    .join('\n');
  return (
    'You are judging candidate answers to a prompt. Rank them from best to worst ' +
    'based on accuracy, helpfulness, and clarity. Use ONLY the candidate text - ' +
    'do not assume anything about who wrote each one.\n\n' +
    'Original prompt:\n<<<\n' + originalPrompt + '\n>>>\n\n' +
    blocks + '\n\n' +
    'Output your ranking in EXACTLY this format, no preamble, no rationale, no extra text:\n' +
    lines
  );
}

export function parseRanking(text, expectedLabels) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\d+(?:st|nd|rd|th):\s*([A-Za-z])\b/);
    if (m) found.push(m[1].toUpperCase());
  }
  if (found.length !== expectedLabels.length) return null;
  const seen = new Set(found);
  if (seen.size !== expectedLabels.length) return null;
  for (const l of found) if (!expectedLabels.includes(l)) return null;
  return found;
}

// Build a per-participant asker bound to current settings + use_bare choice.
// `images` attach to the GENERATION round only. Judges rank candidate text,
// not the picture -- resending the image to every judge would multiply cost
// for a round that never looks at it.
// `callTimeoutMs` is the council_vote call's own `timeout_s`: one limit for
// every member's call in each round, codex's floor and per-provider settings
// included.
export function makeAsker(participant, settings, use_bare, images, callTimeoutMs) {
  if (callTimeoutMs) {
    settings = { ...settings, council_timeout_ms: callTimeoutMs, codex_timeout_ms: callTimeoutMs, agy_timeout_ms: callTimeoutMs, local_timeout_ms: callTimeoutMs };
  }
  const timeout_ms = settings.council_timeout_ms ?? settings.timeout_ms;
  if (participant === 'claude') {
    return (prompt) => askClaude({
      prompt,
      model: settings.claude_model,
      use_bare,
      timeout_ms
    });
  }
  if (participant === 'codex') {
    return (prompt, opts = {}) => askCodex({
      prompt,
      model: settings.codex_model,
      reasoning_effort: settings.codex_reasoning_effort,
      sandbox: settings.codex_sandbox,
      images: opts.withImages ? images : undefined,
      run_hooks: settings.codex_hooks,
      // Same floor as ask_codex: a council image review is exactly the long
      // codex call that died at 180s. A judging round finishes long before it.
      timeout_ms: codexTimeoutMs({ codex_timeout_ms: settings.codex_timeout_ms, timeout_ms })
    });
  }
  if (participant === 'agy') {
    return (prompt, opts = {}) => askAgy({
      prompt,
      model: settings.agy_model,
      effort: settings.agy_effort,
      images: opts.withImages ? images : undefined,
      timeout_ms: settings.agy_timeout_ms ?? timeout_ms
    });
  }
  if (participant === 'gemini') {
    return (prompt) => askGemini({
      prompt,
      model: settings.gemini_model,
      approval_mode: settings.gemini_approval_mode,
      timeout_ms
    });
  }
  if (participant === 'local') {
    // `local_model` may be a nickname or another quant now, and an image
    // round needs a model that reads images: resolve per round, as ask_local does.
    return async (prompt, opts = {}) => {
      const roundImages = opts.withImages ? images : undefined;
      // The runner in use, its default model and its key, as ask_local.
      const runner = runnerSettings(settings);
      const { api_key, key_env } = await runnerKey(runner);
      const inventory = await runnerInventory(runner, api_key, settings);
      const prepared = prepareRunnerCall({ runner, requested: null, images: roundImages, settings, callTimeoutMs: null, inventory, inCouncil: true });
      await guardOneShot({ runner, model: prepared.model, key: api_key, settings, inventory });
      return askLocal({
        prompt,
        model: prepared.model,
        base_url: runner.url,
        api_key,
        key_env,
        runner_label: runner.type,
        start_hint: runner.start,
        temperature: settings.local_temperature,
        reasoning_effort: settings.local_reasoning_effort,
        images: roundImages,
        image_max_edge: settings.local_image_max_edge,
        timeout_ms: prepared.timeout_ms,
        record_speed: true
      });
    };
  }
  throw new Error(`Unknown participant: ${participant}`);
}

// Borda count: with N candidates, 1st place earns N-1 points, last earns 0.
// Exported so the tests exercise the real implementation rather than a copy.
export function bordaScores(labels, rankings) {
  const N = labels.length;
  const scores = Object.fromEntries(labels.map(l => [l, 0]));
  for (const { ranking } of rankings) {
    ranking.forEach((label, idx) => { scores[label] += (N - 1 - idx); });
  }
  return scores;
}

// Every label sharing the top score, in descending order. More than one entry
// means a tie -- a 3-way tie must stay distinguishable from a 2-way tie.
export function tiedAtTop(scores) {
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const topScore = sorted[0][1];
  return sorted.filter(([, s]) => s === topScore).map(([l]) => l);
}

export async function councilVote({ prompt, images, participants, use_bare, verbose, settings, timeout_ms }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('`prompt` is required.');
  }

  const requested = (Array.isArray(participants) && participants.length)
    ? [...new Set(participants)]   // a duplicate would get two votes and two labels
    : [...DEFAULT_PARTICIPANTS];

  for (const p of requested) {
    if (!ALL_PARTICIPANTS.includes(p)) {
      throw new Error(`Unknown participant: ${p}. Allowed: ${ALL_PARTICIPANTS.join(', ')}`);
    }
  }
  if (requested.includes('local') && !localConfigured(settings)) {
    throw new Error(
      'Council participant "local" needs a local runner: run /consult:setlocal (or set `local_model` in .claude/consult.local.md). ' +
      'Call `local_status` to see what the runner has available.'
    );
  }
  if (requested.length < 2) {
    throw new Error(`Council needs at least 2 participants. Got: ${requested.join(', ')}`);
  }

  // Images requested but some participants are blind to them: that skews the
  // tournament, so refuse rather than quietly produce a misleading ranking.
  // Naming the working subset makes the fix a copy-paste.
  const blind = images?.length ? requested.filter(p => !VISION_PARTICIPANTS.includes(p)) : [];
  if (blind.length) {
    const seeing = requested.filter(p => VISION_PARTICIPANTS.includes(p));
    throw new Error(
      `Council was given images, but ${blind.join(' and ')} cannot receive them ` +
      `(only ${VISION_PARTICIPANTS.join(', ')} support images). Those participants would answer ` +
      `text-only and then be ranked against candidates that saw the image. ` +
      (seeing.length >= 2
        ? `Re-run with participants: ${JSON.stringify(seeing)}.`
        : `Pick at least two of ${VISION_PARTICIPANTS.join(', ')}.`)
    );
  }

  // Effective bare resolution: explicit -> setting -> auto-detect.
  // (claude.js will do the auto-detect if we pass `undefined`.)
  const effectiveUseBare = (typeof use_bare === 'boolean')
    ? use_bare
    : (typeof settings.council_use_bare === 'boolean' ? settings.council_use_bare : undefined);

  const askers = Object.fromEntries(
    requested.map(p => [p, makeAsker(p, settings, effectiveUseBare, images, timeout_ms)])
  );

  const started = Date.now();

  // Round 1: parallel generation
  const round1 = await Promise.allSettled(
    requested.map(p => askers[p](prompt, { withImages: true }))
  );

  const candidates = {};
  const failures = [];
  requested.forEach((p, i) => {
    const r = round1[i];
    if (r.status === 'fulfilled') {
      candidates[p] = r.value;
    } else {
      failures.push({ participant: p, reason: String(r.reason?.message || r.reason).slice(0, 500) });
    }
  });

  const aliveModels = requested.filter(p => candidates[p]);
  if (aliveModels.length < 2) {
    const detail = failures.map(f => `${f.participant}: ${f.reason}`).join(' | ');
    throw new Error(`Council aborted - need at least 2 candidates, got ${aliveModels.length}. Failures: ${detail}`);
  }

  // Anonymize
  const labels = LABELS_POOL.slice(0, aliveModels.length);
  const shuffledModels = shuffle(aliveModels);
  const labelToModel = {};
  shuffledModels.forEach((m, i) => { labelToModel[labels[i]] = m; });

  const labeledCandidates = labels.map(l => ({
    label: l,
    body: candidates[labelToModel[l]].response
  }));
  const judgePrompt = buildJudgePrompt(prompt, labeledCandidates);

  // Round 2: parallel judging by the surviving models
  const round2Initial = await Promise.allSettled(
    aliveModels.map(p => askers[p](judgePrompt))
  );

  const rankings = [];
  const judgeFailures = [];
  const needsRetry = [];

  aliveModels.forEach((p, i) => {
    const r = round2Initial[i];
    if (r.status === 'fulfilled') {
      const ranking = parseRanking(r.value.response, labels);
      if (ranking) {
        rankings.push({ judge: p, ranking });
      } else {
        // Eligible for one retry with a stricter format reminder.
        needsRetry.push({ participant: p, raw: r.value.response.slice(0, 500) });
      }
    } else {
      judgeFailures.push({
        judge: p,
        reason: String(r.reason?.message || r.reason).slice(0, 500)
      });
    }
  });

  // Retry pass for judges with unparseable output. One retry only.
  if (needsRetry.length) {
    const retryPrompt = judgePrompt + '\n\nIMPORTANT: Your previous response did not match the required format. Output ONLY the ranking lines, exactly as shown. No prose, no explanation.';
    const retried = await Promise.allSettled(
      needsRetry.map(item => askers[item.participant](retryPrompt))
    );
    needsRetry.forEach((item, i) => {
      const r = retried[i];
      if (r.status === 'fulfilled') {
        const ranking = parseRanking(r.value.response, labels);
        if (ranking) {
          rankings.push({ judge: item.participant, ranking });
        } else {
          judgeFailures.push({
            judge: item.participant,
            reason: 'unparseable ranking after retry',
            raw: r.value.response.slice(0, 500)
          });
        }
      } else {
        judgeFailures.push({
          judge: item.participant,
          reason: 'retry failed: ' + String(r.reason?.message || r.reason).slice(0, 400)
        });
      }
    });
  }

  if (rankings.length < 2) {
    throw new Error(
      `Council aborted at judging - need at least 2 valid rankings, got ${rankings.length}. ` +
      `Judge failures: ${JSON.stringify(judgeFailures)}`
    );
  }

  const scores = bordaScores(labels, rankings);
  const topLabels = tiedAtTop(scores);
  const tied = topLabels.length > 1;
  const winnerLabel = tied ? null : topLabels[0];
  const winnerModel = winnerLabel ? labelToModel[winnerLabel] : null;
  const winnerResponse = winnerLabel ? candidates[winnerModel].response : null;

  const result = {
    winner: winnerLabel,
    winner_model: winnerModel,
    winner_response: winnerResponse,
    scores: Object.fromEntries(labels.map(l => [l, {
      model: labelToModel[l],
      borda: scores[l]
    }])),
    tied,
    tied_at_top: topLabels,
    degraded: aliveModels.length < requested.length,
    total_latency_ms: Date.now() - started
  };

  if (failures.length) result.failures = failures;
  if (judgeFailures.length) result.judge_failures = judgeFailures;

  // Tied: always include candidate texts so the user can choose.
  // Verbose: include candidates AND per-judge rankings for transparency.
  if (tied || verbose) {
    result.candidates = Object.fromEntries(labels.map(l => [l, {
      model: labelToModel[l],
      response: candidates[labelToModel[l]].response,
      latency_ms: candidates[labelToModel[l]].latency_ms
    }]));
  }
  if (verbose) {
    result.rankings = rankings;
  }

  return result;
}
