/**
 * Deterministic discrete-time traffic simulator.
 *
 * Model (all assumptions are explicit and documented in MODEL.md):
 *  - Traffic is a fluid: each tick moves `rate × dt` requests through the graph.
 *  - Nodes are processed in topological order; flow reaching a node in a tick is
 *    served in the same tick (no propagation delay beyond the per-hop latency).
 *  - Each node has a per-class capacity (req/s if it served only that class).
 *    Busy time = Σ demand_k / capacity_k. If busy time exceeds dt, the remainder
 *    queues. Queued work beyond `timeout` seconds fails (timeouts / overflow).
 *  - Service latency inflates with utilization ρ (multi-server approximation):
 *        latency = base × (1 + 0.5 × ρ⁶ / (1 − ρ)),  ρ capped at 0.95
 *    plus queue wait = remaining backlog work (seconds).
 *  - App servers are limited by concurrency (Little's law):
 *        throughput ≤ instances × maxConcurrent ÷ (processing + downstream latency)
 *    using the previous tick's downstream latency, so slow databases cascade upstream.
 */
import { CATALOG, componentAvailability, monthlyCost, num, str } from './components'
import { estimate } from './calculator'
import {
  CLASSES,
  type Bottleneck,
  type ClassRates,
  type ComponentConfig,
  type ComponentKind,
  type Design,
  type EdgeTickMetrics,
  type HealthStatus,
  type NodeTickMetrics,
  type RequestClass,
  type SimResult,
  type SimSettings,
  type TickResult,
  type Workload,
} from './types'
import type { Category } from './components'

export const HOP_MS = 0.5
export const DEGRADED_UTIL = 0.7
export const DOWNSTREAM_EMA = 0.3
export const DEFAULT_SETTINGS: SimSettings = { profile: 'ramp', dt: 1, ticks: 60 }

const zero = (): ClassRates => ({ read: 0, write: 0, async: 0 })
const sum = (c: ClassRates) => c.read + c.write + c.async

interface ModelNode {
  id: string
  kind: ComponentKind
  label: string
  cfg: ComponentConfig
  category: Category
  targets: string[]
}

export interface Model {
  nodes: Map<string, ModelNode>
  order: string[]
  clients: string[]
  edgeId: Map<string, string>
  warnings: string[]
  syncReachable: Set<string>
}

const key = (s: string, t: string) => `${s}->${t}`
const TERMINAL: Category[] = ['store', 'sidecar']

export function buildModel(design: Design): Model {
  const warnings: string[] = []
  const nodes = new Map<string, ModelNode>()
  for (const n of design.nodes) {
    nodes.set(n.id, {
      id: n.id,
      kind: n.kind,
      label: n.label,
      cfg: { ...CATALOG[n.kind].defaults, ...n.config },
      category: CATALOG[n.kind].category,
      targets: [],
    })
  }
  const edgeId = new Map<string, string>()
  for (const e of design.edges) {
    const s = nodes.get(e.source)
    const t = nodes.get(e.target)
    if (!s || !t || s.id === t.id || edgeId.has(key(s.id, t.id))) continue
    if (t.kind === 'client') continue
    edgeId.set(key(s.id, t.id), e.id)
    if (TERMINAL.includes(s.category)) continue // stores are terminal; edges out of them are informational
    s.targets.push(t.id)
  }

  // Look-aside caches with no outgoing edge: misses fall back to the stores the cache's callers use.
  for (const c of nodes.values()) {
    if (c.category !== 'cache' || c.targets.length) continue
    const fallback = new Set<string>()
    for (const p of nodes.values()) {
      if (!p.targets.includes(c.id)) continue
      for (const t of p.targets) if (nodes.get(t)?.category === 'store') fallback.add(t)
    }
    for (const t of fallback) {
      c.targets.push(t)
      edgeId.set(key(c.id, t), `virtual:${c.id}->${t}`)
    }
  }

  // Break cycles (DFS back-edges) so the flow is a DAG.
  const state = new Map<string, 0 | 1 | 2>()
  const dfs = (id: string) => {
    state.set(id, 1)
    const n = nodes.get(id)!
    n.targets = n.targets.filter((t) => {
      const st = state.get(t) ?? 0
      if (st === 1) {
        warnings.push(`Cycle ignored: ${n.label} → ${nodes.get(t)!.label}`)
        return false
      }
      if (st === 0) dfs(t)
      return true
    })
    state.set(id, 2)
  }
  const clients = [...nodes.values()].filter((n) => n.kind === 'client').map((n) => n.id)
  for (const c of clients) if (!state.get(c)) dfs(c)
  for (const n of nodes.keys()) if (!state.get(n)) dfs(n)

  // Kahn topological order.
  const indeg = new Map<string, number>([...nodes.keys()].map((k) => [k, 0]))
  for (const n of nodes.values()) for (const t of n.targets) indeg.set(t, indeg.get(t)! + 1)
  const queue = [...nodes.keys()].filter((k) => indeg.get(k) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const t of nodes.get(id)!.targets) {
      indeg.set(t, indeg.get(t)! - 1)
      if (indeg.get(t) === 0) queue.push(t)
    }
  }

  // Reachability (sync path excludes queue → worker hops).
  const syncReachable = new Set<string>()
  const allReachable = new Set<string>()
  const walk = (id: string, sync: boolean) => {
    if (sync) syncReachable.add(id)
    allReachable.add(id)
    const n = nodes.get(id)!
    for (const t of n.targets) {
      const childSync = sync && n.category !== 'async'
      if ((childSync && !syncReachable.has(t)) || !allReachable.has(t)) walk(t, childSync)
    }
  }
  clients.forEach((c) => walk(c, true))

  if (!clients.length) warnings.push('Add a Client: it is the traffic source.')
  for (const c of clients) if (!nodes.get(c)!.targets.length) warnings.push('The Client is not connected to anything.')
  for (const n of nodes.values())
    if (n.kind !== 'client' && !allReachable.has(n.id)) warnings.push(`${n.label} receives no traffic (not reachable from a Client).`)

  return { nodes, order, clients, edgeId, warnings, syncReachable }
}

