import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  getBezierPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import { CATALOG, num, withDefaults } from '../engine/components'
import { fmtNum } from '../engine/calculator'
import { buildModel } from '../engine/simulate'
import type { ComponentKind, EdgeTickMetrics, HealthStatus, NodeTickMetrics } from '../engine/types'
import { node as makeNode } from '../data/challenges'
import { useWS } from './store'

export const STATUS_STYLE: Record<HealthStatus, { ring: string; text: string; bg: string; label: string; color: string }> = {
  idle: { ring: 'border-slate-600', text: 'text-slate-400', bg: 'bg-slate-500', label: 'Idle', color: '#64748b' },
  healthy: { ring: 'border-emerald-500/70', text: 'text-emerald-400', bg: 'bg-emerald-500', label: 'Healthy', color: '#10b981' },
  degraded: { ring: 'border-amber-400', text: 'text-amber-300', bg: 'bg-amber-400', label: 'Degraded', color: '#f59e0b' },
  overloaded: { ring: 'border-red-500', text: 'text-red-400', bg: 'bg-red-500', label: 'Overloaded', color: '#ef4444' },
  failed: { ring: 'border-zinc-500 border-dashed', text: 'text-zinc-400', bg: 'bg-zinc-600', label: 'Down', color: '#71717a' },
}

const CLASS_COLOR = { read: '#38bdf8', write: '#fb923c', async: '#a78bfa' }

type CompNodeData = {
  kind: ComponentKind
  label: string
  config: Record<string, unknown>
  m?: NodeTickMetrics
  showMetrics: boolean
  playing: boolean
}
type CompNode = Node<CompNodeData, 'component'>

function summaryLine(kind: ComponentKind, cfg: Record<string, unknown>): string {
  const c = withDefaults(kind, cfg as never)
  switch (kind) {
    case 'app_server':
    case 'dns_lb':
    case 'api_gateway':
    case 'worker':
      return `${num(c, 'instances', 1)} × ${fmtNum(num(c, 'rpsPerInstance'))}/s`
    case 'cache':
      return c.hitRatioMode === 'working-set' ? `${num(c, 'memoryGb')} GB · working-set` : `hit ${(num(c, 'hitRatio') * 100).toFixed(0)}% · ${num(c, 'memoryGb')} GB`
    case 'rdbms':
      return `R ${fmtNum(num(c, 'readRps'))}/s · W ${fmtNum(num(c, 'writeRps'))}/s${num(c, 'readReplicas') ? ` · +${num(c, 'readReplicas')} rep` : ''}`
    case 'read_replica':
      return `R ${fmtNum(num(c, 'readRps'))}/s`
    case 'nosql':
      return `${num(c, 'nodes')} nodes · RF ${num(c, 'replicationFactor')}`
    case 'sharded_db':
      return `${num(c, 'shards')} shards · skew ${num(c, 'hotShardSkew')}`
    case 'queue':
      return `${num(c, 'partitions')} partitions`
    case 'rate_limiter':
      return `limit ${fmtNum(num(c, 'limitRps'))}/s`
    case 'cdn':
      return `edge hit ${(num(c, 'hitRatio') * 100).toFixed(0)}%`
    case 'lock':
      return `${fmtNum(num(c, 'rpsCapacity'))} ops/s`
    case 'search':
      return `${num(c, 'nodes')} nodes`
    case 'object_storage':
      return `R ${fmtNum(num(c, 'readRps'))}/s`
    default:
      return ''
  }
}

