import { useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Canvas } from './ui/Canvas'
import { Calculator } from './ui/Calculator'
import { Experiments } from './ui/Experiments'
import { Inspector } from './ui/Inspector'
import { LeftSidebar } from './ui/LeftSidebar'
import { Brief, Logs, Timeline } from './ui/Panels'
import { Review } from './ui/Review'
import { TopBar } from './ui/TopBar'
import { WorkspaceProvider, useWS, type BottomTab } from './ui/store'

const TABS: { id: BottomTab; label: string }[] = [
  { id: 'brief', label: 'Challenge' },
  { id: 'calculator', label: 'Calculator' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'logs', label: 'Logs' },
  { id: 'experiments', label: 'Experiments' },
  { id: 'review', label: 'Review' },
]

function Workspace() {
  const ws = useWS()
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [bottomSize, setBottomSize] = useState<'min' | 'normal' | 'tall'>('normal')
  const bottomH = bottomSize === 'min' ? 'h-9' : bottomSize === 'normal' ? 'h-[38vh]' : 'h-[65vh]'
  const errors = ws.result.summary.bottlenecks.length

  return (
    <div className="flex h-dvh flex-col bg-slate-950 text-slate-200">
      <TopBar onToggleLeft={() => setLeftOpen((o) => !o)} onToggleRight={() => setRightOpen((o) => !o)} />
      <div className="relative flex min-h-0 flex-1">
        <aside className={`${leftOpen ? 'absolute inset-y-0 left-0 z-30 flex shadow-2xl' : 'hidden'} w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-950 lg:static lg:flex`}>
          <LeftSidebar />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Canvas />
          </div>
          <section className={`${bottomH} flex shrink-0 flex-col border-t border-slate-800 bg-slate-950 transition-[height]`}>
            <div className="flex items-center border-b border-slate-800 px-1">
              <div className="flex min-w-0 flex-1 overflow-x-auto">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { ws.setBottomTab(t.id); if (bottomSize === 'min') setBottomSize('normal') }}
                    className={`whitespace-nowrap px-3 py-2 text-xs font-semibold ${ws.bottomTab === t.id ? 'border-b-2 border-sky-400 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
                  >
                    {t.label}
                    {t.id === 'logs' && errors > 0 && <span className="ml-1 rounded bg-red-500/20 px-1 text-[10px] text-red-300">{errors}</span>}
                    {t.id === 'experiments' && ws.state.experiments.length > 0 && <span className="ml-1 text-[10px] text-slate-500">{ws.state.experiments.length}</span>}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 px-1 text-slate-500">
                <button title="Collapse" onClick={() => setBottomSize('min')} className="px-1 hover:text-slate-200">▁</button>
                <button title="Normal" onClick={() => setBottomSize('normal')} className="px-1 hover:text-slate-200">▄</button>
                <button title="Tall" onClick={() => setBottomSize('tall')} className="px-1 hover:text-slate-200">█</button>
              </div>
            </div>
            {bottomSize !== 'min' && (
              <div className="min-h-0 flex-1 overflow-auto">
                {ws.bottomTab === 'brief' && <Brief />}
                {ws.bottomTab === 'calculator' && <Calculator />}
                {ws.bottomTab === 'timeline' && <Timeline />}
                {ws.bottomTab === 'logs' && <Logs />}
                {ws.bottomTab === 'experiments' && <Experiments />}
                {ws.bottomTab === 'review' && <Review />}
              </div>
            )}
          </section>
        </main>
        <aside className={`${rightOpen ? 'absolute inset-y-0 right-0 z-30 block shadow-2xl' : 'hidden'} w-80 shrink-0 border-l border-slate-800 bg-slate-950 lg:static lg:block`}>
          <Inspector />
        </aside>
      </div>
      {ws.toast && <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 shadow-xl">{ws.toast}</div>}
    </div>
  )
}

export default function App() {
  return (
    <WorkspaceProvider>
      <ReactFlowProvider>
        <Workspace />
      </ReactFlowProvider>
    </WorkspaceProvider>
  )
}