// ---------------------------------------------------------------------------
// Capacity & latency per component

interface Capacity {
  cap: ClassRates // req/s; 0 = cannot serve this class
  lat: ClassRates // base ms
  timeoutMs: number
}

function capacityOf(n: ModelNode, downstreamMs: number, ctx: { consumerCap: number }): Capacity {
  const c = n.cfg
  const both = (cap: number, lat: number): Capacity => ({
    cap: { read: cap, write: cap, async: cap },
    lat: { read: lat, write: lat, async: lat },
    timeoutMs: num(c, 'timeoutMs', 1000),
  })
  switch (n.kind) {
    case 'client':
      return both(Infinity, 0)
    case 'dns_lb':
    case 'api_gateway':
      return both(num(c, 'instances', 1) * num(c, 'rpsPerInstance'), num(c, 'latencyMs'))
    case 'rate_limiter':
      return both(num(c, 'rpsCapacity'), num(c, 'latencyMs'))
    case 'app_server': {
      const inst = num(c, 'instances', 1)
      const proc = num(c, 'processingMs')
      const cpu = inst * num(c, 'rpsPerInstance')
      const conc = (inst * num(c, 'maxConcurrent') * 1000) / Math.max(proc + downstreamMs, 0.001)
      return both(Math.min(cpu, conc), proc)
    }
    case 'cache':
    case 'cdn':
      return both(num(c, 'rpsCapacity'), num(c, 'latencyMs'))
    case 'rdbms': {
      const pool = num(c, 'connectionPool', 1)
      const rl = num(c, 'readLatencyMs', 1)
      const wl = num(c, 'writeLatencyMs', 1)
      const replicas = num(c, 'readReplicas')
      const read = Math.min(num(c, 'readRps'), (pool * 1000) / rl) * (1 + replicas)
      const write = Math.min(num(c, 'writeRps'), (pool * 1000) / wl)
      return { cap: { read, write, async: write }, lat: { read: rl, write: wl, async: wl }, timeoutMs: num(c, 'timeoutMs', 1000) }
    }
    case 'read_replica': {
      const rl = num(c, 'readLatencyMs', 1)
      const read = Math.min(num(c, 'readRps'), (num(c, 'connectionPool', 1) * 1000) / rl)
      return { cap: { read, write: 0, async: 0 }, lat: { read: rl, write: 0, async: 0 }, timeoutMs: num(c, 'timeoutMs', 1000) }
    }
    case 'nosql': {
      const nodes = num(c, 'nodes', 1)
      const rf = Math.max(1, num(c, 'replicationFactor', 1))
      const mode = str(c, 'consistency', 'eventual')
      const touched = mode === 'strong' ? rf : mode === 'quorum' ? Math.floor(rf / 2) + 1 : 1
      const latMul = mode === 'strong' ? 2 : mode === 'quorum' ? 1.5 : 1
      const read = (nodes * num(c, 'readRpsPerNode')) / touched
      const write = (nodes * num(c, 'writeRpsPerNode')) / rf
      const rl = num(c, 'readLatencyMs', 1) * latMul
      const wl = num(c, 'writeLatencyMs', 1) * latMul
      return { cap: { read, write, async: write }, lat: { read: rl, write: wl, async: wl }, timeoutMs: num(c, 'timeoutMs', 1000) }
    }
    case 'sharded_db': {
      const shards = num(c, 'shards', 1)
      const skew = Math.max(1, num(c, 'hotShardSkew', 1))
      const read = (shards * num(c, 'readRpsPerShard')) / skew
      const write = (shards * num(c, 'writeRpsPerShard')) / skew
      const rl = num(c, 'readLatencyMs', 1)
      const wl = num(c, 'writeLatencyMs', 1)
      return { cap: { read, write, async: write }, lat: { read: rl, write: wl, async: wl }, timeoutMs: num(c, 'timeoutMs', 1000) }
    }
    case 'object_storage': {
      const l = num(c, 'latencyMs')
      return { cap: { read: num(c, 'readRps'), write: num(c, 'writeRps'), async: num(c, 'writeRps') }, lat: { read: l, write: l, async: l }, timeoutMs: num(c, 'timeoutMs', 2000) }
    }
    case 'search': {
      const nodes = num(c, 'nodes', 1)
      const l = num(c, 'latencyMs')
      const w = nodes * num(c, 'indexRpsPerNode')
      return { cap: { read: nodes * num(c, 'queryRpsPerNode'), write: w, async: w }, lat: { read: l, write: l, async: l }, timeoutMs: num(c, 'timeoutMs', 1000) }
    }
    case 'queue': {
      const broker = num(c, 'partitions', 1) * num(c, 'rpsPerPartition')
      const l = num(c, 'enqueueLatencyMs')
      return { cap: { read: 0, write: 0, async: Math.min(broker, Math.max(ctx.consumerCap, 0)) }, lat: { read: 0, write: 0, async: l }, timeoutMs: Infinity }
    }
    case 'worker': {
      const cap = num(c, 'instances', 1) * num(c, 'rpsPerInstance')
      const l = num(c, 'processingMs')
      return { cap: { read: cap, write: cap, async: cap }, lat: { read: l, write: l, async: l }, timeoutMs: Infinity }
    }
    case 'lock': {
      const cap = num(c, 'rpsCapacity')
      const l = num(c, 'latencyMs')
      return { cap: { read: 0, write: cap, async: 0 }, lat: { read: 0, write: l, async: 0 }, timeoutMs: num(c, 'timeoutMs', 500) }
    }
  }
}