const ComponentNode = memo(function ComponentNode({ id, data, selected }: NodeProps<CompNode>) {
  const { update, setSelected } = useWS()
  const spec = CATALOG[data.kind]
  const remove = () => {
    update((s) => ({ ...s, design: { nodes: s.design.nodes.filter((n) => n.id !== id), edges: s.design.edges.filter((e) => e.source !== id && e.target !== id) } }))
    setSelected(null)
  }
  const m = data.showMetrics ? data.m : undefined
  const status: HealthStatus = data.config.failed ? 'failed' : (m?.status ?? 'idle')
  const st = STATUS_STYLE[status]
  const util = m ? Math.min(m.utilization, 2) : 0
  const inRate = m ? m.offered.read + m.offered.write + m.offered.async : 0
  const backlogFrac = m && m.backlog > 0 ? Math.min(1, m.backlog / Math.max(1, (m.capacity.read || m.capacity.async || m.capacity.write) * 1)) : 0
  const isCache = data.kind === 'cache' || data.kind === 'cdn'
  const hitPct = m && m.hits + m.misses > 0 ? m.hits / (m.hits + m.misses) : 0

  return (
    <div
      className={`relative w-[190px] rounded-lg border-2 bg-slate-900/95 px-2.5 py-2 text-left shadow-lg transition-colors ${st.ring} ${selected ? 'ring-2 ring-sky-400 ring-offset-2 ring-offset-slate-950' : ''} ${status === 'overloaded' ? 'node-overloaded' : ''}`}
      title={spec.description}
    >
      {selected && data.kind !== 'client' && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); remove() }}
          className="nodrag absolute -right-2.5 -top-2.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-red-400/60 bg-slate-950 text-[11px] leading-none text-red-300 shadow hover:bg-red-500 hover:text-white"
          title="Delete component (or press Delete)"
          aria-label={`Delete ${data.label}`}
        >
          ✕
        </button>
      )}
      {data.kind !== 'client' && <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-slate-900 !bg-slate-400" />}
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-slate-900 !bg-sky-400" />
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none">{spec.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-slate-100">{data.label}</div>
          <div className="truncate text-[10.5px] text-slate-400">{summaryLine(data.kind, data.config)}</div>
        </div>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.bg} ${status === 'overloaded' ? 'animate-ping-slow' : ''}`} title={st.label} />
      </div>

      {m && data.kind !== 'client' && (
        <div className="mt-1.5 space-y-1">
          <div className="flex items-center justify-between text-[10.5px]">
            <span className="text-slate-400">in {fmtNum(inRate)}/s</span>
            <span className={st.text}>{Number.isFinite(m.utilization) ? `${(m.utilization * 100).toFixed(0)}%` : '∞'} util</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-slate-800">
            <div className="h-full rounded transition-all duration-300" style={{ width: `${Math.min(100, util * 50)}%`, background: st.color }} />
          </div>
          {isCache && m.hits + m.misses > 0 && (
            <div className="flex h-1.5 overflow-hidden rounded bg-slate-800" title={`hits ${fmtNum(m.hits)}/s · misses ${fmtNum(m.misses)}/s`}>
              <div className="h-full bg-emerald-500" style={{ width: `${hitPct * 100}%` }} />
              <div className="h-full bg-sky-700" style={{ width: `${(1 - hitPct) * 100}%` }} />
            </div>
          )}
          {isCache && <div className="text-[10px] text-slate-400">hit {fmtNum(m.hits)}/s · miss {fmtNum(m.misses)}/s</div>}
          {(m.processed.read > 0 || m.processed.write > 0) && ['rdbms', 'nosql', 'sharded_db', 'read_replica', 'object_storage', 'search'].includes(data.kind) && (
            <div className="text-[10px] text-slate-400">
              <span style={{ color: CLASS_COLOR.read }}>R {fmtNum(m.processed.read)}</span> ·{' '}
              <span style={{ color: CLASS_COLOR.write }}>W {fmtNum(m.processed.write + m.processed.async)}</span> /s
            </div>
          )}
          {m.backlog > 0.5 && (
            <div title={`${fmtNum(m.backlog)} requests queued`}>
              <div className="flex justify-between text-[10px] text-amber-300">
                <span>queue {fmtNum(m.backlog)}</span>
                <span>{fmtNum(Math.max(m.latencyMs.read, m.latencyMs.write, m.latencyMs.async))} ms</span>
              </div>
              <div className="flex h-1.5 gap-px overflow-hidden">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className={`h-full flex-1 rounded-sm ${i / 12 < (data.kind === 'queue' ? Math.min(1, Math.log10(m.backlog + 1) / 6) : backlogFrac) ? 'bg-amber-400' : 'bg-slate-800'}`} />
                ))}
              </div>
            </div>
          )}
          {m.failed > 0.01 && <div className="rounded bg-red-500/15 px-1 py-0.5 text-[10.5px] font-semibold text-red-400">✕ {fmtNum(m.failed)}/s failing</div>}
          {m.rejected > 0.01 && <div className="rounded bg-amber-500/15 px-1 py-0.5 text-[10.5px] font-semibold text-amber-300">⛔ {fmtNum(m.rejected)}/s rejected (429)</div>}
        </div>
      )}
      {m && m.failed > 0.01 && data.playing && (
        <div className="pointer-events-none absolute -bottom-1 left-1/2 h-0 w-0">
          {[0, 1, 2].map((i) => (
            <span key={i} className="drop-particle" style={{ animationDelay: `${i * 0.33}s`, left: `${(i - 1) * 14}px` }} />
          ))}
        </div>
      )}
    </div>
  )
})

type FlowEdgeData = { em?: EdgeTickMetrics; playing: boolean; virtual?: boolean; targetStatus?: HealthStatus }
type FlowEdgeT = Edge<FlowEdgeData, 'flow'>

const FlowEdge = memo(function FlowEdge(p: EdgeProps<FlowEdgeT>) {
  const { update } = useWS()
  const [path, lx, ly] = getBezierPath(p)
  const em = p.data?.em
  const rate = em?.rate ?? 0
  const width = rate > 0 ? Math.min(6, 1.2 + Math.log10(rate + 1) * 0.9) : 1.2
  const hot = p.data?.targetStatus === 'overloaded' || p.data?.targetStatus === 'failed'
  const stroke = p.selected ? '#38bdf8' : rate > 0 ? (hot ? '#ef4444' : '#475569') : '#334155'
  const dots: { cls: keyof typeof CLASS_COLOR; i: number; n: number }[] = []
  if (em && p.data?.playing) {
    for (const cls of ['read', 'write', 'async'] as const) {
      const r = em[cls]
      if (r <= 0.01) continue
      const n = Math.max(1, Math.min(6, Math.round(Math.log10(r + 1) * 1.5)))
      for (let i = 0; i < n; i++) dots.push({ cls, i, n })
    }
  }
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={{ stroke, strokeWidth: width, strokeDasharray: p.data?.virtual ? '5 5' : undefined, opacity: p.data?.virtual ? 0.6 : 1 }} />
      {dots.map((d) => (
        <circle key={`${d.cls}-${d.i}`} r={d.cls === 'read' ? 3 : 3.5} fill={CLASS_COLOR[d.cls]}>
          {/* negative begin = start mid-flight, so no particle sits at the origin waiting */}
          <animateMotion dur={`${hot ? 2.6 : 1.6}s`} repeatCount="indefinite" begin={`-${(d.i / d.n) * (hot ? 2.6 : 1.6) + (d.cls === 'write' ? 0.2 : d.cls === 'async' ? 0.4 : 0)}s`} path={path} />
        </circle>
      ))}
      {(rate > 0 || (p.selected && !p.data?.virtual)) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute flex items-center gap-1 rounded bg-slate-950/90 px-1 text-[10px] text-slate-300"
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, pointerEvents: p.selected ? 'all' : 'none' }}
          >
            {rate > 0 && <span>{fmtNum(rate)}/s{p.data?.virtual ? ' (miss fallback)' : ''}</span>}
            {p.selected && !p.data?.virtual && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); update((s) => ({ ...s, design: { ...s.design, edges: s.design.edges.filter((x) => x.id !== p.id) } })) }}
                className="flex h-4 w-4 items-center justify-center rounded-full border border-red-400/60 text-[9px] text-red-300 hover:bg-red-500 hover:text-white"
                title="Delete connection (or press Delete)"
                aria-label="Delete connection"
              >
                ✕
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

const nodeTypes = { component: ComponentNode }
const edgeTypes = { flow: FlowEdge }

export function Canvas() {
  const ws = useWS()
  const { state, update, result, tick, hasRun, playing, selected, setSelected } = ws
  const rf = useReactFlow()
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const t = hasRun ? result.ticks[Math.min(tick, result.ticks.length - 1)] : undefined

  // Refit the viewport when a whole design is loaded (starter, reference, saved design, challenge switch).
  const prevCount = useRef(state.design.nodes.length)
  useEffect(() => {
    const n = state.design.nodes.length
    if (Math.abs(n - prevCount.current) > 1) window.setTimeout(() => rf.fitView({ padding: 0.2, maxZoom: 1.1, duration: 300 }), 30)
    prevCount.current = n
  }, [state.design.nodes.length, rf])

  const nodes: CompNode[] = useMemo(
    () =>
      state.design.nodes.map((n) => ({
        id: n.id,
        type: 'component',
        position: n.position,
        selected: n.id === selected,
        data: { kind: n.kind, label: n.label, config: n.config, m: t?.nodes[n.id], showMetrics: hasRun, playing },
      })),
    [state.design.nodes, selected, t, hasRun, playing],
  )

  const virtualEdges = useMemo(() => {
    const m = buildModel(state.design)
    const out: { id: string; source: string; target: string }[] = []
    for (const [k, id] of m.edgeId) if (id.startsWith('virtual:')) out.push({ id, source: k.split('->')[0], target: k.split('->')[1] })
    return out
  }, [state.design])

  const edges: FlowEdgeT[] = useMemo(
    () =>
      [...state.design.edges.map((e) => ({ ...e, virtual: false })), ...virtualEdges.map((e) => ({ ...e, virtual: true }))].map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'flow',
        interactionWidth: 18,
        deletable: !e.virtual,
        selectable: !e.virtual,
        selected: e.id === selectedEdge,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b', width: 16, height: 16 },
        data: { em: t?.edges[e.id], playing, virtual: e.virtual, targetStatus: t?.nodes[e.target]?.status },
      })),
    [state.design.edges, virtualEdges, t, playing, selectedEdge],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<CompNode>[]) => {
      const removed = new Set<string>()
      for (const c of changes) {
        if (c.type === 'remove' && c.id !== 'client-locked') removed.add(c.id)
        if (c.type === 'select' && c.selected) {
          setSelected(c.id)
          setSelectedEdge(null)
        }
      }
      const moved = applyNodeChanges(
        changes.filter((c) => c.type === 'position' || c.type === 'dimensions'),
        nodes,
      )
      const pos = new Map(moved.map((n) => [n.id, n.position]))
      if (!changes.some((c) => c.type === 'position') && !removed.size) return
      update((s) => ({
        ...s,
        design: {
          nodes: s.design.nodes.filter((n) => !removed.has(n.id)).map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })),
          edges: s.design.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
        },
      }))
      if (removed.size && selected && removed.has(selected)) setSelected(null)
    },
    [nodes, update, selected, setSelected],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdgeT>[]) => {
      for (const c of changes)
        if (c.type === 'select') setSelectedEdge((cur) => (c.selected ? c.id : cur === c.id ? null : cur))
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
      if (!removed.size) return
      update((s) => ({ ...s, design: { ...s.design, edges: s.design.edges.filter((e) => !removed.has(e.id)) } }))
    },
    [update],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      update((s) => {
        if (s.design.edges.some((e) => e.source === c.source && e.target === c.target)) return s
        return { ...s, design: { ...s.design, edges: [...s.design.edges, { id: `e-${c.source}-${c.target}-${Date.now().toString(36)}`, source: c.source!, target: c.target! }] } }
      })
    },
    [update],
  )

  const onDrop = useCallback(
    (ev: DragEvent) => {
      ev.preventDefault()
      const kind = ev.dataTransfer.getData('application/hld-component') as ComponentKind
      if (!kind || !CATALOG[kind]) return
      const p = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      const n = makeNode(kind, p.x - 95, p.y - 30, {}, undefined, `${kind}-${Date.now().toString(36)}`)
      update((s) => ({ ...s, design: { ...s.design, nodes: [...s.design.nodes, n] } }))
      setSelected(n.id)
    },
    [rf, update, setSelected],
  )

  return (
    <div className="relative h-full w-full" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={() => { setSelected(null); setSelectedEdge(null) }}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
        colorMode="dark"
        deleteKeyCode={['Backspace', 'Delete']}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="#1e293b" />
        <Controls position="bottom-left" />
        <MiniMap pannable zoomable style={{ width: 150, height: 96 }} className="!bg-slate-900" nodeColor={(n) => STATUS_STYLE[((n.data as CompNodeData).m?.status ?? 'idle') as HealthStatus].color} maskColor="rgba(2,6,23,0.7)" />
      </ReactFlow>
      {state.design.nodes.length <= 1 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="max-w-sm rounded-lg border border-dashed border-slate-700 bg-slate-900/80 p-4 text-center text-sm text-slate-400">
            Drag components from the left panel onto the canvas, then drag from a node’s right handle to another node’s left handle to define the request flow.
          </div>
        </div>
      )}
      <Legend />
    </div>
  )
}

function Legend() {
  return (
    <div className="pointer-events-none absolute right-3 top-3 flex flex-wrap gap-3 rounded-md border border-slate-800 bg-slate-950/85 px-2.5 py-1.5 text-[10.5px] text-slate-400">
      {(['healthy', 'degraded', 'overloaded', 'failed'] as const).map((s) => (
        <span key={s} className="flex items-center gap-1">
          <span className={`h-2 w-2 rounded-full ${STATUS_STYLE[s].bg}`} /> {STATUS_STYLE[s].label}
        </span>
      ))}
      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: CLASS_COLOR.read }} /> read</span>
      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: CLASS_COLOR.write }} /> write</span>
      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: CLASS_COLOR.async }} /> async</span>
    </div>
  )
}
