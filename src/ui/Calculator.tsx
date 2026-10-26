import { useState } from 'react'
import { compareEstimate, estimate, fmtBytes, fmtNum, fmtValue, parseEstimate, type CalcStep, type CapacityInputs } from '../engine/calculator'
import type { Workload } from '../engine/types'
import { HelpTip } from './HelpTip'
import { useWS } from './store'

const WORKLOAD_FIELDS: { key: keyof Workload; label: string; step: number; help: string; unit?: string }[] = [
  { key: 'dau', label: 'Daily active users', step: 1_000_000, help: 'Distinct users who use the product on a typical day. The starting point for all traffic estimates.' },
  { key: 'requestsPerUserPerDay', label: 'Requests / user / day', step: 1, help: 'How many requests one active user makes per day on average (reads + writes). DAU × this = daily requests.' },
  { key: 'readWriteRatio', label: 'Read : write ratio (R:1)', step: 1, help: 'How many reads happen for every write. 100 means 100 reads per write (very read-heavy, e.g. URL redirects); 1 means equal reads and writes (e.g. chat).' },
  { key: 'peakMultiplier', label: 'Peak multiplier', step: 0.5, unit: '×', help: 'How much busier the busiest moment is than the daily average. 3 means peak traffic is 3× the average requests per second. Systems must be sized for the peak.' },
  { key: 'payloadBytes', label: 'Avg record / payload', step: 100, unit: 'B', help: 'Average size of one stored record and of one response, in bytes. Drives storage growth, cache memory and bandwidth.' },
  { key: 'retentionYears', label: 'Retention', step: 1, unit: 'years', help: 'How long data must be kept. Total storage = daily growth × retention.' },
  { key: 'hotDataFraction', label: 'Hot data fraction', step: 0.05, help: 'Share of daily reads that hit popular, frequently requested data (80/20 rule → 0.2). Sets how much memory a cache or database needs to keep the hot set in RAM.' },
  { key: 'latencyTargetMs', label: 'Latency target', step: 10, unit: 'ms', help: 'The response time you promise users. The simulation flags designs whose modeled mean latency exceeds it.' },
  { key: 'availabilityTarget', label: 'Availability target', step: 0.0001, help: 'Fraction of time the service must work, e.g. 0.999 = “three nines” ≈ 8.8 hours of downtime per year.' },
]

const CAP_FIELDS: { key: keyof CapacityInputs; label: string; step: number; help: string }[] = [
  { key: 'appRpsPerInstance', label: 'App req/s per instance', step: 100, help: 'Requests per second one application server can handle. Used to work out how many app instances you need.' },
  { key: 'dbReadRpsPerNode', label: 'DB reads/s per node', step: 100, help: 'Read queries per second one database machine can serve. Used to size read replicas.' },
  { key: 'dbWriteRpsPerNode', label: 'DB writes/s per node', step: 50, help: 'Writes per second one database primary or shard can accept. Used to decide whether you need sharding.' },
  { key: 'cacheHitRatio', label: 'Assumed cache hit ratio', step: 0.05, help: 'Fraction of reads you expect the cache to answer. Only the rest reach the database.' },
  { key: 'targetUtilization', label: 'Target utilization (headroom)', step: 0.05, help: 'How busy you allow each machine to be at peak. 0.7 keeps 30% spare for spikes and failures; sizing divides by this.' },
  { key: 'indexOverhead', label: 'Index overhead', step: 0.05, help: 'Extra storage for database indexes, as a fraction of raw data (0.3 = 30% more).' },
  { key: 'replicationFactor', label: 'Replication factor', step: 1, help: 'Number of copies of the data kept for durability. Multiplies the storage you must provision.' },
  { key: 'eventsPerRequest', label: 'Async events / request', step: 0.1, help: 'Background messages each request produces (e.g. one click event per redirect). Sets the queue throughput needed.' },
  { key: 'consumerRpsPerInstance', label: 'Consumer events/s per instance', step: 50, help: 'Messages per second one queue consumer (worker) can process. Used to size the worker pool.' },
]

export function WorkloadInputs({ compact }: { compact?: boolean }) {
  const { state, update } = useWS()
  return (
    <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-5'}`}>
      {WORKLOAD_FIELDS.map((f) => (
        <label key={f.key} className="block">
          <div className="mb-0.5 flex items-center text-[11px] text-slate-400">
            {f.label} {f.unit && <span className="ml-1 text-slate-600">({f.unit})</span>}
            <HelpTip text={f.help} />
          </div>
          <input
            type="number"
            step={f.step}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm tabular-nums text-slate-100 focus:border-sky-500 focus:outline-none"
            value={state.workload[f.key]}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (e.target.value === '' || !Number.isFinite(v) || v < 0) return
              update((s) => ({ ...s, workload: { ...s.workload, [f.key]: v } }))
            }}
          />
        </label>
      ))}
    </div>
  )
}