/** Utilization → latency multiplier. Exported for tests/docs. */
export function latencyInflation(rho: number): number {
  const r = Math.min(Math.max(rho, 0), 0.95)
  return 1 + (0.5 * Math.pow(r, 6)) / (1 - r)
}

export function trafficMultiplier(profile: SimSettings['profile'], t: number, ticks: number, peak: number): number {
  const x = ticks <= 1 ? 0 : t / (ticks - 1)
  const lerp = (a: number, b: number, u: number) => a + (b - a) * Math.min(1, Math.max(0, u))
  switch (profile) {
    case 'average':
      return 1
    case 'peak':
      return peak
    case 'ramp':
      if (x < 0.15) return 1
      if (x < 0.35) return lerp(1, peak, (x - 0.15) / 0.2)
      if (x < 0.75) return peak
      if (x < 0.9) return lerp(peak, 1, (x - 0.75) / 0.15)
      return 1
    case 'spike':
      if (x < 0.3) return 1
      if (x < 0.34) return lerp(1, peak, (x - 0.3) / 0.04)
      if (x < 0.55) return peak
      if (x < 0.6) return lerp(peak, 1, (x - 0.55) / 0.05)
      return 1
  }
}

/** Hit ratio of a cache node, given the workload's working set. */
export function cacheHitRatio(cfg: ComponentConfig, workload: Workload): number {
  if (str(cfg, 'hitRatioMode', 'fixed') !== 'working-set') return Math.min(1, Math.max(0, num(cfg, 'hitRatio')))
  const ws = estimate(workload).cacheMemoryBytes
  const mem = num(cfg, 'memoryGb') * 1e9
  const k = { LFU: 0.4, LRU: 0.5, TTL: 0.6 }[str(cfg, 'eviction', 'LRU')] ?? 0.5
  const coverage = ws <= 0 ? 1 : Math.min(1, mem / ws)
  return 0.95 * Math.pow(coverage, k)
}

