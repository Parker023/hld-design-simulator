import { useRef, useState } from 'react'
import { blankDesign } from '../data/challenges'
import { uid, useWS } from './store'

const btn = 'rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40'

export function TopBar({ onToggleLeft, onToggleRight }: { onToggleLeft: () => void; onToggleRight: () => void }) {
  const ws = useWS()
  const { playing, hasRun, tick, result, run, pause, reset, state, update, mode, setMode, challenge } = ws
  const [menu, setMenu] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const t = result.ticks[tick]

  const saveDesign = () => {
    const name = `${challenge.title} design ${state.savedDesigns.length + 1}`
    update((s) => ({ ...s, savedDesigns: [...s.savedDesigns, { id: uid('d'), name, savedAt: Date.now(), design: structuredClone(s.design), workload: { ...s.workload } }] }))
    ws.notify(`Saved “${name}” in this browser`)
  }
  const snapshot = () => {
    const e = ws.saveExperiment()
    ws.notify(`Snapshot “${e.name}” saved. Change something, then snapshot again to compare.`)
  }
  const exportAll = () => {
    const blob = new Blob([ws.storeApi.exportAll()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `hld-sim-export-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const importAll = async (f: File) => {
    try {
      const n = ws.storeApi.importAll(await f.text())
      ws.notify(`Imported ${n} records. Reloading…`)
      window.setTimeout(() => window.location.reload(), 600)
    } catch (e) {
      ws.notify(`Import failed: ${(e as Error).message}`)
    }
  }

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950 px-3 py-2">
      <button className="rounded p-1 text-slate-400 hover:bg-slate-800 lg:hidden" onClick={onToggleLeft} aria-label="Toggle left panel">☰</button>
      <div className="mr-2 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-sky-500 text-[11px] font-black text-slate-950">HLD</span>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-slate-100">Design Simulator</div>
          <div className="text-[11px] text-slate-500">{challenge.title}</div>
        </div>
      </div>
      <div className="flex overflow-hidden rounded-md border border-slate-700 text-xs">
        {(['guided', 'lab'] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={`px-2.5 py-1 ${mode === m ? 'bg-slate-200 font-semibold text-slate-900' : 'text-slate-300 hover:bg-slate-800'}`}>
            {m === 'guided' ? 'Guided interview' : 'Free-form lab'}
          </button>
        ))}
      </div>
      <div className="mx-1 h-5 w-px bg-slate-800" />
      {playing ? (
        <button onClick={pause} className="rounded-md bg-amber-500 px-3 py-1 text-xs font-bold text-slate-950 hover:bg-amber-400">❚❚ Pause</button>
      ) : (
        <button onClick={run} className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-bold text-slate-950 hover:bg-emerald-400">▶ {hasRun && tick < result.ticks.length - 1 ? 'Resume' : 'Run simulation'}</button>
      )}
      <button onClick={reset} className={btn} disabled={!hasRun}>↺ Reset</button>
      <select value={ws.speed} onChange={(e) => ws.setSpeed(Number(e.target.value))} className="rounded-md border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-300" title="Playback speed (ticks per second)">
        {[1, 2, 4, 8, 16].map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      {hasRun && t && (
        <span className="font-mono text-[11px] text-slate-400">
          t={t.t}s/{result.ticks[result.ticks.length - 1].t}s · {Math.round(t.offeredRps).toLocaleString()} req/s
        </span>
      )}
      <div className="flex-1" />
      <button onClick={snapshot} className={btn} title="Save current design + results as an experiment">📸 Snapshot</button>
      <button onClick={() => ws.setBottomTab('experiments')} className={btn}>⇄ Compare ({state.experiments.length})</button>
      <button onClick={saveDesign} className={btn}>💾 Save design</button>
      <div className="relative">
        <button onClick={() => setMenu((m) => !m)} className={btn}>⋯</button>
        {menu && (
          <div className="absolute right-0 z-50 mt-1 w-64 rounded-md border border-slate-700 bg-slate-900 p-1 text-xs shadow-xl" onMouseLeave={() => setMenu(false)}>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-slate-500">Saved designs</div>
            {state.savedDesigns.length === 0 && <div className="px-2 py-1 text-slate-500">None yet</div>}
            {state.savedDesigns.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-slate-800">
                <button className="truncate text-left text-slate-200" onClick={() => { update((s) => ({ ...s, design: structuredClone(d.design), workload: { ...d.workload } })); setMenu(false); ws.notify(`Loaded “${d.name}”`) }}>{d.name}</button>
                <button className="text-slate-500 hover:text-red-300" onClick={() => update((s) => ({ ...s, savedDesigns: s.savedDesigns.filter((x) => x.id !== d.id) }))}>✕</button>
              </div>
            ))}
            <div className="my-1 border-t border-slate-800" />
            <button className="block w-full rounded px-2 py-1 text-left text-slate-200 hover:bg-slate-800" onClick={() => { update((s) => ({ ...s, design: structuredClone(challenge.starter) })); setMenu(false) }}>Load naive starter design</button>
            <button className="block w-full rounded px-2 py-1 text-left text-slate-200 hover:bg-slate-800" onClick={() => { update((s) => ({ ...s, design: blankDesign() })); ws.setSelected(null); setMenu(false) }}>Clear canvas</button>
            <div className="my-1 border-t border-slate-800" />
            <button className="block w-full rounded px-2 py-1 text-left text-slate-200 hover:bg-slate-800" onClick={exportAll}>Export all data (JSON)</button>
            <button className="block w-full rounded px-2 py-1 text-left text-slate-200 hover:bg-slate-800" onClick={() => fileRef.current?.click()}>Import data…</button>
            <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importAll(e.target.files[0])} />
          </div>
        )}
      </div>
      <button className="rounded p-1 text-slate-400 hover:bg-slate-800 lg:hidden" onClick={onToggleRight} aria-label="Toggle right panel">⚙</button>
    </header>
  )
}
