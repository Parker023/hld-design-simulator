import { useEffect } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { diffDesigns, metricRows, narrate } from '../engine/analysis'
import { useWS } from './store'

export function Experiments() {
  const ws = useWS()
  const { state, update, setCompare } = ws
  const exps = state.experiments
  // Default to comparing the two most recent snapshots until the user picks.
  const valid = (id: string | null) => (id && exps.some((e) => e.id === id) ? id : null)
  const latestExcept = (id: string | null) => [...exps].reverse().find((e) => e.id !== id)?.id ?? null
  let pickA = valid(ws.compare[0])
  let pickB = valid(ws.compare[1])
  if (pickA === pickB) pickB = null
  if (!pickB && exps.length >= 2) pickB = latestExcept(pickA)
  if (!pickA && exps.length >= 2) pickA = [...exps].reverse().find((e) => e.id !== pickB && exps.indexOf(e) < exps.findIndex((x) => x.id === pickB))?.id ?? latestExcept(pickB)
  const compare: [string | null, string | null] = [pickA, pickB]
  const a = exps.find((e) => e.id === compare[0])
  const b = exps.find((e) => e.id === compare[1])

  useEffect(() => {
    if (a && b && !state.progress.compared) update((s) => ({ ...s, progress: { ...s.progress, compared: true } }))
  }, [a, b, state.progress.compared, update])

  if (!exps.length)
    return (
      <div className="p-4 text-sm text-slate-400">
        No experiments yet. Build a design and click <b>Snapshot</b> in the toolbar to save it as a baseline. Then change one thing (add Redis, raise the hit ratio, add replicas, 10× the peak) and take another snapshot to compare.
      </div>
    )

  return (
    <div className="grid gap-3 p-3 xl:grid-cols-[300px_1fr]">
      <div className="space-y-1.5">
        <div className="text-[11px] text-slate-500">Pick A (before) and B (after).</div>
        {exps.map((e) => (
          <div key={e.id} className="rounded-md border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs">
            <div className="flex items-center gap-1">
              <input
                className="min-w-0 flex-1 rounded border border-transparent bg-transparent font-semibold text-slate-100 hover:border-slate-700 focus:border-sky-500 focus:outline-none"
                value={e.name}
                onChange={(ev) => update((s) => ({ ...s, experiments: s.experiments.map((x) => (x.id === e.id ? { ...x, name: ev.target.value } : x)) }))}
              />
              <button className={`rounded px-1.5 ${compare[0] === e.id ? 'bg-slate-200 text-slate-900' : 'border border-slate-700 text-slate-300'}`} onClick={() => setCompare([e.id, compare[1] === e.id ? null : compare[1]])}>A</button>
              <button className={`rounded px-1.5 ${compare[1] === e.id ? 'bg-sky-500 text-white' : 'border border-slate-700 text-slate-300'}`} onClick={() => setCompare([compare[0] === e.id ? null : compare[0], e.id])}>B</button>
            </div>
            <div className="mt-0.5 text-slate-400">
              err {(e.summary.errorRate * 100).toFixed(2)}% · {e.summary.avgLatencyMs.toFixed(0)} ms · peak {Math.round(e.summary.peakOfferedRps).toLocaleString()}/s · {e.design.nodes.length} comps
            </div>
            <div className="mt-1 flex gap-2 text-[11px]">
              <button className="text-sky-300 hover:underline" onClick={() => { update((s) => ({ ...s, design: structuredClone(e.design), workload: { ...e.workload }, settings: { ...e.settings } })); ws.notify(`Loaded “${e.name}” onto the canvas`) }}>Load onto canvas</button>
              <button className="text-red-300 hover:underline" onClick={() => update((s) => ({ ...s, experiments: s.experiments.filter((x) => x.id !== e.id) }))}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {a && b ? <Comparison aId={a.id} bId={b.id} /> : <div className="p-2 text-sm text-slate-400">Select both A and B to compare.</div>}
    </div>
  )
}

function Comparison({ aId, bId }: { aId: string; bId: string }) {
  const { state } = useWS()
  const a = state.experiments.find((e) => e.id === aId)!
  const b = state.experiments.find((e) => e.id === bId)!
  const rows = metricRows(a.summary, b.summary)
  const story = narrate(a, b)
  const changes = diffDesigns(a, b)
  const chart = [
    { name: 'Peak served /s', A: Math.round(a.summary.peakSuccessRps), B: Math.round(b.summary.peakSuccessRps) },
    { name: 'Peak DB reads /s', A: Math.round(a.summary.peakDbReadRps), B: Math.round(b.summary.peakDbReadRps) },
    { name: 'Peak DB writes /s', A: Math.round(a.summary.peakDbWriteRps), B: Math.round(b.summary.peakDbWriteRps) },
    { name: 'Mean latency ms', A: +a.summary.avgLatencyMs.toFixed(1), B: +b.summary.avgLatencyMs.toFixed(1) },
  ]
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-3">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-500">
            <tr><th className="py-1 font-medium">Metric</th><th className="font-medium">A: {a.name}</th><th className="font-medium">B: {b.name}</th><th className="font-medium">Δ</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r) => {
              const d = r.after - r.before
              const better = Math.abs(d) < 1e-9 ? null : (d < 0) === (r.better === 'lower')
              const rel = r.before !== 0 ? `${d > 0 ? '+' : ''}${((d / Math.abs(r.before)) * 100).toFixed(1)}%` : d === 0 ? '0' : 'new'
              return (
                <tr key={r.key}>
                  <td className="py-1 text-slate-300">{r.label}</td>
                  <td className="tabular-nums text-slate-400">{r.format(r.before)}</td>
                  <td className="tabular-nums text-slate-100">{r.format(r.after)}</td>
                  <td className={`tabular-nums ${better === null ? 'text-slate-500' : better ? 'text-emerald-400' : 'text-red-400'}`}>{rel}</td>
                </tr>
              )
            })}
            <tr>
              <td className="py-1 text-slate-300">First bottleneck</td>
              <td className="text-slate-400">{a.summary.bottlenecks[0]?.label ?? 'none'}</td>
              <td className="text-slate-100">{b.summary.bottlenecks[0]?.label ?? 'none'}</td>
              <td />
            </tr>
          </tbody>
        </table>
        <div className="h-44 rounded-lg border border-slate-800 bg-slate-900/60 p-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ left: -10, right: 4, top: 4 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="name" stroke="#475569" fontSize={10} />
              <YAxis stroke="#475569" fontSize={10} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="A" fill="#94a3b8" isAnimationActive={false} />
              <Bar dataKey="B" fill="#38bdf8" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="space-y-3 text-xs">
        <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2.5">
          <div className="mb-1 font-semibold text-sky-200">What changed in the outcome</div>
          {story.length ? <ul className="list-disc space-y-1 pl-4 text-slate-200">{story.map((s) => <li key={s}>{s}</li>)}</ul> : <div className="text-slate-400">No material difference.</div>}
        </div>
        <div className="rounded-md border border-slate-800 bg-slate-900 p-2.5">
          <div className="mb-1 font-semibold text-slate-200">What you changed, and why it matters</div>
          {changes.length === 0 && <div className="text-slate-400">Designs are identical.</div>}
          <ul className="space-y-2">
            {changes.map((c, i) => (
              <li key={i}>
                <div className="text-slate-100">{c.kind === 'added' ? '➕' : c.kind === 'removed' ? '➖' : c.kind === 'workload' ? '📈' : '🔧'} {c.text}</div>
                {c.why && <div className="text-slate-300"><b className="text-emerald-400">Why it helps:</b> {c.why}</div>}
                {c.limits && <div className="text-slate-300"><b className="text-amber-300">Limits:</b> {c.limits}</div>}
                {c.risks && <div className="text-slate-400"><b className="text-red-300">New risks:</b> {c.risks.join(' · ')}</div>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