// ---------------------------------------------------------------------------

interface Share {
  target: string
  to: RequestClass
  /** fraction of this node's processed `from` traffic */
  fraction: number
  sync: boolean
}

export function simulate(design: Design, workload: Workload, settings: SimSettings = DEFAULT_SETTINGS): SimResult {
  const model = buildModel(design)
  const { nodes, order } = model
  const dt = Math.max(0.01, settings.dt)
  const est = estimate(workload)
  const readFrac = est.readFraction
  const backlog = new Map<string, ClassRates>([...nodes.keys()].map((k) => [k, zero()]))
  const prevDownstream = new Map<string, number>()
  const unrouted = new Set<string>()
  const ticks: TickResult[] = []

  for (let t = 0; t < settings.ticks; t++) {
    const mult = trafficMultiplier(settings.profile, t, settings.ticks, workload.peakMultiplier)
    const offeredRps = est.avgRps * mult
    const inflow = new Map<string, ClassRates>([...nodes.keys()].map((k) => [k, zero()]))
    const metrics: Record<string, NodeTickMetrics> = {}
    const edges: Record<string, EdgeTickMetrics> = {}
    const shares = new Map<string, Record<RequestClass, Share[]>>()
    let syncBacklogBefore = 0
    for (const [id, b] of backlog) if (nodes.get(id)!.category !== 'async') syncBacklogBefore += b.read + b.write

    for (const c of model.clients) {
      const per = (offeredRps * dt) / model.clients.length
      inflow.get(c)!.read += per * readFrac
      inflow.get(c)!.write += per * (1 - readFrac)
    }

    // Consumer capacity downstream of each queue (for delivery limits).
    const workerCap = (qid: string) =>
      nodes
        .get(qid)!
        .targets.map((w) => nodes.get(w)!)
        .filter((w) => w.kind === 'worker' && w.cfg.failed !== true)
        .reduce((s, w) => s + num(w.cfg, 'instances', 1) * num(w.cfg, 'rpsPerInstance'), 0)

    const send = (from: string, to: string, cls: RequestClass, amount: number) => {
      if (amount <= 0) return
      inflow.get(to)![cls] += amount
      const eid = model.edgeId.get(key(from, to))!
      const e = (edges[eid] ??= { rate: 0, read: 0, write: 0, async: 0 })
      e[cls] += amount / dt
      e.rate += amount / dt
    }

    for (const id of order) {
      const n = nodes.get(id)!
      const inc = inflow.get(id)!
      const b = backlog.get(id)!
      const cap = capacityOf(n, prevDownstream.get(id) ?? 0, { consumerCap: n.kind === 'queue' ? workerCap(id) : 0 })
      const m: NodeTickMetrics = {
        offered: { read: inc.read / dt, write: inc.write / dt, async: inc.async / dt },
        processed: zero(),
        failed: 0,
        rejected: 0,
        backlog: 0,
        utilization: 0,
        capacity: cap.cap,
        latencyMs: zero(),
        hits: 0,
        misses: 0,
        status: 'idle',
      }
      metrics[id] = m
      const out = zero() // requests leaving this node toward downstream, per class
      const nodeShares: Record<RequestClass, Share[]> = { read: [], write: [], async: [] }
      shares.set(id, nodeShares)
      const isFailed = n.cfg.failed === true

      // --- Rate limiter: reject above limit (not queued).
      if (n.kind === 'rate_limiter' && !isFailed) {
        const limit = num(n.cfg, 'limitRps') * dt
        const total = sum(inc)
        if (total > limit) {
          const keep = limit / total
          m.rejected = (total - limit) / dt
          for (const k of CLASSES) inc[k] *= keep
        }
      }

      if (isFailed) {
        if (n.category === 'cache' && str(n.cfg, 'onFailure') === 'fallthrough') {
          m.misses = inc.read / dt
          out.read = inc.read
          out.write = inc.write
          m.processed = { read: 0, write: 0, async: 0 }
        } else {
          m.failed = (sum(inc) + sum(b)) / dt
          backlog.set(id, zero())
        }
        m.status = 'failed'
      } else if (n.category === 'cache' || n.category === 'edge') {
        // Caches don't queue: overflow beyond capacity is a miss (fallthrough) or an error.
        const total = inc.read + inc.write
        const capTick = cap.cap.read * dt
        const overflow = total > capTick ? (total - capTick) / total : 0
        const served = 1 - overflow
        const h = n.kind === 'cdn' ? Math.min(1, Math.max(0, num(n.cfg, 'hitRatio'))) : cacheHitRatio(n.cfg, workload)
        const fallthrough = n.kind === 'cdn' || str(n.cfg, 'onFailure', 'fallthrough') === 'fallthrough'
        const hits = inc.read * served * h
        const misses = inc.read * served * (1 - h) + (fallthrough ? inc.read * overflow : 0)
        m.hits = hits / dt
        m.misses = misses / dt
        if (!fallthrough) m.failed += (inc.read * overflow) / dt
        out.read = misses
        out.write = inc.write
        m.processed = { read: (inc.read * served) / dt, write: inc.write / dt, async: 0 }
        m.utilization = cap.cap.read > 0 ? total / dt / cap.cap.read : 0
        const lat = cap.lat.read * latencyInflation(m.utilization)
        m.latencyMs = { read: lat, write: lat, async: 0 }
      } else if (n.kind === 'queue') {
        const broker = num(n.cfg, 'partitions', 1) * num(n.cfg, 'rpsPerPartition') * dt
        const published = Math.min(inc.async, broker)
        m.failed = (inc.async - published) / dt
        const available = b.async + published
        const delivered = Math.min(available, cap.cap.async * dt)
        b.async = available - delivered
        out.async = delivered
        m.processed.async = delivered / dt
        m.backlog = b.async
        m.utilization = cap.cap.async > 0 ? inc.async / dt / cap.cap.async : inc.async > 0 ? Infinity : 0
        m.latencyMs.async = cap.lat.async
      } else {
        // Generic capacity + queue + timeout model.
        let work = 0
        const demand = zero()
        for (const k of CLASSES) {
          demand[k] = b[k] + inc[k]
          if (demand[k] <= 0) continue
          if (cap.cap[k] <= 0) {
            m.failed += demand[k] / dt // this component cannot serve this class
            unrouted.add(`${n.label} cannot handle ${k} requests.`)
            demand[k] = 0
            continue
          }
          work += demand[k] / cap.cap[k]
        }
        const frac = work > dt ? dt / work : 1
        let remainingWork = 0
        const remaining = zero()
        for (const k of CLASSES) {
          const done = demand[k] * frac
          m.processed[k] = done / dt
          remaining[k] = demand[k] - done
          if (cap.cap[k] > 0) remainingWork += remaining[k] / cap.cap[k]
        }
        const timeoutS = cap.timeoutMs / 1000
        if (remainingWork > timeoutS) {
          const keep = timeoutS / remainingWork
          for (const k of CLASSES) {
            m.failed += (remaining[k] * (1 - keep)) / dt
            remaining[k] *= keep
          }
          remainingWork = timeoutS
        }
        backlog.set(id, remaining)
        m.backlog = sum(remaining)
        let rho = 0
        for (const k of CLASSES) if (cap.cap[k] > 0 && Number.isFinite(cap.cap[k])) rho += inc[k] / dt / cap.cap[k]
        m.utilization = rho
        const inflate = latencyInflation(rho)
        for (const k of CLASSES) m.latencyMs[k] = cap.lat[k] * inflate + remainingWork * 1000
        for (const k of CLASSES) out[k] = m.processed[k] * dt
      }

      // --- Route processed traffic downstream.
      route(n, out, m)

      // Status
      if (m.status !== 'failed') {
        const anyTraffic = sum(m.offered) > 0 || m.backlog > 0
        if (!anyTraffic) m.status = 'idle'
        else if (n.kind === 'queue') {
          const lagS = cap.cap.async > 0 ? m.backlog / cap.cap.async : m.backlog > 0 ? Infinity : 0
          m.status = m.failed > 0 || lagS > 30 ? 'overloaded' : lagS > 1 ? 'degraded' : 'healthy'
        } else if (m.failed > 1e-9 || m.utilization >= 1) m.status = 'overloaded'
        else if (m.utilization >= DEGRADED_UTIL || m.backlog > 1e-6 || m.rejected > 0) m.status = 'degraded'
        else m.status = 'healthy'
      }

      function route(node: ModelNode, o: ClassRates, met: NodeTickMetrics) {
        const targets = node.targets.map((t) => nodes.get(t)!)
        if (!targets.length) return // terminal: served here
        const push = (cls: RequestClass, amount: number, list: ModelNode[], weights: number[], to: RequestClass = cls, sync = true) => {
          if (amount <= 0 || !list.length) return
          const total = weights.reduce((a, x) => a + x, 0)
          const base = node.category === 'cache' || node.category === 'edge' ? (cls === 'read' ? inc.read : inc[cls]) : met.processed[cls] * dt
          list.forEach((tn, i) => {
            const part = total > 0 ? (amount * weights[i]) / total : amount / list.length
            send(node.id, tn.id, to, part)
            if (base > 0) nodeShares[cls].push({ target: tn.id, to, fraction: part / base, sync })
          })
        }
        const fail = (cls: RequestClass, amount: number) => {
          if (amount <= 0) return
          met.failed += amount / dt
          unrouted.add(`${node.label} has no downstream component that can handle ${cls} requests.`)
        }

        if (node.kind === 'queue') {
          const workers = targets.filter((x) => x.kind === 'worker' && x.cfg.failed !== true)
          push('async', o.async, workers, workers.map((w) => num(w.cfg, 'instances', 1) * num(w.cfg, 'rpsPerInstance')), 'async', false)
          return
        }
        const tier = targets.filter((x) => ['proxy', 'compute', 'edge'].includes(x.category))
        if (tier.length) {
          const healthy = tier.filter((x) => x.cfg.failed !== true)
          const pool = healthy.length ? healthy : tier // LB health checks skip failed targets
          const even = pool.map(() => 1)
          push('read', o.read, pool, even)
          push('write', o.write, pool, even)
          if (node.kind === 'worker') push('async', o.async, pool, even, 'write', false)
          return
        }
        const caches = targets.filter((x) => x.category === 'cache')
        const stores = targets.filter((x) => x.category === 'store')
        const queues = targets.filter((x) => x.category === 'async')
        const locks = targets.filter((x) => x.category === 'sidecar')
        const capOf = (x: ModelNode, cls: 'read' | 'write') => capacityOf(x, 0, { consumerCap: 0 }).cap[cls]
        const readStores = stores.filter((x) => capOf(x, 'read') > 0)
        const writeStores = stores.filter((x) => capOf(x, 'write') > 0)

        // Reads: cache first, else stores weighted by read capacity.
        if (node.category !== 'cache' && caches.length) push('read', o.read, caches, caches.map(() => 1))
        else if (readStores.length) push('read', o.read, readStores, readStores.map((x) => capOf(x, 'read')))
        else fail('read', o.read)

        // Writes (worker async events become writes)
        const writes = o.write
        const asyncWrites = node.kind === 'worker' ? o.async : 0
        if (writeStores.length) {
          const w = writeStores.map((x) => capOf(x, 'write'))
          push('write', writes, writeStores, w)
          push('async', asyncWrites, writeStores, w, 'write', false)
        } else if (caches.length && node.category !== 'cache') push('write', writes, caches, caches.map(() => 1))
        else fail('write', writes + asyncWrites)

        // Locks: every write acquires a lock synchronously.
        if (locks.length) push('write', writes, locks, locks.map(() => 1))

        // Side-effect events (e.g. click analytics)
        const epr = node.kind === 'app_server' ? num(node.cfg, 'eventsPerRequest') : 0
        if (epr > 0) {
          const events = (o.read + o.write) * epr
          if (queues.length) {
            queues.forEach((q) => send(node.id, q.id, 'async', events / queues.length))
            // Publishing is fire-and-forget: only the publish latency is on the request path.
            for (const cls of ['read', 'write'] as const)
              if (o[cls] > 0) for (const q of queues) nodeShares[cls].push({ target: q.id, to: 'async', fraction: epr / queues.length, sync: true })
          } else if (writeStores.length) {
            const w = writeStores.map((x) => capOf(x, 'write'))
            const tw = w.reduce((a, x) => a + x, 0)
            writeStores.forEach((s, i) => send(node.id, s.id, 'write', (events * w[i]) / tw))
            for (const cls of ['read', 'write'] as const)
              if (o[cls] > 0) writeStores.forEach((s, i) => nodeShares[cls].push({ target: s.id, to: 'write', fraction: (epr * w[i]) / tw, sync: true }))
          }
        }
      }
    }

    // --- End-to-end latency via routing shares (memoized, DAG).
    const memo = new Map<string, number>()
    const e2e = (id: string, cls: RequestClass): number => {
      const k = `${id}|${cls}`
      if (memo.has(k)) return memo.get(k)!
      memo.set(k, 0)
      const m = metrics[id]
      let v = m.latencyMs[cls]
      if (nodes.get(id)!.kind === 'queue') v = num(nodes.get(id)!.cfg, 'enqueueLatencyMs')
      else
        for (const s of shares.get(id)?.[cls] ?? []) {
          if (!s.sync) continue
          v += s.fraction * (HOP_MS + e2e(s.target, s.to))
        }
      memo.set(k, v)
      return v
    }
    for (const id of order) {
      const n = nodes.get(id)!
      if (n.kind !== 'app_server') continue
      const m = metrics[id]
      const tot = m.processed.read + m.processed.write
      const down = tot > 0 ? (m.processed.read * (e2e(id, 'read') - m.latencyMs.read) + m.processed.write * (e2e(id, 'write') - m.latencyMs.write)) / tot : prevDownstream.get(id) ?? 0
      // EMA damping: thread pools respond to downstream slowness gradually, which avoids tick-to-tick oscillation.
      const prev = prevDownstream.get(id)
      prevDownstream.set(id, (prev ?? 0) + DOWNSTREAM_EMA * (Math.max(0, down) - (prev ?? 0)))
    }

    let readLat = 0
    let writeLat = 0
    if (model.clients.length) {
      readLat = model.clients.reduce((s, c) => s + e2e(c, 'read'), 0) / model.clients.length
      writeLat = model.clients.reduce((s, c) => s + e2e(c, 'write'), 0) / model.clients.length
    }

    let failed = 0
    let rejected = 0
    let dbRead = 0
    let dbWrite = 0
    let dbReadDemand = 0
    let hits = 0
    let qBacklog = 0
    let syncBacklogAfter = 0
    for (const [id, m] of Object.entries(metrics)) {
      const n = nodes.get(id)!
      if (n.category !== 'async' && n.category !== 'worker') failed += m.failed
      rejected += m.rejected
      if (n.category === 'store' && n.kind !== 'search') {
        dbRead += m.processed.read
        dbReadDemand += m.offered.read
        dbWrite += m.processed.write + m.processed.async
      }
      hits += m.hits
      if (n.kind === 'queue') qBacklog += m.backlog
      else if (n.category !== 'worker') syncBacklogAfter += backlog.get(id)!.read + backlog.get(id)!.write
    }
    const reachedAnything = model.clients.some((c) => nodes.get(c)!.targets.length > 0)
    const success = reachedAnything
      ? Math.min(offeredRps, Math.max(0, offeredRps - failed - rejected - (syncBacklogAfter - syncBacklogBefore) / dt))
      : 0
    if (!reachedAnything) failed = offeredRps

    ticks.push({
      t: t * dt,
      offeredRps,
      successRps: success,
      failedRps: Math.min(failed, offeredRps),
      rejectedRps: rejected,
      readLatencyMs: readLat,
      writeLatencyMs: writeLat,
      avgLatencyMs: readLat * readFrac + writeLat * (1 - readFrac),
      dbReadRps: dbRead,
      dbWriteRps: dbWrite,
      dbReadDemandRps: dbReadDemand,
      cacheHitRps: hits,
      queueBacklog: qBacklog,
      nodes: metrics,
      edges,
    })
  }

  const warnings = [...model.warnings, ...unrouted]
  return { ticks, summary: summarize(model, ticks, dt), warnings }
}

