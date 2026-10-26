import { useState } from 'react'
import { CATALOG, componentAvailability, monthlyCost, withDefaults, type FieldDef } from '../engine/components'
import { fmtNum } from '../engine/calculator'
import { hintsFor, insights, TRADEOFFS } from '../engine/analysis'
import { cacheHitRatio } from '../engine/simulate'
import type { ConfigValue, NodeTickMetrics } from '../engine/types'
import { STATUS_STYLE } from './Canvas'
import { useWS } from './store'

export function Inspector() {
  const ws = useWS()
  const node = ws.state.design.nodes.find((n) => n.id === ws.selected)
  return <div className="flex h-full flex-col overflow-y-auto">{node ? <NodePanel key={node.id} /> : <OverviewPanel />}</div>
}

function Stat({ label, value, tone, tip }: { label: string; value: string; tone?: string; tip?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900 px-2 py-1.5" title={tip}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${tone ?? 'text-slate-100'}`}>{value}</div>
    </div>
  )
}

function OverviewPanel() {
  const { result, tick, hasRun, state } = useWS()
  const t = hasRun ? result.ticks[Math.min(tick, result.ticks.length - 1)] : undefined
  const s = result.summary
  const ins = insights(state.design, state.workload, s)
  return (
    <div className="space-y-3 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Live system metrics</h3>
      {!hasRun && <p className="text-xs text-slate-500">Press <b>Run</b> to animate the simulation. Summary numbers below are already computed from the current design.</p>}
      {t && (
        <div className="grid grid-cols-2 gap-2">
          <Stat label={`t = ${t.t}s offered`} value={`${fmtNum(t.offeredRps)}/s`} />
          <Stat label="Served" value={`${fmtNum(t.successRps)}/s`} tone="text-emerald-400" />
          <Stat label="Failed" value={`${fmtNum(t.failedRps)}/s`} tone={t.failedRps > 0 ? 'text-red-400' : undefined} />
          <Stat label="Rejected (429)" value={`${fmtNum(t.rejectedRps)}/s`} tone={t.rejectedRps > 0 ? 'text-amber-300' : undefined} />
          <Stat label="Read latency" value={`${t.readLatencyMs.toFixed(1)} ms`} />
          <Stat label="Write latency" value={`${t.writeLatencyMs.toFixed(1)} ms`} />
          <Stat label="DB reads" value={`${fmtNum(t.dbReadRps)}/s`} />
          <Stat label="DB writes" value={`${fmtNum(t.dbWriteRps)}/s`} />
          <Stat label="Cache hits" value={`${fmtNum(t.cacheHitRps)}/s`} />
          <Stat label="Queue lag" value={fmtNum(t.queueBacklog)} />
        </div>
      )}
      <h3 className="pt-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Run summary</h3>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Peak offered" value={`${fmtNum(s.peakOfferedRps)}/s`} />
        <Stat label="Peak served" value={`${fmtNum(s.peakSuccessRps)}/s`} />
        <Stat label="Error rate" value={`${(s.errorRate * 100).toFixed(2)}%`} tone={s.errorRate > 0.01 ? 'text-red-400' : 'text-emerald-400'} />
        <Stat label="Mean latency" value={`${s.avgLatencyMs.toFixed(1)} ms`} tone={s.avgLatencyMs > state.workload.latencyTargetMs ? 'text-amber-300' : undefined} tip={`Target ${state.workload.latencyTargetMs} ms`} />
        <Stat label="Availability*" value={`${(s.availability * 100).toFixed(3)}%`} tip="Modeled: product of component availabilities on the sync path." />
        <Stat label="Cost*" value={`$${Math.round(s.monthlyCostUsd).toLocaleString()}/mo`} tip="Illustrative list-price model, not a quote." />
      </div>
      <p className="text-[10.5px] text-slate-500">* Modeled estimates from explicit assumptions (see MODEL.md), not real-world benchmarks.</p>
      <div className="space-y-2">
        {ins.map((i, k) => (
          <div
            key={k}
            className={`rounded-md border px-2.5 py-2 text-xs ${
              i.level === 'bad' ? 'border-red-500/40 bg-red-500/10' : i.level === 'warn' ? 'border-amber-500/40 bg-amber-500/10' : i.level === 'good' ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-slate-700 bg-slate-900'
            }`}
          >
            <div className="font-semibold text-slate-100">{i.title}</div>
            <div className="mt-0.5 text-slate-300">{i.detail}</div>
          </div>
        ))}
      </div>
      {result.warnings.length > 0 && (
        <div className="rounded-md border border-slate-700 bg-slate-900 p-2 text-xs text-slate-400">
          <div className="mb-1 font-semibold text-slate-300">Design warnings</div>
          <ul className="list-disc space-y-0.5 pl-4">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
    </div>
  )
}

function Field({ f, value, onChange }: { f: FieldDef; value: ConfigValue | undefined; onChange: (v: ConfigValue) => void }) {
  const base = 'w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:border-sky-500 focus:outline-none'
  return (
    <label className="block" title={f.help}>
      <div className="mb-0.5 flex items-center justify-between text-[11px] text-slate-400">
        <span>
          {f.label}
          {f.help && <span className="ml-1 cursor-help text-slate-600">ⓘ</span>}
        </span>
        {f.type === 'number' && f.unit && <span className="text-slate-600">{f.unit}</span>}
      </div>
      {f.type === 'number' && (
        <input type="number" className={base} value={Number(value ?? 0)} min={f.min} max={f.max} step={f.step} onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} />
      )}
      {f.type === 'select' && (
        <select className={base} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {f.options.map((o) => <option key={o}>{o}</option>)}
        </select>
      )}
      {f.type === 'boolean' && (
        <span className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-red-500" />
          {value ? 'Down for this run' : 'Up'}
        </span>
      )}
      {f.help && f.type !== 'boolean' && <div className="mt-0.5 text-[10.5px] leading-snug text-slate-500">{f.help}</div>}
    </label>
  )
}

/** Keyboard-friendly alternative to dragging between handles. */
function Connections({ nodeId }: { nodeId: string }) {
  const { state, update } = useWS()
  const out = state.design.edges.filter((e) => e.source === nodeId)
  const label = (id: string) => state.design.nodes.find((n) => n.id === id)?.label ?? id
  const candidates = state.design.nodes.filter((n) => n.id !== nodeId && n.kind !== 'client' && !out.some((e) => e.target === n.id))
  return (
    <div className="space-y-1">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Sends requests to</h4>
      {out.length === 0 && <div className="text-xs text-slate-500">Nothing (terminal component).</div>}
      {out.map((e) => (
        <div key={e.id} className="flex items-center justify-between rounded bg-slate-900 px-2 py-1 text-xs text-slate-200">
          → {label(e.target)}
          <button className="text-slate-500 hover:text-red-300" title="Remove connection" onClick={() => update((s) => ({ ...s, design: { ...s.design, edges: s.design.edges.filter((x) => x.id !== e.id) } }))}>✕</button>
        </div>
      ))}
      {candidates.length > 0 && (
        <select
          aria-label="Add connection"
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-300"
          value=""
          onChange={(ev) => {
            const target = ev.target.value
            if (target) update((s) => ({ ...s, design: { ...s.design, edges: [...s.design.edges, { id: `e-${nodeId}-${target}-${Date.now().toString(36)}`, source: nodeId, target }] } }))
          }}
        >
          <option value="">+ Connect to…</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      )}
    </div>
  )
}

function NodePanel() {
  const ws = useWS()
  const { state, update, selected, result, tick, hasRun } = ws
  const n = state.design.nodes.find((x) => x.id === selected)!
  const spec = CATALOG[n.kind]
  const cfg = withDefaults(n.kind, n.config)
  const t = result.ticks[Math.min(hasRun ? tick : result.ticks.length - 1, result.ticks.length - 1)]
  const m: NodeTickMetrics | undefined = t?.nodes[n.id]
  const [hintIdx, setHintIdx] = useState(0)
  const hints = hintsFor(n.kind)
  const trade = TRADEOFFS[n.kind]
  const bottleneck = result.summary.bottlenecks.find((b) => b.nodeId === n.id)

  const set = (key: string, v: ConfigValue) =>
    update((s) => ({ ...s, design: { ...s.design, nodes: s.design.nodes.map((x) => (x.id === n.id ? { ...x, config: { ...x.config, [key]: v } } : x)) } }))
  const rename = (label: string) => update((s) => ({ ...s, design: { ...s.design, nodes: s.design.nodes.map((x) => (x.id === n.id ? { ...x, label } : x)) } }))
  const remove = () => {
    update((s) => ({ ...s, design: { nodes: s.design.nodes.filter((x) => x.id !== n.id), edges: s.design.edges.filter((e) => e.source !== n.id && e.target !== n.id) } }))
    ws.setSelected(null)
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-start gap-2">
        <span className="text-2xl">{spec.icon}</span>
        <div className="min-w-0 flex-1">
          <input className="w-full rounded border border-transparent bg-transparent text-sm font-semibold text-slate-100 hover:border-slate-700 focus:border-sky-500 focus:outline-none" value={n.label} onChange={(e) => rename(e.target.value)} />
          <div className="text-[11px] text-slate-500">{spec.name}</div>
        </div>
        {n.kind !== 'client' && (
          <button onClick={remove} className="rounded border border-red-500/40 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10" title="Delete component">
            Delete
          </button>
        )}
        <button onClick={() => ws.setSelected(null)} className="text-slate-500 hover:text-slate-200" title="Close panel">✕</button>
      </div>
      <p className="text-xs text-slate-400">{spec.description}</p>

      {m && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{hasRun ? `Live at t = ${t.t}s` : 'Final tick (not running)'}</h4>
            <span className={`text-xs font-semibold ${STATUS_STYLE[m.status].text}`}>{STATUS_STYLE[m.status].label}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="Offered" value={`${fmtNum(m.offered.read + m.offered.write + m.offered.async)}/s`} />
            <Stat label="Utilization" value={Number.isFinite(m.utilization) ? `${(m.utilization * 100).toFixed(0)}%` : '∞'} tone={STATUS_STYLE[m.status].text} />
            {(['read', 'write', 'async'] as const)
              .filter((k) => m.offered[k] > 0 || m.processed[k] > 0)
              .map((k) => (
                <Stat key={k} label={`${k}: done / cap`} value={`${fmtNum(m.processed[k])} / ${Number.isFinite(m.capacity[k]) ? fmtNum(m.capacity[k]) : '∞'}`} />
              ))}
            <Stat label="Latency here" value={`${Math.max(m.latencyMs.read, m.latencyMs.write, m.latencyMs.async).toFixed(1)} ms`} tip="Service time inflated by utilization + queue wait" />
            <Stat label="Queued" value={fmtNum(m.backlog)} tone={m.backlog > 0 ? 'text-amber-300' : undefined} />
            {m.failed > 0 && <Stat label="Failing" value={`${fmtNum(m.failed)}/s`} tone="text-red-400" />}
            {m.rejected > 0 && <Stat label="Rejected" value={`${fmtNum(m.rejected)}/s`} tone="text-amber-300" />}
            {(n.kind === 'cache' || n.kind === 'cdn') && <Stat label="Hits / misses" value={`${fmtNum(m.hits)} / ${fmtNum(m.misses)}`} />}
            {n.kind === 'cache' && <Stat label="Effective hit ratio" value={`${(cacheHitRatio(cfg, state.workload) * 100).toFixed(1)}%`} />}
          </div>
          <div className="flex gap-2 text-[10.5px] text-slate-500">
            <span>Cost ≈ ${Math.round(monthlyCost(n.kind, cfg)).toLocaleString()}/mo</span>·<span>Avail ≈ {(componentAvailability(n.kind, cfg) * 100).toFixed(3)}%</span>
          </div>
        </div>
      )}

      {bottleneck && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
          <div className="font-semibold">Bottleneck in this run</div>
          <div className="mt-0.5 text-red-200/90">{bottleneck.reason}</div>
          <div className="mt-2 space-y-1">
            {hints.slice(0, hintIdx).map((h, i) => <div key={i} className="rounded bg-slate-950/50 px-2 py-1 text-slate-200">💡 {h}</div>)}
            {hintIdx < hints.length && (
              <button
                className="text-sky-300 underline-offset-2 hover:underline"
                onClick={() => {
                  setHintIdx((i) => i + 1)
                  update((s) => ({ ...s, progress: { ...s.progress, hintsUsed: s.progress.hintsUsed + 1 } }))
                }}
              >
                {hintIdx === 0 ? 'Need a hint?' : 'Another hint'}
              </button>
            )}
          </div>
        </div>
      )}

      <Connections nodeId={n.id} />

      {spec.fields.length > 0 && (
        <div className="space-y-2.5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Configuration</h4>
          {spec.fields.map((f) => <Field key={f.key} f={f} value={cfg[f.key]} onChange={(v) => set(f.key, v)} />)}
        </div>
      )}

      {trade && (
        <details className="rounded-md border border-slate-800 bg-slate-900 p-2 text-xs text-slate-300">
          <summary className="cursor-pointer font-semibold text-slate-200">Trade-offs</summary>
          <p className="mt-1"><b className="text-emerald-400">Helps:</b> {trade.helps}</p>
          <p className="mt-1"><b className="text-amber-300">Limits:</b> {trade.limits}</p>
          <ul className="mt-1 list-disc pl-4 text-slate-400">{trade.risks.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
      )}

      {n.kind !== 'client' && (
        <button onClick={remove} className="w-full rounded border border-red-500/40 py-1 text-xs text-red-300 hover:bg-red-500/10">
          Remove component
        </button>
      )}
    </div>
  )
}