export function Calculator() {
  const { state, update } = useWS()
  const [quiz, setQuiz] = useState(true)
  const e = estimate(state.workload, state.capInputs)
  const groups = ['Traffic', 'Storage', 'Capacity'] as const

  const setGuess = (id: string, guess: string) =>
    update((s) => ({ ...s, progress: { ...s.progress, estimates: { ...s.progress.estimates, [id]: { ...(s.progress.estimates[id] ?? { revealed: false }), guess } } } }))
  const reveal = (step: CalcStep) =>
    update((s) => {
      const cur = s.progress.estimates[step.id] ?? { guess: '', revealed: false }
      const g = parseEstimate(cur.guess)
      const verdict = g === null ? 'skipped' : compareEstimate(g, step.value).verdict
      return { ...s, progress: { ...s.progress, estimates: { ...s.progress.estimates, [step.id]: { ...cur, revealed: true, verdict } } } }
    })

  return (
    <div className="space-y-4 p-3">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Workload assumptions (drive both the calculator and the simulation)</h3>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={quiz} onChange={(ev) => setQuiz(ev.target.checked)} className="accent-sky-500" />
            Estimate first, then reveal
            <HelpTip text="Interview practice: type your own estimate for each value, then press Reveal to see the calculated answer and how close you were (within 2× counts as close)." />
          </label>
        </div>
        <WorkloadInputs />
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        {groups.map((g) => (
          <section key={g} className="rounded-lg border border-slate-800 bg-slate-900/60">
            <h4 className="border-b border-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300">{g}</h4>
            <div className="divide-y divide-slate-800/70">
              {e.steps
                .filter((s) => s.group === g)
                .map((s) => {
                  const att = state.progress.estimates[s.id]
                  const hidden = quiz && s.estimable && !att?.revealed
                  const g2 = att ? parseEstimate(att.guess) : null
                  const cmp = att?.revealed && g2 !== null ? compareEstimate(g2, s.value) : null
                  return (
                    <div key={s.id} className="px-3 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[12.5px] text-slate-200">{s.label}</span>
                        {hidden ? (
                          <span className="flex items-center gap-1">
                            <input
                              placeholder="your estimate"
                              className="w-28 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
                              value={att?.guess ?? ''}
                              onChange={(ev) => setGuess(s.id, ev.target.value)}
                              onKeyDown={(ev) => ev.key === 'Enter' && reveal(s)}
                              title="Accepts 1.2k, 3,500, 900GB, 1e6…"
                            />
                            <button onClick={() => reveal(s)} className="rounded bg-sky-600 px-1.5 py-0.5 text-[11px] font-semibold text-white hover:bg-sky-500">Reveal</button>
                          </span>
                        ) : (
                          <span className="font-mono text-[12.5px] font-semibold tabular-nums text-sky-300">{fmtValue(s.value, s.unit)}</span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-slate-500">{s.formula}</div>
                      {!hidden && <div className="font-mono text-[10.5px] text-slate-400">= {s.substituted}</div>}
                      {cmp && g2 !== null && (
                        <div className={`mt-0.5 text-[11px] ${cmp.verdict === 'exact' || cmp.verdict === 'close' ? 'text-emerald-400' : cmp.verdict === 'same order' ? 'text-amber-300' : 'text-red-400'}`}>
                          You said {s.unit.startsWith('bytes') ? fmtBytes(g2) : fmtNum(g2)} → {cmp.ratio.toFixed(2)}× actual · {cmp.verdict}
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          </section>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Capacity-planning assumptions</h3>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {CAP_FIELDS.map((f) => (
              <label key={f.key} className="block">
                <div className="mb-0.5 flex items-center text-[11px] text-slate-400">
                  {f.label}
                  <HelpTip text={f.help} />
                </div>
                <input
                  type="number"
                  step={f.step}
                  className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm tabular-nums text-slate-100 focus:border-sky-500 focus:outline-none"
                  value={state.capInputs[f.key]}
                  onChange={(ev) => ev.target.value !== '' && update((s) => ({ ...s, capInputs: { ...s.capInputs, [f.key]: Number(ev.target.value) } }))}
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Per-node throughputs here are planning assumptions. The simulation uses each component’s own configuration on the canvas.</p>
        </section>
        <UnitConverter />
      </div>
    </div>
  )
}

function UnitConverter() {
  const [bytes, setBytes] = useState('904e9')
  const [rate, setRate] = useState('1157')
  const b = parseEstimate(bytes)
  const r = Number(rate)
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Unit conversions</h3>
      <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <input value={bytes} onChange={(e) => setBytes(e.target.value)} className="w-28 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-100" />
          <span>bytes =</span>
          <span className="font-mono text-sky-300">{b === null ? '—' : `${fmtBytes(b)} · ${(b / 2 ** 30).toFixed(2)} GiB · ${(b / 1e12).toFixed(4)} TB`}</span>
        </div>
        <div className="flex items-center gap-2">
          <input value={rate} onChange={(e) => setRate(e.target.value)} className="w-28 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-100" />
          <span>req/s =</span>
          <span className="font-mono text-sky-300">{Number.isFinite(r) ? `${fmtNum(r * 86400)} /day · ${fmtNum(r * 86400 * 30)} /month` : '—'}</span>
        </div>
        <div className="text-slate-500">Rules of thumb: 1 day = 86,400 s ≈ 10⁵ s · 1M req/day ≈ 12 req/s · decimal units (1 GB = 10⁹ B).</div>
      </div>
    </section>
  )
}
