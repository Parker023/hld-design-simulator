import { useMemo, useState } from 'react'
import { evaluate } from '../engine/analysis'
import { simulate } from '../engine/simulate'
import { CATALOG } from '../engine/components'
import { useWS } from './store'

export function Review() {
  const ws = useWS()
  const { state, challenge, update } = ws
  const [ran, setRan] = useState(false)
  const attempted = state.progress.runs > 0 && state.design.nodes.length > 2

  const evalResult = useMemo(() => {
    if (!ran) return null
    const peak = simulate(state.design, state.workload, { ...state.settings, profile: 'peak' })
    const spike = simulate(state.design, { ...state.workload, peakMultiplier: Math.max(10, state.workload.peakMultiplier) }, { ...state.settings, profile: 'peak' })
    return {
      peak,
      spike,
      criteria: evaluate({
        design: state.design,
        workload: state.workload,
        peakSummary: peak.summary,
        spikeSummary: spike.summary,
        estimateAttempts: Object.entries(state.progress.estimates).filter(([, v]) => v.revealed && v.verdict && v.verdict !== 'skipped').map(([id, v]) => ({ id, verdict: v.verdict! })),
        notes: state.progress.notes,
        experiments: state.experiments.length,
        hintsUsed: state.progress.hintsUsed,
      }),
    }
  }, [ran, state])

  const total = evalResult ? evalResult.criteria.reduce((s, c) => s + c.score, 0) : 0
  const max = evalResult ? evalResult.criteria.length * 4 : 0

  return (
    <div className="grid gap-4 p-3 xl:grid-cols-[1fr_380px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => setRan(true)} className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500">
            {ran ? 'Re-evaluate current design' : 'Finish & evaluate my design'}
          </button>
          <span className="text-xs text-slate-400">Runs the current design at steady peak ({state.workload.peakMultiplier}×) and at 10× average, then reviews your notes, estimates and experiments.</span>
        </div>
        {evalResult && (
          <>
            <div className="text-sm text-slate-300">
              Overall: <b className="text-slate-100">{total}/{max}</b> · peak errors {(evalResult.peak.summary.errorRate * 100).toFixed(2)}% · 10× errors {(evalResult.spike.summary.errorRate * 100).toFixed(2)}%
              <span className="ml-2 text-[11px] text-slate-500">The score only orders the feedback. Read the notes, not the number.</span>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {evalResult.criteria.map((c) => (
                <div key={c.name} className="rounded-md border border-slate-800 bg-slate-900 p-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-100">{c.name}</span>
                    <span className="flex gap-0.5">{[0, 1, 2, 3].map((i) => <span key={i} className={`h-1.5 w-4 rounded ${i < c.score ? (c.score >= 3 ? 'bg-emerald-500' : c.score === 2 ? 'bg-amber-400' : 'bg-red-500') : 'bg-slate-700'}`} />)}</span>
                  </div>
                  {c.good.map((g) => <div key={g} className="mt-1 text-emerald-300">✓ {g}</div>)}
                  {c.improve.map((g) => <div key={g} className="mt-1 text-amber-200">→ {g}</div>)}
                  <div className="mt-1.5 italic text-slate-400">Interviewer: “{c.interviewer}”</div>
                </div>
              ))}
            </div>
          </>
        )}
        <Notes />
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Reference solution</h4>
        {!attempted && <p className="text-xs text-slate-500">Locked until you have built a design (3+ components) and run the simulation at least once.</p>}
        {attempted && !state.progress.referenceRevealed && (
          <button className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800" onClick={() => update((s) => ({ ...s, progress: { ...s.progress, referenceRevealed: true } }))}>
            Reveal reference architecture
          </button>
        )}
        {state.progress.referenceRevealed && (
          <div className="space-y-2 rounded-md border border-slate-800 bg-slate-900 p-2.5 text-xs text-slate-300">
            <ul className="list-disc space-y-1 pl-4">{challenge.reference.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            <div className="text-slate-400">Components: {challenge.reference.design.nodes.map((n) => `${CATALOG[n.kind].icon} ${n.label}`).join(' · ')}</div>
            <p className="text-[11px] text-slate-500">This is one reasonable answer, not the only one. Snapshot your design first, then load the reference and compare the two in Experiments.</p>
            <button
              className="rounded bg-slate-200 px-2 py-1 font-semibold text-slate-900 hover:bg-white"
              onClick={() => {
                ws.saveExperiment('My design (before reference)')
                update((s) => ({ ...s, design: structuredClone(challenge.reference.design) }))
                ws.notify('Saved your design as an experiment and loaded the reference')
              }}
            >
              Snapshot mine & load reference
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function Notes({ only }: { only?: (keyof ReturnType<typeof useWS>['state']['progress']['notes'])[] }) {
  const { state, update } = useWS()
  const fields = [
    { key: 'requirements', label: 'Requirements & scope', ph: 'Functional, non-functional (latency, availability, consistency), out of scope…' },
    { key: 'api', label: 'API design', ph: 'POST /api/v1/urls {longUrl, alias?, expiresAt?} → {code}\nGET /{code} → 301 Location' },
    { key: 'dataModel', label: 'Data model', ph: 'urls(code PK, long_url, user_id, created_at, expires_at) …' },
    { key: 'tradeoffs', label: 'Trade-offs & risks', ph: 'Why each component; consistency (stale cache, replica lag); failure modes; cost…' },
  ] as const
  return (
    <div className={`grid gap-2 ${only ? '' : 'md:grid-cols-2'}`}>
      {fields
        .filter((f) => !only || only.includes(f.key))
        .map((f) => (
          <label key={f.key} className="block">
            <div className="mb-0.5 text-[11px] text-slate-400">{f.label}</div>
            <textarea
              rows={only ? 6 : 4}
              placeholder={f.ph}
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
              value={state.progress.notes[f.key]}
              onChange={(e) => update((s) => ({ ...s, progress: { ...s.progress, notes: { ...s.progress.notes, [f.key]: e.target.value } } }))}
            />
          </label>
        ))}
    </div>
  )
}
