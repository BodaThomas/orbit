import type { ProviderAdapter, StreamChunk, StreamRequest } from './types'

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

function reply(req: StreamRequest): string {
  const last = req.messages.at(-1)?.content ?? ''
  const name = /Tu es (\w+)/.exec(req.system)?.[1] ?? 'Votre compagnon'
  const topic = last.length > 80 ? `${last.slice(0, 80).trim()}…` : last
  return [
    `*Réponse de démonstration générée localement — aucun moteur n’a été contacté.*`,
    ``,
    `${name} a bien reçu : « ${topic} »`,
    ``,
    `Voici comment je procéderais :`,
    ``,
    `1. **Clarifier l’objectif** et le résultat attendu.`,
    `2. **Découper** la demande en étapes vérifiables.`,
    `3. **Livrer** une première version, puis l’affiner avec vous.`,
    ``,
    '```ts',
    `const mission = { titre: ${JSON.stringify(topic.slice(0, 40))}, statut: 'en cours' }`,
    '```',
    ``,
    `Connectez un moteur dans **Paramètres → Moteurs** pour obtenir de vraies réponses.`,
  ].join('\n')
}

/** Offline provider used only in demo mode. Clearly labelled, never billed. */
export const demoAdapter: ProviderAdapter = {
  id: 'demo',
  name: 'Démo locale',
  availability: 'available',
  capabilities: { kind: 'chat', streaming: true, cancel: true, tools: false, sessions: false, usage: 'estimated', apiKeyAuth: false },
  requiresSecret: false,
  defaultModels: [{ id: 'demo-orbit', label: 'Modèle de démonstration', hint: 'Hors ligne' }],
  statusPage: null,
  notes: 'Générateur local pour le mode démo. Aucune requête réseau.',
  async validate() {},
  async *stream(req, _secret, signal): AsyncIterable<StreamChunk> {
    const text = reply(req)
    const tokens = text.match(/\S+\s*/g) ?? []
    await sleep(350, signal)
    for (const token of tokens) {
      if (signal.aborted) return
      yield { type: 'text', text: token }
      await sleep(18 + Math.random() * 30, signal)
    }
    const input = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, req.system.length) / 4)
    yield { type: 'usage', inputTokens: input, outputTokens: Math.ceil(text.length / 4) }
    yield { type: 'done', stopReason: 'end_turn' }
  },
}
