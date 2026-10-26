import { useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fmtNum } from '../engine/calculator'
import type { SimResult } from '../engine/types'
import { STATUS_STYLE } from './Canvas'
import { WorkloadInputs } from './Calculator'
import { useWS } from './store'

const axis = { stroke: '#475569', fontSize: 10 }
const tooltipStyle = { contentStyle: { background: '#0f172a', border: '1px solid #334155', fontSize: 11 }, labelStyle: { color: '#94a3b8' } }

export function Timeline() {
  const { result, tick, setTick, hasRun, state, update } = useWS()
  const data = useMemo(
    () =>
      result.ticks.map((t) => ({
        t: t.t,
        offered: Math.round(t.offeredRps),
        served: Math.round(t.successRps),
        failed: Math.round(t.failedRps),
        rejected: Math.round(t.rejectedRps),
        read: +t.readLatencyMs.toFixed(1),
        write: +t.writeLatencyMs.toFixed(1),
        dbReads: Math.round(t.dbReadRps),
        dbWrites: Math.round(t.dbWriteRps),
        cacheHits: Math.round(t.cacheHitRps),
        lag: Math.round(t.queueBacklog),
      })),
    [result],
  )
  const cur = hasRun ? result.ticks[tick]?.t : undefined
  const onClick = (e: { activeTooltipIndex?: number | string | null } | null) => {
    const i = Number(e?.activeTooltipIndex)
    if (Number.isFinite(i)) setTick(i)
  }
  const chart = (title: string, children: React.ReactNode, area = false) => (
    <div className="min-w-0 rounded-lg border border-slate-800 bg-slate-900/60 p-2">
      <div className="mb-1 text-[11px] font-semibold text-slate-300">{title}</div>
      <ResponsiveContainer width="100%" height={150}>
        {area ? (
          <AreaChart data={data} onClick={onClick} margin={{ left: -10, right: 6, top: 4 }}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="t" {...axis} unit="s" />
            <YAxis {...axis} tickFormatter={(v) => fmtNum(v, 0)} />
            <Tooltip {...tooltipStyle} />
            {children}
            {cur !== undefined && <ReferenceLine x={cur} stroke="#38bdf8" />}
          </AreaChart>
        ) : (
          <LineChart data={data} onClick={onClick} margin={{ left: -10, right: 6, top: 4 }}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="t" {...axis} unit="s" />
            <YAxis {...axis} tickFormatter={(v) => fmtNum(v, 0)} />
            <Tooltip {...tooltipStyle} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {children}
            {cur !== undefined && <ReferenceLine x={cur} stroke="#38bdf8" />}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-end gap-3 text-xs text-slate-300">
        <label>
          <div className="mb-0.5 text-[11px] text-slate-400">Traffic profile</div>
          <select className="rounded border border-slate-700 bg-slate-950 px-2 py-1" value={state.settings.profile} onChange={(e) => update((s) => ({ ...s, settings: { ...s.settings, profile: e.target.value as never } }))}>
            <option value="ramp">ramp: avg → peak → avg</option>
            <option value="spike">spike: sudden burst to peak</option>
            <option value="peak">steady peak</option>
            <option value="average">steady average</option>
          </select>
        </label>
        <label>
          <div className="mb-0.5 text-[11px] text-slate-400">Time step (simulated s / tick)</div>
          <select className="rounded border border-slate-700 bg-slate-950 px-2 py-1" value={state.settings.dt} onChange={(e) => update((s) => ({ ...s, settings: { ...s.settings, dt: Number(e.target.value) } }))}>
            {[0.25, 0.5, 1, 2, 5].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>
          <div className="mb-0.5 text-[11px] text-slate-400">Ticks</div>
          <input type="number" min={5} max={600} className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1" value={state.settings.ticks} onChange={(e) => update((s) => ({ ...s, settings: { ...s.settings, ticks: Math.max(5, Math.min(600, Number(e.target.value) || 60)) } }))} />
        </label>
        <div className="flex-1">
          <div className="mb-0.5 text-[11px] text-slate-400">Scrub {hasRun ? `(t = ${cur}s)` : '(press Run first)'}</div>
          <input type="range" min={0} max={result.ticks.length - 1} value={tick} disabled={!hasRun} onChange={(e) => setTick(Number(e.target.value))} className="w-full accent-sky-500" />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {chart('Throughput (req/s)', <>
          <Line dataKey="offered" stroke="#94a3b8" dot={false} isAnimationActive={false} />
          <Line dataKey="served" stroke="#10b981" dot={false} isAnimationActive={false} />
          <Line dataKey="failed" stroke="#ef4444" dot={false} isAnimationActive={false} />
          <Line dataKey="rejected" stroke="#f59e0b" dot={false} isAnimationActive={false} />
        </>)}
        {chart('Mean latency (ms)', <>
          <Line dataKey="read" stroke="#38bdf8" dot={false} isAnimationActive={false} />
          <Line dataKey="write" stroke="#fb923c" dot={false} isAnimationActive={false} />
          <ReferenceLine y={state.workload.latencyTargetMs} stroke="#f59e0b" strokeDasharray="4 4" />
        </>)}
        {chart('Data tier (req/s)', <>
          <Line dataKey="dbReads" stroke="#38bdf8" dot={false} isAnimationActive={false} />
          <Line dataKey="dbWrites" stroke="#fb923c" dot={false} isAnimationActive={false} />
          <Line dataKey="cacheHits" stroke="#10b981" dot={false} isAnimationActive={false} />
        </>)}
        {chart('Queue lag (messages)', <Area dataKey="lag" stroke="#a78bfa" fill="#a78bfa33" isAnimationActive={false} />, true)}
      </div>
    </div>
  )
}

export function eventLog(result: SimResult, labels: Map<string, string>) {
  const ev: { t: number; text: string; tone: string }[] = []
  const prev = new Map<string, string>()
  for (const t of result.ticks) {
    for (const [id, m] of Object.entries(t.nodes)) {
      const p = prev.get(id)
      if (p !== m.status && !(p === undefined && (m.status === 'idle' || m.status === 'healthy'))) {
        ev.push({
          t: t.t,
          tone: STATUS_STYLE[m.status].text,
          text: `${labels.get(id)}: ${p ?? 'start'} → ${m.status} (util ${Number.isFinite(m.utilization) ? (m.utilization * 100).toFixed(0) : '∞'}%${m.failed > 0 ? `, ${fmtNum(m.failed)}/s failing` : ''}${m.backlog > 0.5 ? `, ${fmtNum(m.backlog)} queued` : ''})`,
        })
      }
      prev.set(id, m.status)
    }
  }
  return ev
}

export function Logs() {
  const { result, state, tick, hasRun } = useWS()
  const labels = new Map(state.design.nodes.map((n) => [n.id, n.label]))
  const ev = eventLog(result, labels)
  const now = hasRun ? result.ticks[tick]?.t ?? 0 : Infinity
  return (
    <div className="p-3 font-mono text-[11.5px]">
      {result.warnings.map((w) => <div key={w} className="text-amber-300">⚠ {w}</div>)}
      {ev.length === 0 && <div className="text-slate-500">No state changes: every component stayed healthy.</div>}
      {ev.map((e, i) => (
        <div key={i} className={`${e.tone} ${e.t > now ? 'opacity-30' : ''}`}>
          <span className="text-slate-500">[t={String(e.t).padStart(3, ' ')}s]</span> {e.text}
        </div>
      ))}
    </div>
  )
}

export function Brief() {
  const { challenge, state, update } = useWS()
  const [hintsShown, setHintsShown] = useState(0)
  const [showConsiderations, setShowConsiderations] = useState(false)
  return (
    <div className="grid gap-4 p-3 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-3 text-sm text-slate-300">
        <div>
          <h2 className="text-base font-semibold text-slate-100">{challenge.title} <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{challenge.difficulty}</span></h2>
          <p className="mt-1">{challenge.statement}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Functional</h4>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px]">{challenge.functional.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Non-functional</h4>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px]">{challenge.nonFunctional.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <button className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => { setHintsShown((h) => Math.min(challenge.hints.length, h + 1)); update((s) => ({ ...s, progress: { ...s.progress, hintsUsed: s.progress.hintsUsed + 1 } })) }} disabled={hintsShown >= challenge.hints.length}>
            💡 {hintsShown ? `Next hint (${hintsShown}/${challenge.hints.length})` : 'Show a hint'}
          </button>
          <button className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setShowConsiderations((v) => !v)}>
            {showConsiderations ? 'Hide' : 'Show'} what interviewers look for
          </button>
        </div>
        {hintsShown > 0 && <ol className="list-decimal space-y-1 pl-5 text-[13px] text-sky-200">{challenge.hints.slice(0, hintsShown).map((h) => <li key={h}>{h}</li>)}</ol>}
        {showConsiderations && (
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Architectural considerations</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px]">{challenge.considerations.map((f) => <li key={f}>{f}</li>)}</ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Evaluation criteria</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px]">{challenge.evaluation.map((f) => <li key={f}>{f}</li>)}</ul>
            </div>
          </div>
        )}
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Workload assumptions (editable)</h4>
        <WorkloadInputs compact />
        <button className="mt-2 text-[11px] text-slate-500 hover:text-slate-300" onClick={() => update((s) => ({ ...s, workload: { ...challenge.workload } }))}>Reset to challenge defaults</button>
      </div>
      {state.design.nodes.length <= 1 && (
        <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-xs text-slate-300 lg:col-span-2">
          Blank canvas. Build from scratch, or{' '}
          <button className="text-sky-300 underline" onClick={() => update((s) => ({ ...s, design: structuredClone(challenge.starter) }))}>load a naive starter design</button> (client → LB → app → single DB) and find out where it breaks.
        </div>
      )}
    </div>
  )
}
