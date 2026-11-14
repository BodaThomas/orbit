import { useEffect } from 'react'
import { Toaster } from 'sonner'
import { Sidebar } from '@/components/shell/Sidebar'
import { TooltipProvider } from '@/components/ui/overlay'
import { useBootstrap, useOrbitEvents } from '@/lib/queries'
import { ConfirmHost, PromptHost } from '@/orbit/Confirm'
import { CommandPalette } from '@/pages/CommandPalette'
import { NewMissionDialog } from '@/pages/NewMission'
import { OnboardingPage } from '@/pages/Onboarding'
import { Routes } from '@/pages/Routes'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'
import { OrbitLogo } from '@/orbit/Logo'

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        useUi.getState().setPaletteOpen(!useUi.getState().paletteOpen)
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        useUi.getState().openNewMission(null)
      } else if (k === 'n' && e.shiftKey) {
        e.preventDefault()
        navigate('/companions/new')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function App() {
  useOrbitEvents()
  useShortcuts()
  const boot = useBootstrap()
  const settings = boot.data?.settings

  useEffect(() => {
    const m = settings?.reduceMotion
    document.documentElement.dataset.motion = m === 'always' ? 'reduce' : m === 'never' ? 'always' : ''
  }, [settings?.reduceMotion])

  if (boot.isLoading || !settings) {
    return (
      <div className="drag flex h-full items-center justify-center">
        <OrbitLogo size={40} className="opacity-60" />
      </div>
    )
  }
  if (boot.isError) {
    return <div className="flex h-full items-center justify-center text-fg-2">Impossible de démarrer Orbit : {String(boot.error)}</div>
  }

  return (
    <TooltipProvider>
      {!settings.onboarded ? (
        <OnboardingPage />
      ) : (
        <div className="relative flex h-full">
          <Sidebar />
          <main className="relative min-w-0 flex-1 bg-canvas">
            <Routes />
          </main>
          <CommandPalette />
          <NewMissionDialog />
        </div>
      )}
      <ConfirmHost />
      <PromptHost />
      <Toaster
        position="bottom-right"
        theme="dark"
        toastOptions={{
          classNames: {
            toast: '!bg-[#1c1e26] !text-fg !border-0 !shadow-pop !rounded-lg !text-[13px] !font-sans',
            description: '!text-fg-3',
          },
        }}
      />
    </TooltipProvider>
  )
}
