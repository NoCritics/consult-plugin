// A pi extension for delegate's local worker: registers the provider
// `consult-local` for the one model and runner this run uses, so no file under
// ~/.pi is read or written. delegate-workers.js passes it with `-e` and sets:
//   CONSULT_PI_BASE_URL  the runner's OpenAI-style base URL
//   CONSULT_PI_KEY_ENV   the NAME of the variable holding the key (unset: no key)
//   CONSULT_PI_MODEL     the model id
//   CONSULT_PI_CONTEXT   the model's context window in tokens (unset: 32768)
// pi reads the key from its own environment by the `$NAME` form.

export default function (pi) {
  const keyEnv = process.env.CONSULT_PI_KEY_ENV;
  pi.registerProvider('consult-local', {
    baseUrl: process.env.CONSULT_PI_BASE_URL,
    apiKey: keyEnv ? '$' + keyEnv : 'none',
    api: 'openai-completions',
    models: [
      {
        id: process.env.CONSULT_PI_MODEL,
        name: process.env.CONSULT_PI_MODEL,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number(process.env.CONSULT_PI_CONTEXT) || 32768,
        maxTokens: 8192
      }
    ]
  });
}
