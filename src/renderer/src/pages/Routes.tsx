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
import { ActivityPage } from './Activity'
import { AnalyticsPage } from './Analytics'
import { MachinesPage } from './Machines'
import { SettingsPage } from './Settings'

export function Routes() {
  const path = useRouter((s) => s.path)
  let p: Record<string, string> | null
  if (path === '/') return <OverviewPage />
  if (path === '/universe') return <UniversePage />
  if (path === '/companions') return <CompanionsPage />
  if (path === '/companions/new') return <CompanionWizardPage key="new" />
  if ((p = match('/companions/:id/edit', path))) return <CompanionWizardPage key={`edit-${p.id}`} agentId={p.id} />
  if ((p = match('/companions/:id/:tab?', path))) return <CompanionProfilePage key={p.id} agentId={p.id!} tab={p.tab} />
  if ((p = match('/chat/:agentId/:conversationId?', path))) return <ChatPage key={p.agentId} agentId={p.agentId!} conversationId={p.conversationId} />
  if (path === '/missions') return <MissionsPage />
  if ((p = match('/missions/:id', path))) return <MissionDetailPage key={p.id} missionId={p.id!} />
  if (path === '/constellations') return <ConstellationsPage />
  if (path === '/activity') return <ActivityPage />
  if (path === '/analytics') return <AnalyticsPage />
  if (path === '/machines') return <MachinesPage />
  if ((p = match('/settings/:section?', path))) return <SettingsPage section={p.section} />
  return <OverviewPage />
}
