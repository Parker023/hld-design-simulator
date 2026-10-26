import { describe, expect, it } from 'vitest'
import { simulate, latencyInflation, trafficMultiplier } from './simulate'
import { estimate } from './calculator'
import { CHALLENGES, edge, node } from '../data/challenges'
import type { ComponentConfig, Design, SimSettings, Workload } from './types'

const url = CHALLENGES.find((c) => c.id === 'url-shortener')!
const W: Workload = url.workload
const PEAK: SimSettings = { profile: 'peak', dt: 1, ticks: 20 }
const AVG: SimSettings = { profile: 'average', dt: 1, ticks: 20 }
const last = <T,>(a: T[]) => a[a.length - 1]

/** client → lb → app → [cache] → db */
function design(opts: { app?: ComponentConfig; db?: ComponentConfig; cache?: ComponentConfig | false; cacheInline?: boolean } = {}): Design {
  const c = node('client', 0, 0, {}, 'Client', 'client')
  const lb = node('dns_lb', 0, 0, {}, 'LB', 'lb')
  const app = node('app_server', 0, 0, { instances: 4, ...opts.app }, 'App', 'app')
  const db = node('rdbms', 0, 0, { readRps: 2000, writeRps: 500, ...opts.db }, 'DB', 'db')
  const d: Design = { nodes: [c, lb, app, db], edges: [edge(c, lb), edge(lb, app)] }
  if (opts.cache) {
    const cache = node('cache', 0, 0, opts.cache, 'Redis', 'cache')
    d.nodes.push(cache)
    d.edges.push(edge(app, cache))
    if (opts.cacheInline) d.edges.push(edge(cache, db))
  }
  d.edges.push(edge(app, db))
  return d
}

