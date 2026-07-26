import { useMemo, useState } from 'react'
import Sidebar, { type View } from './components/Sidebar'
import QueuePage from './pages/QueuePage'
import GuidePage from './pages/GuidePage'
import SettingsPage from './pages/SettingsPage'
import AboutPage from './pages/AboutPage'
import { useHotkeys } from './lib/hotkeys'
import { vq } from './lib/api'
import { useToast } from './lib/toast'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('queue')
  const { toast } = useToast()

  useHotkeys(
    useMemo(
      () => [
        {
          combo: 'ctrl+o',
          handler: () => {
            void vq.files.openDialog().then((res) => {
              if (res && res.accepted.length > 0)
                toast('success', `Added ${res.accepted.length} clip${res.accepted.length > 1 ? 's' : ''}`)
            })
          }
        },
        { combo: 'ctrl+,', handler: () => setView('settings') },
        { combo: '1', handler: () => setView('queue') },
        { combo: '2', handler: () => setView('guide') },
        { combo: '3', handler: () => setView('settings') },
        { combo: '4', handler: () => setView('about') },
        { combo: 'escape', handler: () => setView('queue') }
      ],
      [toast]
    )
  )

  return (
    <div className="flex h-full">
      <Sidebar view={view} onNavigate={setView} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        {view === 'queue' && <QueuePage />}
        {view === 'guide' && <GuidePage />}
        {view === 'settings' && <SettingsPage />}
        {view === 'about' && <AboutPage />}
      </main>
    </div>
  )
}
