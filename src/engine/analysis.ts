import { CATALOG, num, resolveConfig, str, withDefaults } from './components'
import { estimate, fmtBytes, fmtNum } from './calculator'
import type { ComponentKind, Design, SimSettings, SimSummary, Workload } from './types'

export interface Experiment {
  id: string
  name: string
  createdAt: number
  challengeId: string
  design: Design
  workload: Workload
  settings: SimSettings
  summary: SimSummary
}

export interface MetricRow {
  key: string
  label: string
  before: number
  after: number
  better: 'lower' | 'higher'
  format: (n: number) => string
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`
const nines = (a: number) => `${(a * 100).toFixed(3)}%`
const ms = (n: number) => `${n.toFixed(1)} ms`
const rps = (n: number) => `${fmtNum(n)} /s`
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}/mo`

export function metricRows(a: SimSummary, b: SimSummary): MetricRow[] {
  return [
    { key: 'peakSuccessRps', label: 'Peak successful throughput', before: a.peakSuccessRps, after: b.peakSuccessRps, better: 'higher', format: rps },
    { key: 'errorRate', label: 'Error rate (failed)', before: a.errorRate, after: b.errorRate, better: 'lower', format: pct },
    { key: 'rejectRate', label: 'Rejected (rate-limited)', before: a.rejectRate, after: b.rejectRate, better: 'lower', format: pct },
    { key: 'avgLatencyMs', label: 'Mean latency (served)', before: a.avgLatencyMs, after: b.avgLatencyMs, better: 'lower', format: ms },
    { key: 'peakLatencyMs', label: 'Worst-tick mean latency', before: a.peakLatencyMs, after: b.peakLatencyMs, better: 'lower', format: ms },
    { key: 'peakDbReadDemandRps', label: 'Peak DB read demand', before: a.peakDbReadDemandRps ?? a.peakDbReadRps, after: b.peakDbReadDemandRps ?? b.peakDbReadRps, better: 'lower', format: rps },
    { key: 'peakDbReadRps', label: 'Peak DB reads served', before: a.peakDbReadRps, after: b.peakDbReadRps, better: 'lower', format: rps },
    { key: 'peakDbWriteRps', label: 'Peak DB writes', before: a.peakDbWriteRps, after: b.peakDbWriteRps, better: 'lower', format: rps },
    { key: 'peakCacheHitRps', label: 'Peak cache hits', before: a.peakCacheHitRps, after: b.peakCacheHitRps, better: 'higher', format: rps },
    { key: 'maxQueueBacklog', label: 'Max queue lag (msgs)', before: a.maxQueueBacklog, after: b.maxQueueBacklog, better: 'lower', format: (n) => fmtNum(n) },
    { key: 'monthlyCostUsd', label: 'Est. monthly cost (illustrative)', before: a.monthlyCostUsd, after: b.monthlyCostUsd, better: 'lower', format: usd },
    { key: 'availability', label: 'Modeled availability', before: a.availability, after: b.availability, better: 'higher', format: nines },
  ]
}

// ---------------------------------------------------------------------------
// Trade-off knowledge base (why it helps / limits / new risks)

export const TRADEOFFS: Partial<Record<ComponentKind, { helps: string; limits: string; risks: string[] }>> = {
  cache: {
    helps: 'Serves repeated reads from memory, so DB read load drops to reads × (1 − hit ratio) and latency falls for hits.',
    limits: 'Writes still hit the DB. Cold starts and low-locality workloads give low hit ratios. Memory is expensive.',
    risks: ['Stale reads and invalidation bugs', 'Thundering herd / stampede when hot keys expire', 'Cache outage dumps all reads on the DB (try “Simulate outage”)'],
  },
  read_replica: {
    helps: 'Adds read capacity; reads are spread across stores by capacity.',
    limits: 'No help for writes. Every replica still applies all writes.',
    risks: ['Replication lag breaks read-your-writes', 'Failover complexity'],
  },
  sharded_db: {
    helps: 'Scales both reads and writes horizontally by splitting data across shards.',
    limits: 'Capacity is limited by the hottest shard (skew), not the average.',
    risks: ['Cross-shard queries and transactions', 'Resharding / rebalancing is operationally hard', 'Hot keys (celebrity problem)'],
  },
  queue: {
    helps: 'Moves non-critical work off the request path: callers pay only publish latency and the queue absorbs bursts.',
    limits: 'Work still has to be done. If consumers are slower than producers, lag grows without bound.',
    risks: ['Eventual consistency (counts lag)', 'Need idempotent consumers (at-least-once delivery)', 'Poison messages / DLQ handling'],
  },
  worker: {
    helps: 'Drains the queue in parallel; scale consumers to control lag.',
    limits: 'Consumers can overload the downstream store they write to.',
    risks: ['Retry storms', 'Ordering per key'],
  },
  cdn: {
    helps: 'Serves cacheable reads at the edge, cutting origin traffic and user latency.',
    limits: 'Only for cacheable, mostly-static responses.',
    risks: ['Purging/invalidation delay', 'For redirects: cached 301s hide clicks from your analytics'],
  },
  rate_limiter: {
    helps: 'Bounds the load the origin sees during spikes or abuse; excess fails fast with 429.',
    limits: 'Rejected users are still unhappy. Limits set too low reject legitimate traffic.',
    risks: ['Limiter state store becomes a dependency', 'Fail-open vs fail-closed decision'],
  },
  nosql: {
    helps: 'Horizontally scalable key-value access with tunable consistency.',
    limits: 'Write capacity is divided by the replication factor. Stronger consistency costs latency and capacity.',
    risks: ['Limited joins/transactions', 'Data modeling around access patterns'],
  },
  app_server: {
    helps: 'More instances add CPU and concurrency for stateless work.',
    limits: 'Does nothing for a saturated dependency. The bottleneck moves downstream.',
    risks: ['More DB connections (pool exhaustion)', 'Cost grows linearly'],
  },
  lock: {
    helps: 'Prevents concurrent conflicting writes (e.g. double-booking).',
    limits: 'Serializes contended operations and adds latency to every write.',
    risks: ['Lock service availability', 'Lease expiry and fencing tokens'],
  },
}

export interface DesignChange {
  kind: 'added' | 'removed' | 'config' | 'workload'
  text: string
  why?: string
  limits?: string
  risks?: string[]
}

export function diffDesigns(a: Experiment, b: Experiment): DesignChange[] {
  const out: DesignChange[] = []
  const count = (d: Design) => {
    const m = new Map<ComponentKind, number>()
    d.nodes.forEach((n) => m.set(n.kind, (m.get(n.kind) ?? 0) + 1))
    return m
  }
  const ca = count(a.design)
  const cb = count(b.design)
  const kinds = new Set<ComponentKind>([...ca.keys(), ...cb.keys()])
  for (const k of kinds) {
    const d = (cb.get(k) ?? 0) - (ca.get(k) ?? 0)
    if (d === 0) continue
    const t = TRADEOFFS[k]
    out.push({
      kind: d > 0 ? 'added' : 'removed',
      text: `${d > 0 ? 'Added' : 'Removed'} ${Math.abs(d)} × ${CATALOG[k].name}`,
      why: d > 0 ? t?.helps : undefined,
      limits: d > 0 ? t?.limits : undefined,
      risks: d > 0 ? t?.risks : undefined,
    })
  }
  const byId = new Map(a.design.nodes.map((n) => [n.id, n]))
  for (const nb of b.design.nodes) {
    const na = byId.get(nb.id)
    if (!na || na.kind !== nb.kind) continue
    const ka = withDefaults(na.kind, na.config)
    const kb = withDefaults(nb.kind, nb.config)
    for (const f of CATALOG[nb.kind].fields) {
      if (ka[f.key] === kb[f.key]) continue
      const t = TRADEOFFS[nb.kind]
      let why: string | undefined
      if (f.key === 'hitRatio') why = `DB reads behind this cache scale with (1 − hit): ${(1 - Number(ka[f.key])).toFixed(2)} → ${(1 - Number(kb[f.key])).toFixed(2)} of reads.`
      else if (f.key === 'instances') why = t?.helps
      else if (f.key === 'readReplicas') why = TRADEOFFS.read_replica?.helps
      else if (f.key === 'failed') why = kb[f.key] ? 'Failure injection: shows how the design degrades when this component is lost.' : 'Outage removed.'
      out.push({ kind: 'config', text: `${nb.label}: ${f.label} ${String(ka[f.key])} → ${String(kb[f.key])}`, why })
    }
  }
  const wf: (keyof Workload)[] = ['dau', 'requestsPerUserPerDay', 'readWriteRatio', 'peakMultiplier', 'payloadBytes']
  for (const k of wf)
    if (a.workload[k] !== b.workload[k]) out.push({ kind: 'workload', text: `Workload ${k}: ${a.workload[k].toLocaleString()} → ${b.workload[k].toLocaleString()}` })
  if (a.settings.profile !== b.settings.profile) out.push({ kind: 'workload', text: `Traffic profile: ${a.settings.profile} → ${b.settings.profile}` })
  return out
}

export function narrate(a: Experiment, b: Experiment): string[] {
  const s: string[] = []
  const A = a.summary
  const B = b.summary
  const ba = A.bottlenecks[0]
  const bb = B.bottlenecks[0]
  if (ba && !bb) s.push(`The bottleneck at ${ba.label} is gone; no component overloads in the new run.`)
  else if (!ba && bb) s.push(`A new bottleneck appeared: ${bb.label}. ${bb.reason}`)
  else if (ba && bb && ba.nodeId !== bb.nodeId) s.push(`The bottleneck moved from ${ba.label} to ${bb.label}. This is normal: fixing one constraint exposes the next one.`)
  else if (ba && bb) s.push(`${bb.label} is still the first bottleneck (peak utilization ${(ba.peakUtilization * 100).toFixed(0)}% → ${(bb.peakUtilization * 100).toFixed(0)}%).`)
  const da = A.peakDbReadDemandRps ?? A.peakDbReadRps
  const db = B.peakDbReadDemandRps ?? B.peakDbReadRps
  if (da > 0 && db < da * 0.95)
    s.push(`Peak read demand on the database fell ${((1 - db / da) * 100).toFixed(1)}% (${fmtNum(da)} → ${fmtNum(db)} /s).${A.peakDbReadRps < da * 0.99 ? ` Before, the DB could only serve ${fmtNum(A.peakDbReadRps)} /s of it.` : ''}`)
  if (B.errorRate < A.errorRate) s.push(`Errors dropped from ${pct(A.errorRate)} to ${pct(B.errorRate)}.`)
  if (B.errorRate > A.errorRate) s.push(`Errors rose from ${pct(A.errorRate)} to ${pct(B.errorRate)}.`)
  const dc = B.monthlyCostUsd - A.monthlyCostUsd
  if (Math.abs(dc) > 1) s.push(`Cost ${dc > 0 ? 'increased' : 'decreased'} by ${usd(Math.abs(dc))} (illustrative pricing).`)
  if (B.availability < A.availability - 1e-6) s.push('Modeled availability went down: more components on the critical path, or a single point of failure was added.')
  return s
}

// ---------------------------------------------------------------------------
// Contextual hints for the current run (questions, not answers)

const HINTS: Partial<Record<ComponentKind, string[]>> = {
  rdbms: [
    'Which kind of traffic is saturating it: reads or writes? Check the class breakdown.',
    'Can some of these requests be answered without touching the database at all?',
    'If reads dominate, what scales reads without changing the write path?',
    'If writes dominate, what splits the write load across machines?',
  ],
  app_server: [
    'Is it CPU-bound or blocked on a slow dependency? Compare capacity with instances × per-instance RPS.',
    'If CPU-bound: what is the cheapest way to add capacity to a stateless tier?',
    'If blocked: fix the dependency first; more instances will just open more DB connections.',
  ],
  cache: ['Is the cache sized for the working set? Try the working-set hit model.', 'What happens to the DB if this cache disappears?'],
  queue: ['Producers are faster than consumers. What controls consumer throughput?'],
  dns_lb: ['A single load balancer instance is both a capacity limit and a single point of failure.'],
  sharded_db: ['Is load spread evenly? Look at hot-shard skew and your shard key.'],
  nosql: ['Replication factor divides write capacity. Is your consistency level stronger than you need?'],
  lock: ['Every write takes the lock. Can the critical section be smaller or partitioned?'],
}

export function hintsFor(kind: ComponentKind): string[] {
  return HINTS[kind] ?? ['Compare offered load with this component’s capacity. Which input would you change?']
}

export interface Insight {
  level: 'info' | 'warn' | 'bad' | 'good'
  title: string
  detail: string
}

export function insights(design: Design, workload: Workload, summary: SimSummary): Insight[] {
  const out: Insight[] = []
  const e = estimate(workload)
  if (!summary.bottlenecks.length && summary.errorRate === 0) out.push({ level: 'good', title: 'No component overloaded', detail: `Peak ${fmtNum(summary.peakOfferedRps)} req/s served. Try a harsher scenario: 10× peak, a cache outage, or a DB failure.` })
  for (const b of summary.bottlenecks.slice(0, 3)) out.push({ level: 'bad', title: `Bottleneck: ${b.label}`, detail: b.reason })
  if (summary.avgLatencyMs > workload.latencyTargetMs) out.push({ level: 'warn', title: 'Latency target missed', detail: `Modeled mean ${summary.avgLatencyMs.toFixed(1)} ms vs target ${workload.latencyTargetMs} ms.` })
  if (summary.availability < workload.availabilityTarget) out.push({ level: 'warn', title: 'Availability below target', detail: `Modeled ${nines(summary.availability)} vs target ${nines(workload.availabilityTarget)}. Look for single instances on the request path.` })
  // storage capacity
  const needRaw = e.rawStorageBytes * 1.3
  for (const n of design.nodes) {
    const c = resolveConfig(n.kind, n.config, workload)
    let have = 0
    if (n.kind === 'rdbms') have = num(c, 'storageGb') * 1e9
    else if (n.kind === 'sharded_db') have = num(c, 'storageGbPerShard') * num(c, 'shards', 1) * 1e9
    else if (n.kind === 'nosql') have = (num(c, 'storageGbPerNode') * num(c, 'nodes', 1) * 1e9) / Math.max(1, num(c, 'replicationFactor', 1))
    else continue
    const primaryStore = design.edges.some((x) => x.target === n.id && design.nodes.find((m) => m.id === x.source)?.kind === 'app_server')
    if (primaryStore && have < needRaw)
      out.push({ level: 'warn', title: `${n.label} runs out of disk`, detail: `Needs ≈ ${fmtBytes(needRaw)} (raw + 30% index) for ${workload.retentionYears} years; configured ${fmtBytes(have)}. Full in ≈ ${Math.floor(have / (e.dailyStorageBytes * 1.3))} days.` })
  }
  for (const n of design.nodes) {
    const c = resolveConfig(n.kind, n.config, workload)
    if (n.kind === 'cache' && str(c, 'hitRatioMode') === 'fixed' && num(c, 'memoryGb') * 1e9 < e.cacheMemoryBytes * 0.5)
      out.push({ level: 'info', title: `${n.label}: is the hit ratio realistic?`, detail: `Memory ${num(c, 'memoryGb')} GB vs hot set ≈ ${fmtBytes(e.cacheMemoryBytes)}. A fixed ${num(c, 'hitRatio')} hit ratio may be optimistic; switch to the working-set model.` })
  }
  return out
}

// ---------------------------------------------------------------------------
// Interview evaluation (rule-based, transparent)

export interface EvalInput {
  design: Design
  workload: Workload
  peakSummary: SimSummary
  spikeSummary: SimSummary
  estimateAttempts: { id: string; verdict: string }[]
  notes: { requirements: string; api: string; dataModel: string; tradeoffs: string }
  experiments: number
  hintsUsed: number
}

export interface EvalCriterion {
  name: string
  score: number // 0-4
  good: string[]
  improve: string[]
  interviewer: string
}

export function evaluate(i: EvalInput): EvalCriterion[] {
  const kinds = new Set(i.design.nodes.map((n) => n.kind))
  const has = (k: ComponentKind) => kinds.has(k)
  const nodesOf = (k: ComponentKind) => i.design.nodes.filter((n) => n.kind === k).map((n) => resolveConfig(n.kind, n.config, i.workload))
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
  const c: EvalCriterion[] = []
  const clamp = (n: number) => Math.max(0, Math.min(4, n))

  {
    const w = words(i.notes.requirements)
    const good: string[] = []
    const improve: string[] = []
    if (w > 30) good.push('You wrote down requirements before designing.')
    else improve.push('Spend the first minutes clarifying scope: features in/out, scale, latency and consistency needs.')
    if (/latency|availability|consisten/i.test(i.notes.requirements)) good.push('Covered non-functional requirements.')
    else improve.push('State non-functional targets explicitly (latency, availability, consistency).')
    c.push({ name: 'Requirement clarification', score: clamp((w > 30 ? 2 : w > 0 ? 1 : 0) + (/latency|availability|consisten/i.test(i.notes.requirements) ? 2 : 0)), good, improve, interviewer: 'What is explicitly out of scope? What happens if a short link is requested that has expired?' })
  }
  {
    const tried = i.estimateAttempts.length
    const ok = i.estimateAttempts.filter((a) => a.verdict === 'exact' || a.verdict === 'close').length
    const off = i.estimateAttempts.filter((a) => a.verdict === 'off').length
    c.push({
      name: 'Workload estimation',
      score: clamp(tried === 0 ? 0 : Math.round((ok / tried) * 4) - (off > 0 ? 1 : 0)),
      good: ok ? [`${ok}/${tried} estimates within 2× of the calculated value.`] : [],
      improve: tried === 0 ? ['Estimate before revealing: interviewers expect you to derive RPS and storage yourself.'] : off ? ['Some estimates were off by >10×. Re-check unit conversions (86,400 s/day, bytes → GB).'] : [],
      interviewer: 'Walk me through how you got peak QPS. Why that multiplier?',
    })
  }
  {
    const good: string[] = []
    const improve: string[] = []
    let s = 0
    if (has('dns_lb')) { s++; good.push('Load balancer in front of the service tier.') } else improve.push('No load balancer: how do clients reach multiple app instances?')
    if (has('app_server')) s++
    if (has('rdbms') || has('nosql') || has('sharded_db')) { s++; good.push('Persistent store present.') } else improve.push('Where is data persisted?')
    if (has('cache') || has('cdn')) { s++; good.push('Read path is cached.') } else improve.push('No caching layer for a read-heavy workload.')
    c.push({ name: 'Architecture completeness', score: clamp(s), good, improve, interviewer: 'Draw the request path for a redirect and for a create. Which components does each touch?' })
  }
  {
    const p = i.peakSummary
    c.push({
      name: 'Bottleneck identification',
      score: clamp(i.experiments >= 3 ? 4 : i.experiments + (p.bottlenecks.length === 0 ? 1 : 0)),
      good: i.experiments ? [`Ran ${i.experiments} saved experiments to compare changes.`] : [],
      improve: i.experiments < 2 ? ['Save a baseline, change one thing, and compare. That is how you show you understand cause and effect.'] : [],
      interviewer: 'Which component fails first if traffic doubles, and how do you know?',
    })
  }
  {
    const p = i.peakSummary
    const over = p.bottlenecks.length
    c.push({
      name: 'Capacity planning',
      score: clamp(over === 0 ? (p.errorRate === 0 ? 4 : 3) : over === 1 ? 2 : 1),
      good: over === 0 ? ['Design survives the configured peak without overload.'] : [],
      improve: over ? p.bottlenecks.map((b) => `${b.label} overloads at peak: ${b.reason}`) : [],
      interviewer: 'How much headroom do you keep, and what is your scale-out trigger?',
    })
  }
  {
    const w = words(i.notes.dataModel) + words(i.notes.api)
    c.push({
      name: 'Data modeling & APIs',
      score: clamp(w > 60 ? 4 : w > 25 ? 3 : w > 0 ? 1 : 0),
      good: w > 25 ? ['APIs/data model described.'] : [],
      improve: w <= 25 ? ['Define APIs (e.g. POST /urls, GET /{code}) and the schema with primary key and indexes.'] : [],
      interviewer: 'What is the primary key, and how do you guarantee short-code uniqueness across app servers?',
    })
  }
  {
    const s = i.spikeSummary
    c.push({
      name: 'Scalability',
      score: clamp(s.errorRate < 0.01 ? 4 : s.errorRate < 0.05 ? 3 : s.errorRate < 0.2 ? 2 : 1),
      good: s.errorRate < 0.01 ? ['Handles a 10× spike with < 1% errors.'] : [],
      improve: s.errorRate >= 0.01 ? [`Under 10× peak, ${pct(s.errorRate)} of requests fail. First bottleneck: ${s.bottlenecks[0]?.label ?? 'n/a'}.`] : [],
      interviewer: 'Traffic grows 10× next year. What changes in this design?',
    })
  }
  {
    const p = i.peakSummary
    const single = i.design.nodes.filter((n) => ['dns_lb', 'app_server'].includes(n.kind) && num(withDefaults(n.kind, n.config), 'instances', 1) < 2).map((n) => n.label)
    const dbNoReplica = nodesOf('rdbms').some((x) => num(x, 'readReplicas') === 0)
    c.push({
      name: 'Availability & fault tolerance',
      score: clamp((p.availability >= i.workload.availabilityTarget ? 2 : 0) + (single.length === 0 ? 1 : 0) + (dbNoReplica ? 0 : 1)),
      good: p.availability >= i.workload.availabilityTarget ? [`Modeled availability ${nines(p.availability)} meets target.`] : [],
      improve: [...(single.length ? [`Single instance on the critical path: ${single.join(', ')}.`] : []), ...(dbNoReplica ? ['Primary DB has no replica to fail over to.'] : [])],
      interviewer: 'The primary database dies at peak. What happens in the next 60 seconds?',
    })
  }
  {
    const t = i.notes.tradeoffs
    const hit = /consisten|stale|eventual|lag|invalidat/i.test(t)
    c.push({
      name: 'Consistency trade-offs',
      score: clamp((hit ? 3 : 0) + (words(t) > 40 ? 1 : 0)),
      good: hit ? ['Discussed staleness/consistency.'] : [],
      improve: hit ? [] : ['Caches, replicas and queues all introduce staleness. Say which reads can tolerate it.'],
      interviewer: 'A user edits a link and immediately clicks it. Can they see the old target?',
    })
  }
  {
    c.push({
      name: 'Security & rate limiting',
      score: has('rate_limiter') ? (has('api_gateway') ? 4 : 3) : 1,
      good: has('rate_limiter') ? ['Rate limiting protects the origin.'] : [],
      improve: has('rate_limiter') ? [] : ['No protection against abusive clients or spikes. Consider limits on link creation.'],
      interviewer: 'Someone scripts 1M link creations per minute. What stops them?',
    })
  }
  {
    const p = i.peakSummary
    const e = estimate(i.workload)
    const appInst = nodesOf('app_server').reduce((s, x) => s + num(x, 'instances', 1), 0)
    const over = appInst > e.appInstances * 3
    c.push({
      name: 'Cost awareness',
      score: clamp(over ? 2 : 4 - (p.monthlyCostUsd > 20000 ? 1 : 0)),
      good: !over ? ['Compute sized close to calculated need.'] : [],
      improve: over ? [`${appInst} app instances vs ~${e.appInstances} calculated. Over-provisioning is a cost smell.`] : [],
      interviewer: 'What are the top cost drivers, and how would you cut cost 30%?',
    })
  }
  {
    const w = words(i.notes.tradeoffs)
    c.push({
      name: 'Communication of trade-offs',
      score: clamp(w > 80 ? 4 : w > 40 ? 3 : w > 10 ? 2 : 0) - (i.hintsUsed > 4 ? 1 : 0),
      good: w > 40 ? ['Wrote down the trade-offs of the chosen design.'] : [],
      improve: w <= 40 ? ['For each component you add, state why, what it costs, and what new failure mode it introduces.'] : [],
      interviewer: 'What would you do differently with half the budget?',
    })
  }
  return c
}
