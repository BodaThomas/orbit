import { useState } from 'react'
import { Command } from 'cmdk'
import { Activity, BarChart3, CalendarClock, FlaskConical, Globe2, KeyRound, LayoutGrid, Plus, Rocket, Search, Server, Settings, Users, Waypoints } from 'lucide-react'
import { Kbd } from '@/components/ui/field'
import { Dialog } from 'radix-ui'
import { useDemoModeToggle } from '@/lib/demo-mode'
import { useAgents, useMissions, useBootstrap } from '@/lib/queries'
import { Companion } from '@/orbit/Companion'
import { MissionStatusIcon } from '@/orbit/MissionStatus'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

const item = 'flex h-10 cursor-default items-center gap-3 rounded-[9px] px-3 text-[13.5px] text-fg-2 data-[selected=true]:bg-white/[0.06] data-[selected=true]:text-fg [&_svg]:size-4 [&_svg]:text-fg-3'
const group = '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3'

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  const setOpen = useUi((s) => s.setPaletteOpen)
  const agents = useAgents()
  const missions = useMissions()
  const boot = useBootstrap()
  const demo = useDemoModeToggle()
  const [search, setSearch] = useState('')
  const run = (fn: () => void) => {
    setOpen(false)
    setSearch('')
    fn()
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="orbit-fade fixed inset-0 z-50 bg-[#05060a]/50" />
        <Dialog.Content className="orbit-pop fixed top-[16vh] left-1/2 z-50 w-[620px] -translate-x-1/2 overflow-hidden rounded-[16px] bg-[#1a1c24] shadow-pop" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Palette de commandes</Dialog.Title>
          <Command loop label="Palette de commandes">
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="size-4 text-fg-3" />
              <Command.Input value={search} onValueChange={setSearch} autoFocus placeholder="Rechercher un compagnon, une mission, une action…" className="h-13 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3" />
              <Kbd>esc</Kbd>
            </div>
            <Command.List className="max-h-[420px] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-8 text-center text-[13px] text-fg-3">Aucun résultat.</Command.Empty>
              <Command.Group heading="Actions" className={group}>
                <Command.Item className={item} onSelect={() => run(() => useUi.getState().openNewMission(null))}><Rocket /> Nouvelle mission <span className="ml-auto"><Kbd>⌘N</Kbd></span></Command.Item>
                <Command.Item className={item} onSelect={() => run(() => navigate('/companions/new'))}><Plus /> Nouveau compagnon <span className="ml-auto"><Kbd>⇧⌘N</Kbd></span></Command.Item>
                <Command.Item className={item} onSelect={() => run(() => navigate('/settings/providers'))}><KeyRound /> Connecter un moteur</Command.Item>
                <Command.Item className={item} onSelect={() => run(() => void demo.switchTo(boot.data?.settings.mode === 'demo' ? 'real' : 'demo'))}>
                  <FlaskConical /> {boot.data?.settings.mode === 'demo' ? 'Quitter le mode démo' : 'Ouvrir le mode démo'}
                </Command.Item>
              </Command.Group>
              {!!agents.data?.length && (
                <Command.Group heading="Compagnons" className={group}>
                  {agents.data.map((a) => (
                    <Command.Item key={a.id} value={`compagnon ${a.name} ${a.role}`} className={item} onSelect={() => run(() => navigate(`/companions/${a.id}`))}>
                      <Companion appearance={a.appearance} size={22} />
                      <span className="text-fg">{a.name}</span>
                      <span className="truncate text-xs text-fg-3">{a.role}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Aller à" className={group}>
                {(
                  [
                    ['/', 'Vue d’ensemble', LayoutGrid],
                    ['/universe', 'Mon univers', Globe2],
                    ['/companions', 'Compagnons', Users],
                    ['/missions', 'Missions', Rocket],
                    ['/constellations', 'Constellations', Waypoints],
                    ['/automations', 'Automatisations', CalendarClock],
                    ['/activity', 'Activité', Activity],
                    ['/analytics', 'Statistiques', BarChart3],
                    ['/machines', 'Machines', Server],
                    ['/settings', 'Paramètres', Settings],
                  ] as const
                ).map(([path, label, Icon]) => (
                  <Command.Item key={path} value={`aller ${label}`} className={item} onSelect={() => run(() => navigate(path))}><Icon /> {label}</Command.Item>
                ))}
              </Command.Group>
              {search.length > 1 && !!missions.data?.length && (
                <Command.Group heading="Missions" className={group}>
                  {missions.data.slice(0, 50).map((m) => (
                    <Command.Item key={m.id} value={`mission ${m.shortId} ${m.title}`} className={item} onSelect={() => run(() => navigate(`/missions/${m.id}`))}>
                      <MissionStatusIcon status={m.status} />
                      <span className="truncate">{m.title}</span>
                      <span className="ml-auto font-mono text-2xs text-fg-4">{m.shortId}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {search.length > 1 && (
                <Command.Group heading="Activité" className={group}>
                  <Command.Item value={`activite rechercher ${search}`} className={item} onSelect={() => {
                    const q = search.trim()
                    run(() => navigate(`/activity?q=${encodeURIComponent(q)}`))
                  }}><Activity /> Rechercher « {search} » dans l’activité</Command.Item>
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