describe('simulation engine', () => {
  it('is deterministic', () => {
    const a = simulate(url.starter, W)
    const b = simulate(url.starter, W)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('routes requests through the configured graph and conserves traffic when healthy', () => {
    const r = simulate(design(), W, AVG)
    const t = last(r.ticks)
    const e = estimate(W)
    expect(t.offeredRps).toBeCloseTo(e.avgRps, 6)
    expect(t.nodes.app.offered.read + t.nodes.app.offered.write).toBeCloseTo(e.avgRps, 6)
    expect(t.nodes.db.processed.read).toBeCloseTo(e.avgReadRps, 6)
    expect(t.nodes.db.processed.write).toBeCloseTo(e.avgWriteRps, 6)
    expect(t.failedRps).toBe(0)
    expect(t.successRps).toBeCloseTo(e.avgRps, 6)
    expect(r.summary.bottlenecks).toHaveLength(0)
  })

  it('an undersized database becomes the bottleneck at peak', () => {
    const r = simulate(design(), W, PEAK)
    const t0 = r.ticks[0]
    expect(t0.nodes.db.offered.read).toBeGreaterThan(t0.nodes.db.capacity.read)
    expect(t0.nodes.db.status).toBe('overloaded')
    expect(r.summary.errorRate).toBeGreaterThan(0.1)
    expect(r.summary.bottlenecks[0].nodeId).toBe('db')
    // DB latency climbs toward the timeout as work queues; throughput settles near DB capacity
    expect(t0.nodes.db.latencyMs.read).toBeGreaterThan(500)
    expect(last(r.ticks).successRps).toBeLessThan(2100)
  })

  it('a slow database cascades into app-server thread exhaustion (Little’s law)', () => {
    const r = simulate(design({ app: { maxConcurrent: 50 } }), W, PEAK)
    const first = r.ticks[0].nodes.app.capacity.read
    const later = last(r.ticks).nodes.app.capacity.read
    expect(later).toBeLessThan(first)
  })

  it('Redis reduces DB read load by exactly (1 − hit ratio)', () => {
    for (const h of [0.5, 0.8, 0.9, 0.95]) {
      const r = simulate(design({ cache: { hitRatio: h } }), W, PEAK)
      const t = last(r.ticks)
      const e = estimate(W)
      expect(t.nodes.cache.hits).toBeCloseTo(e.peakReadRps * h, 6)
      expect(t.nodes.db.processed.read).toBeCloseTo(e.peakReadRps * (1 - h), 6)
      expect(t.dbReadRps).toBeCloseTo(e.peakReadRps * (1 - h), 6)
      expect(t.dbReadDemandRps).toBeCloseTo(e.peakReadRps * (1 - h), 6)
      // relative to no cache, demand falls by exactly the hit ratio
      const base = simulate(design(), W, PEAK).summary.peakDbReadDemandRps
      expect(base).toBeCloseTo(e.peakReadRps, 6)
      expect(1 - r.summary.peakDbReadDemandRps / base).toBeCloseTo(h, 9)
    }
  })

  it('inline cache (app → cache → db) behaves the same for reads', () => {
    const a = last(simulate(design({ cache: { hitRatio: 0.9 } }), W, PEAK).ticks)
    const b = last(simulate(design({ cache: { hitRatio: 0.9 }, cacheInline: true }), W, PEAK).ticks)
    expect(b.nodes.db.processed.read).toBeCloseTo(a.nodes.db.processed.read, 6)
  })

  it('adding Redis removes the DB bottleneck, and 10× traffic exposes the app tier next', () => {
    const fixed = simulate(design({ cache: { hitRatio: 0.9 } }), W, PEAK)
    expect(fixed.summary.errorRate).toBe(0)
    expect(last(fixed.ticks).nodes.db.status).not.toBe('overloaded')

    const spike = simulate(design({ cache: { hitRatio: 0.9 } }), { ...W, peakMultiplier: 10 }, PEAK)
    const names = spike.summary.bottlenecks.map((b) => b.nodeId)
    expect(names[0]).toBe('app')
    expect(spike.summary.errorRate).toBeGreaterThan(0)
  })

  it('read replicas add read capacity', () => {
    const r0 = last(simulate(design(), W, PEAK).ticks).nodes.db.capacity.read
    const r2 = last(simulate(design({ db: { readReplicas: 2 } }), W, PEAK).ticks).nodes.db.capacity.read
    expect(r2).toBeCloseTo(r0 * 3, 6)
  })

  it('connection pool caps throughput by Little’s law', () => {
    const t = last(simulate(design({ db: { connectionPool: 5, readLatencyMs: 5, readRps: 100000 } }), W, AVG).ticks)
    expect(t.nodes.db.capacity.read).toBeCloseTo((5 * 1000) / 5, 6)
  })

  it('cache outage with fallthrough sends all reads to the DB', () => {
    const t = simulate(design({ cache: { hitRatio: 0.9, failed: true } }), W, PEAK).ticks[0]
    const e = estimate(W)
    expect(t.nodes.cache.status).toBe('failed')
    expect(t.nodes.db.offered.read).toBeCloseTo(e.peakReadRps, 6)
    expect(t.nodes.db.status).toBe('overloaded')
  })

  it('cache outage with fail mode fails reads instead', () => {
    const r = simulate(design({ cache: { hitRatio: 0.9, failed: true, onFailure: 'fail' } }), W, PEAK)
    const e = estimate(W)
    expect(last(r.ticks).failedRps).toBeCloseTo(e.peakReadRps, 6)
  })

  it('rate limiter rejects traffic above its limit instead of queueing', () => {
    const c = node('client', 0, 0, {}, 'C', 'client')
    const rl = node('rate_limiter', 0, 0, { limitRps: 2000 }, 'RL', 'rl')
    const app = node('app_server', 0, 0, { instances: 10 }, 'App', 'app')
    const r = simulate({ nodes: [c, rl, app], edges: [edge(c, rl), edge(rl, app)] }, W, PEAK)
    const t = last(r.ticks)
    expect(t.rejectedRps).toBeCloseTo(estimate(W).peakRps - 2000, 6)
    expect(t.nodes.app.offered.read + t.nodes.app.offered.write).toBeCloseTo(2000, 6)
    expect(t.failedRps).toBe(0)
  })

  it('queue lag grows linearly when consumers are slower than producers', () => {
    const c = node('client', 0, 0, {}, 'C', 'client')
    const app = node('app_server', 0, 0, { instances: 10, eventsPerRequest: 1 }, 'App', 'app')
    const db = node('rdbms', 0, 0, { readRps: 100000, writeRps: 100000 }, 'DB', 'db')
    const q = node('queue', 0, 0, {}, 'Q', 'q')
    const w = node('worker', 0, 0, { instances: 2, rpsPerInstance: 500 }, 'W', 'w')
    const an = node('nosql', 0, 0, {}, 'An', 'an')
    const d: Design = { nodes: [c, app, db, q, w, an], edges: [edge(c, app), edge(app, db), edge(app, q), edge(q, w), edge(w, an)] }
    const r = simulate(d, W, PEAK)
    const rate = estimate(W).peakRps
    const t = last(r.ticks)
    expect(t.nodes.q.processed.async).toBeCloseTo(1000, 6)
    expect(t.queueBacklog).toBeCloseTo((rate - 1000) * PEAK.ticks, 3)
    expect(t.nodes.an.processed.write).toBeCloseTo(1000, 6)
    // async events do not count as user-facing failures
    expect(r.summary.errorRate).toBe(0)
  })

  it('without a queue, side-effect events become synchronous DB writes', () => {
    const t = last(simulate(design({ app: { eventsPerRequest: 1 }, db: { writeRps: 10000 } }), W, AVG).ticks)
    const e = estimate(W)
    expect(t.nodes.db.offered.write).toBeCloseTo(e.avgWriteRps + e.avgRps, 6)
  })

  it('sharded DB capacity accounts for hot-shard skew', () => {
    const c = node('client', 0, 0, {}, 'C', 'client')
    const s = node('sharded_db', 0, 0, { shards: 4, readRpsPerShard: 1000, hotShardSkew: 2 }, 'S', 's')
    const t = last(simulate({ nodes: [c, s], edges: [edge(c, s)] }, W, AVG).ticks)
    expect(t.nodes.s.capacity.read).toBeCloseTo(2000, 6)
  })

  it('load balancer skips failed app instances', () => {
    const c = node('client', 0, 0, {}, 'C', 'client')
    const lb = node('dns_lb', 0, 0, {}, 'LB', 'lb')
    const a1 = node('app_server', 0, 0, { instances: 4 }, 'A1', 'a1')
    const a2 = node('app_server', 0, 0, { instances: 4, failed: true }, 'A2', 'a2')
    const t = last(simulate({ nodes: [c, lb, a1, a2], edges: [edge(c, lb), edge(lb, a1), edge(lb, a2)] }, W, AVG).ticks)
    expect(t.nodes.a2.offered.read).toBe(0)
    expect(t.failedRps).toBe(0)
  })

  it('reports unroutable writes', () => {
    const c = node('client', 0, 0, {}, 'C', 'client')
    const app = node('app_server', 0, 0, {}, 'App', 'app')
    const rr = node('read_replica', 0, 0, { readRps: 100000 }, 'RR', 'rr')
    const r = simulate({ nodes: [c, app, rr], edges: [edge(c, app), edge(app, rr)] }, W, AVG)
    expect(r.warnings.some((w) => w.includes('write'))).toBe(true)
    expect(last(r.ticks).failedRps).toBeCloseTo(estimate(W).avgWriteRps, 6)
  })

  it('latency inflation and traffic profile helpers', () => {
    expect(latencyInflation(0)).toBe(1)
    expect(latencyInflation(0.9)).toBeGreaterThan(latencyInflation(0.5))
    expect(trafficMultiplier('ramp', 0, 60, 3)).toBe(1)
    expect(trafficMultiplier('ramp', 30, 60, 3)).toBe(3)
    expect(trafficMultiplier('peak', 5, 60, 7)).toBe(7)
  })
})