function summarize(model: Model, ticks: TickResult[], dt: number) {
  const totalRequests = ticks.reduce((s, t) => s + t.offeredRps * dt, 0)
  const totalFailed = ticks.reduce((s, t) => s + t.failedRps * dt, 0)
  const totalRejected = ticks.reduce((s, t) => s + t.rejectedRps * dt, 0)
  const served = ticks.reduce((s, t) => s + t.successRps * dt, 0)
  const avgLatencyMs = served > 0 ? ticks.reduce((s, t) => s + t.avgLatencyMs * t.successRps * dt, 0) / served : 0

  const bottlenecks: Bottleneck[] = []
  for (const [id, n] of model.nodes) {
    let first = -1
    let peakU = 0
    let failedReq = 0
    let worst: NodeTickMetrics | undefined
    for (let i = 0; i < ticks.length; i++) {
      const m = ticks[i].nodes[id]
      if (!m) continue
      if (Number.isFinite(m.utilization) && m.utilization > peakU) peakU = m.utilization
      failedReq += m.failed * dt
      if (m.status === 'overloaded' || m.status === 'failed') {
        if (first < 0) first = i
        if (!worst || m.utilization > worst.utilization || m.failed > worst.failed) worst = m
      }
    }
    if (first >= 0 && worst) bottlenecks.push({ nodeId: id, label: n.label, kind: n.kind, firstTick: first, peakUtilization: peakU, failedRequests: failedReq, reason: explainOverload(n, worst) })
  }
  bottlenecks.sort((a, b) => a.firstTick - b.firstTick || b.peakUtilization - a.peakUtilization)

  let availability = 1
  for (const id of model.syncReachable) {
    const n = model.nodes.get(id)!
    availability *= componentAvailability(n.kind, n.cfg)
  }
  const monthlyCostUsd = [...model.nodes.values()].reduce((s, n) => s + monthlyCost(n.kind, n.cfg), 0)

  return {
    peakOfferedRps: Math.max(0, ...ticks.map((t) => t.offeredRps)),
    peakSuccessRps: Math.max(0, ...ticks.map((t) => t.successRps)),
    totalRequests,
    totalFailed,
    totalRejected,
    errorRate: totalRequests > 0 ? totalFailed / totalRequests : 0,
    rejectRate: totalRequests > 0 ? totalRejected / totalRequests : 0,
    avgLatencyMs,
    peakLatencyMs: Math.max(0, ...ticks.filter((t) => t.successRps > 0).map((t) => t.avgLatencyMs)),
    peakDbReadRps: Math.max(0, ...ticks.map((t) => t.dbReadRps)),
    peakDbWriteRps: Math.max(0, ...ticks.map((t) => t.dbWriteRps)),
    peakDbReadDemandRps: Math.max(0, ...ticks.map((t) => t.dbReadDemandRps)),
    peakCacheHitRps: Math.max(0, ...ticks.map((t) => t.cacheHitRps)),
    maxQueueBacklog: Math.max(0, ...ticks.map((t) => t.queueBacklog)),
    monthlyCostUsd,
    availability: model.clients.some((c) => model.nodes.get(c)!.targets.length > 0) ? availability : 0,
    bottlenecks,
  }
}

