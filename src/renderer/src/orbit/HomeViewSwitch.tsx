import { Globe2, LayoutGrid } from 'lucide-react'
import { Segmented } from '@/components/ui/field'
import { navigate } from '@/stores/router'

/** The home page has two views of the same team: the dashboard and the universe map. */
export function HomeViewSwitch({ value }: { value: 'dashboard' | 'universe' }) {
  return (
    <Segmented
      value={value}
      onChange={(v) => navigate(v === 'universe' ? '/universe' : '/')}
      options={[
        { value: 'dashboard', label: <><LayoutGrid /> Tableau de bord</> },
        { value: 'universe', label: <><Globe2 /> Univers</> },
      ]}
    />
  )
}
