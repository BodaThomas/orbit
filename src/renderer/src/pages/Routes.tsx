import { match, useRouter } from '@/stores/router'
import { OverviewPage } from './Overview'
import { UniversePage } from './Universe'
import { CompanionsPage } from './Companions'
import { CompanionProfilePage } from './CompanionProfile'
import { CompanionWizardPage } from './CompanionWizard'
import { ChatPage } from './Chat'
import { MissionsPage } from './Missions'
import { MissionDetailPage } from './MissionDetail'
import { ConstellationsPage } from './Constellations'
import { ConstellationRunPage } from './ConstellationRun'
import { ConstellationWizardPage } from './ConstellationWizard'
import { ActivityPage } from './Activity'
import { AutomationsPage, AutomationWizardPage } from './Automations'
import { AnalyticsPage } from './Analytics'
import { MachinesPage } from './Machines'
import { SettingsPage } from './Settings'

export function Routes() {
  const full = useRouter((s) => s.path)
  const [path = '/', search = ''] = full.split('?')
  const query = new URLSearchParams(search)
  let p: Record<string, string> | null
  if (path === '/') return <OverviewPage />
  if (path === '/universe') return <UniversePage />
  if (path === '/companions') return <CompanionsPage />
  if (path === '/companions/new') return <CompanionWizardPage key="new" />
  if ((p = match('/companions/:id/edit', path))) return <CompanionWizardPage key={`edit-${p.id}`} agentId={p.id} />
  if ((p = match('/companions/:id/:tab?', path))) return <CompanionProfilePage key={p.id} agentId={p.id!} tab={p.tab} />
  if ((p = match('/chat/:agentId/:conversationId?', path))) return <ChatPage key={p.agentId} agentId={p.agentId!} conversationId={p.conversationId} />
  if (path === '/missions') return <MissionsPage />
  if ((p = match('/missions/:id', path))) return <MissionDetailPage key={p.id} missionId={p.id!} focusApproval={query.get('approval')} />
  if (path === '/constellations') return <ConstellationsPage />
  if (path === '/constellations/new') return <ConstellationWizardPage key="new" />
  if ((p = match('/constellations/runs/:id', path))) return <ConstellationRunPage key={p.id} runId={p.id!} />
  if ((p = match('/constellations/:id/edit', path))) return <ConstellationWizardPage key={`edit-${p.id}`} constellationId={p.id} />
  if (path === '/automations') return <AutomationsPage focusRun={query.get('run')} />
  if (path === '/automations/new') return <AutomationWizardPage key="new" />
  if ((p = match('/automations/:id/edit', path))) return <AutomationWizardPage key={`edit-${p.id}`} automationId={p.id} />
  if (path === '/activity') return <ActivityPage />
  if (path === '/analytics') return <AnalyticsPage />
  if (path === '/machines') return <MachinesPage />
  if ((p = match('/settings/:section?', path))) return <SettingsPage section={p.section} />
  return <OverviewPage />
}