const r = (n: number) => Math.round(n).toLocaleString('en-US')

function explainOverload(n: ModelNode, m: NodeTickMetrics): string {
  if (m.status === 'failed') return `${n.label} is down (simulated outage). Every request routed to it fails unless something can absorb or reroute it.`
  if (n.kind === 'queue')
    return `Consumers deliver ${r(m.processed.async)} msg/s but producers publish ${r(m.offered.async)} msg/s, so consumer lag grows to ${r(m.backlog)} messages.`
  if (n.kind === 'rate_limiter') return `Rejecting ${r(m.rejected)} req/s above the configured limit.`
  if (n.kind === 'app_server') {
    const cpu = num(n.cfg, 'instances', 1) * num(n.cfg, 'rpsPerInstance')
    if (m.capacity.read < cpu * 0.99)
      return `Thread/concurrency exhaustion: requests block on slow downstream calls, so ${r(num(n.cfg, 'instances', 1) * num(n.cfg, 'maxConcurrent'))} concurrent slots only sustain ${r(m.capacity.read)} req/s (CPU limit would be ${r(cpu)} req/s). Offered ${r(m.offered.read + m.offered.write)} req/s. Fix the slow dependency first.`
  }
  const parts: string[] = []
  for (const k of CLASSES) {
    if (m.offered[k] <= 0) continue
    parts.push(`${k} ${r(m.offered[k])}/s vs capacity ${Number.isFinite(m.capacity[k]) ? r(m.capacity[k]) : '∞'}/s`)
  }
  return `Offered ${parts.join(', ')} (utilization ${(m.utilization * 100).toFixed(0)}%). Excess work queues and latency climbs toward the timeout${m.failed > 0 ? `; ${r(m.failed)} req/s time out and fail` : ''}.`
}

export type { HealthStatus }
