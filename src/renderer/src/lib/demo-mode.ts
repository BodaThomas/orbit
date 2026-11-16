import { useConfirm } from '@/orbit/Confirm'
import { navigate } from '@/stores/router'
import { useAction } from './queries'

/**
 * Single entry point for switching between demo and real data (settings, sidebar, palette):
 * entering the demo asks first, and both directions land on the overview since the
 * current page may not exist in the other database.
 */
export function useDemoModeToggle() {
  const confirm = useConfirm()
  const setMode = useAction('app.setMode', {
    success: (b) => (b.settings.mode === 'demo' ? 'Mode démo ouvert' : 'Retour à vos données réelles'),
    onSuccess: () => navigate('/'),
  })
  const switchTo = async (mode: 'real' | 'demo') => {
    if (setMode.isPending) return
    if (mode === 'demo' && !(await confirm({ title: 'Passer en mode démo ?', body: 'Orbit ouvrira une base de démonstration séparée. Vous pourrez revenir à vos données à tout moment.', confirm: 'Ouvrir la démo' }))) return
    setMode.mutate({ mode })
  }
  return { switchTo, isPending: setMode.isPending }
}
