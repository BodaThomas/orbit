import { COMPANION_PRESETS, DEFAULT_PERMISSIONS } from '@shared/catalog'
import type { OrbitDb } from '../infra/db/client'
import {
  activityEvents,
  agents as agentsTable,
  approvalRequests,
  conversations,
  executionEvents,
  messages,
  missions,
  usageRecords,
  workflowSteps,
  workflows,
} from '../infra/db/schema'
import { eq } from 'drizzle-orm'
import type { AgentManager } from './agents'
import type { SettingsStore } from './settings'
import { newId } from './util'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/**
 * Fills the separate demo database (orbit-demo.db) with fictional data.
 * The UI shows a permanent « Mode démo » banner while this database is open.
 */
export function seedDemo(db: OrbitDb, agents: AgentManager, settings: SettingsStore): void {
  if (settings.getRaw('demo.seeded')) return

  const ids: Record<string, string> = {}
  for (const p of COMPANION_PRESETS) {
    const a = agents.create(
      {
        name: p.name,
        role: p.role,
        description: p.description,
        appearance: p.appearance,
        providerId: 'demo',
        model: 'demo-orbit',
        instructions: p.instructions,
        autonomy: p.key === 'echo' ? 'supervised' : 'supervised',
        permissions: { ...DEFAULT_PERMISSIONS, readFiles: true, writeFiles: p.key === 'atlas' || p.key === 'echo', network: p.key === 'milo' },
        workingDirectory: p.key === 'atlas' ? '~/Projets/Orbit' : null,
        dailyBudgetUsd: null,
      },
      { silent: true },
    )
    ids[p.key] = a.id
  }
  const status = (key: string, s: string, text: string | null) =>
    db.update(agentsTable).set({ status: s, statusText: text }).where(eq(agentsTable.id, ids[key]!)).run()
  status('atlas', 'working', 'Travaille sur Orbit')
  status('milo', 'working', 'Recherche en cours')
  status('echo', 'awaiting_approval', 'Rapport hebdomadaire des coûts')

  // Missions
  const m = (key: string, title: string, st: string, minutes: number, extra: Partial<typeof missions.$inferInsert> = {}) => {
    const id = newId()
    db.insert(missions)
      .values({ id, shortId: `D${Math.random().toString(36).slice(2, 6).toUpperCase()}`, title, description: '', agentId: ids[key]!, priority: 'normal', status: st, createdAt: ago(minutes + 5), updatedAt: ago(minutes), startedAt: st === 'todo' ? null : ago(minutes + 4), ...extra })
      .run()
    return id
  }
  const mAtlas = m('atlas', 'Refactoriser le moteur de missions', 'running', 12, { priority: 'high', description: 'Séparer l’exécution du suivi d’état et ajouter les tests de transitions.' })
  const mMilo = m('milo', 'Comparer les SDK d’agents disponibles', 'running', 25, { description: 'Claude Agent SDK, Codex SDK, OpenAI Agents : capacités, auth, coûts.' })
  const mEcho = m('echo', 'Rapport hebdomadaire des coûts', 'approval_required', 40)
  m('nova', 'Préparer la revue de la semaine', 'done', 180, { finishedAt: ago(170), result: 'Revue prête : 4 missions terminées, 1 en attente.', costUsd: 0.042, costKind: 'estimated' })
  m('milo', 'Synthèse sur les bases vectorielles locales', 'done', 600, { finishedAt: ago(585), costUsd: 0.118, costKind: 'estimated' })
  m('atlas', 'Corriger le build macOS arm64', 'failed', 900, { finishedAt: ago(890), error: 'Délai dépassé côté fournisseur (démo).' })
  m('nova', 'Trier les notes de réunion', 'todo', 30)

  const exId = newId()
  for (const [i, [type, msg]] of (
    [
      ['started', 'Atlas commence la mission avec Démo locale · demo-orbit'],
      ['output', 'Analyse de la structure actuelle : MissionManager mélange persistance et exécution…'],
      ['output', 'Proposition : extraire ExecutionEngine, conserver la machine à états dans shared/.'],
    ] as const
  ).entries()) {
    db.insert(executionEvents).values({ id: newId(), missionId: mAtlas, executionId: exId, type, message: msg, createdAt: ago(12 - i * 3) }).run()
  }

  db.insert(approvalRequests)
    .values({ id: newId(), agentId: ids.echo!, missionId: mEcho, kind: 'mission_start', summary: 'Echo demande à démarrer « Rapport hebdomadaire des coûts »', detail: 'Mode supervisé avec permissions sensibles (écriture de fichiers).', status: 'pending', createdAt: ago(40) })
    .run()

  // Constellation: Nova coordinates Atlas and Milo
  const wf = newId()
  db.insert(workflows).values({ id: wf, name: 'Nouvelle application', coordinatorAgentId: ids.nova!, missionId: mAtlas, status: 'active', createdAt: ago(60) }).run()
  db.insert(workflowSteps).values([
    { id: newId(), workflowId: wf, agentId: ids.milo!, missionId: mMilo, dependsOn: [], status: 'running', createdAt: ago(60) },
    { id: newId(), workflowId: wf, agentId: ids.atlas!, missionId: mAtlas, dependsOn: [], status: 'running', createdAt: ago(60) },
  ]).run()

  // Conversation
  const conv = newId()
  db.insert(conversations).values({ id: conv, agentId: ids.nova!, title: 'Organisation de la semaine', createdAt: ago(200), updatedAt: ago(190) }).run()
  db.insert(messages).values([
    { id: newId(), conversationId: conv, role: 'user', content: 'Peux-tu m’aider à organiser ma semaine ?', status: 'complete', createdAt: ago(200) },
    { id: newId(), conversationId: conv, role: 'assistant', content: '*Réponse de démonstration.*\n\nBien sûr ! Voici une proposition :\n\n- **Lundi** — revue des missions en cours\n- **Mercredi** — point avec Atlas sur Orbit\n- **Vendredi** — rapport d’Echo sur les coûts\n\nVeux-tu que je crée ces missions ?', status: 'complete', model: 'demo-orbit', createdAt: ago(199) },
  ]).run()

  // Activity
  const act = (key: string | null, type: string, level: string, title: string, detail: string | null, minutes: number) =>
    db.insert(activityEvents).values({ id: newId(), type, level, agentId: key ? ids[key]! : null, title, detail, createdAt: ago(minutes) }).run()
  act('atlas', 'mission.started', 'info', 'Atlas a démarré une mission', 'Refactoriser le moteur de missions', 12)
  act('atlas', 'file.written', 'info', 'Fichier modifié', 'src/main/core/missions.ts', 8)
  act('milo', 'mission.started', 'info', 'Milo a démarré une mission', 'Comparer les SDK d’agents disponibles', 25)
  act('milo', 'tool.called', 'info', 'Recherche web', '« claude agent sdk permissions »', 18)
  act('echo', 'approval.requested', 'warning', 'Approbation demandée', 'Echo demande à démarrer « Rapport hebdomadaire des coûts »', 40)
  act('nova', 'mission.completed', 'success', 'Nova a terminé une mission', 'Préparer la revue de la semaine', 170)
  act('atlas', 'mission.failed', 'error', 'Échec de la mission d’Atlas', 'Délai dépassé côté fournisseur (démo).', 890)

  // Usage over 30 days (fictional, estimated)
  const keys = ['nova', 'atlas', 'milo', 'echo']
  for (let d = 0; d < 30; d++) {
    const n = 3 + ((d * 7) % 9)
    for (let i = 0; i < n; i++) {
      const key = keys[(d + i) % keys.length]!
      const input = 1200 + ((d * 131 + i * 977) % 9000)
      const output = 300 + ((d * 71 + i * 313) % 2500)
      db.insert(usageRecords).values({ id: newId(), agentId: ids[key]!, providerId: 'demo', model: 'demo-orbit', inputTokens: input, outputTokens: output, costUsd: (input * 4 + output * 20) / 1_000_000, costKind: 'estimated', pricingVersion: 'demo', source: 'mission', createdAt: ago(d * 1440 + i * 37 + 5) }).run()
    }
  }

  settings.update({ onboarded: true, userName: 'Camille' })
  settings.setRaw('demo.seeded', true)
}
