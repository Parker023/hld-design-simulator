import { describe, expect, it } from 'vitest'
import { CATALOG, monthlyCost, resolveConfig } from './components'
import { HW, hardwareDerivations } from './hardware'
import { estimate } from './calculator'
import { simulate } from './simulate'
import { CHALLENGES, edge, node } from '../data/challenges'
import type { ComponentKind, Design } from './types'

const W = CHALLENGES.find((c) => c.id === 'url-shortener')!.workload
const PEAK = { profile: 'peak' as const, dt: 1, ticks: 10 }
const last = <T,>(a: T[]) => a[a.length - 1]

describe('hardware sizing', () => {
  it('default machine sizes reproduce the manual default capacities', () => {
    const expectSame = (kind: ComponentKind, keys: string[]) => {
      const hw = resolveConfig(kind, {}, W)
      const manual = resolveConfig(kind, { sizing: 'manual' }, W)
      for (const k of keys) expect([kind, k, hw[k]]).toEqual([kind, k, manual[k]])
    }
    expectSame('app_server', ['rpsPerInstance', 'maxConcurrent'])
    expectSame('dns_lb', ['rpsPerInstance'])
    expectSame('api_gateway', ['rpsPerInstance'])
    expectSame('rate_limiter', ['rpsCapacity'])
    expectSame('worker', ['rpsPerInstance'])
    expectSame('lock', ['rpsCapacity'])
    expectSame('cache', ['memoryGb', 'rpsCapacity'])
    expectSame('rdbms', ['readRps', 'writeRps', 'storageGb'])
    expectSame('read_replica', ['readRps'])
    expectSame('sharded_db', ['readRpsPerShard', 'writeRpsPerShard', 'storageGbPerShard'])
    expectSame('nosql', ['readRpsPerNode', 'writeRpsPerNode', 'storageGbPerNode'])
    expectSame('search', ['queryRpsPerNode', 'indexRpsPerNode'])
  })

  it('app server: cores drive throughput, RAM caps concurrency', () => {
    expect(resolveConfig('app_server', { vcpu: 8 }).rpsPerInstance).toBe(8 * 500)
    expect(resolveConfig('app_server', { vcpu: 8, rpsPerCore: 200 }).rpsPerInstance).toBe(1600)
    // 8 cores allow 800 threads, but 2 GB ÷ 20 MB = 102 requests fit in memory
    expect(resolveConfig('app_server', { vcpu: 8, ramGb: 2 }).maxConcurrent).toBe(Math.floor((2 * 1024) / 20))
  })

  it('Redis: usable memory is a fraction of RAM; extra cores stop helping', () => {
    expect(resolveConfig('cache', { ramGb: 64 }).memoryGb).toBeCloseTo(64 * HW.redisUsableRam, 9)
    expect(resolveConfig('cache', { vcpu: 4 }).rpsCapacity).toBe(200_000)
    expect(resolveConfig('cache', { vcpu: 16 }).rpsCapacity).toBe(200_000)
  })

  it('SQL: too little RAM for the hot set sends reads to disk (slower, and IOPS-bound on HDD)', () => {
    const roomy = resolveConfig('rdbms', { ramGb: 64 }, W)
    const tight = resolveConfig('rdbms', { ramGb: 4 }, W)
    const tightHdd = resolveConfig('rdbms', { ramGb: 4, diskType: 'hdd' }, W)
    expect(Number(tight.effectiveReadLatencyMs)).toBeGreaterThan(Number(roomy.effectiveReadLatencyMs))
    const hot = estimate(W).cacheMemoryBytes
    const miss = 1 - (4 * HW.sqlBufferPoolRam * 1e9) / hot
    expect(tightHdd.readRps).toBeCloseTo((250 * 0.5) / miss, 6)
    expect(Number(tightHdd.readRps)).toBeLessThan(Number(roomy.readRps))
  })

  it('SQL: HDD limits write throughput through IOPS', () => {
    expect(resolveConfig('rdbms', { diskType: 'hdd' }, W).writeRps).toBeCloseTo((250 * 0.5) / 2, 9)
    expect(resolveConfig('rdbms', { diskGb: 5000 }, W).storageGb).toBe(5000)
  })

  it('hardware changes flow into the simulation', () => {
    const c = node('client', 0, 0, {}, 'C', 'client')
    const app = node('app_server', 0, 0, { instances: 4 }, 'App', 'app')
    const mk = (db: Record<string, number | string>): Design => {
      const d = node('rdbms', 0, 0, db, 'DB', 'db')
      return { nodes: [c, app, d], edges: [edge(c, app), edge(app, d)] }
    }
    const small = simulate(mk({ vcpu: 4 }), W, PEAK).ticks[0]
    const big = simulate(mk({ vcpu: 8 }), W, PEAK).ticks[0]
    expect(small.nodes.db.capacity.read).toBe(2000)
    expect(big.nodes.db.capacity.read).toBe(4000)
    expect(small.nodes.db.status).toBe('overloaded')
    expect(big.nodes.db.status).not.toBe('overloaded')
  })

  it('cost follows machine size', () => {
    expect(monthlyCost('app_server', { instances: 2, vcpu: 8 })).toBeGreaterThan(monthlyCost('app_server', { instances: 2, vcpu: 2 }))
    expect(monthlyCost('rdbms', { readReplicas: 2 })).toBeCloseTo(3 * monthlyCost('rdbms', {}), 9)
  })

  it('derivations explain every derived key with a formula', () => {
    for (const kind of Object.keys(CATALOG) as ComponentKind[])
      for (const step of hardwareDerivations(kind, resolveConfig(kind, {}, W), W)) expect(step.formula.length).toBeGreaterThan(5)
  })

  it('explicit throughput in node() implies manual sizing', () => {
    expect(node('rdbms', 0, 0, { readRps: 9000 }).config.sizing).toBe('manual')
    expect(node('rdbms', 0, 0, { readReplicas: 1 }).config.sizing).toBe('hardware')
  })

  it('queue retention is bounded by broker disk', () => {
    const c = node('client', 0, 0, {}, 'C', 'client')
    const app = node('app_server', 0, 0, { instances: 10, eventsPerRequest: 1 }, 'App', 'app')
    const db = node('rdbms', 0, 0, { readRps: 1e6, writeRps: 1e6 }, 'DB', 'db')
    const q = node('queue', 0, 0, { brokers: 1, diskGb: 0.001 }, 'Q', 'q') // ~1M bytes ÷ (500 B × 3) ≈ 666 msgs
    const w = node('worker', 0, 0, { instances: 1, rpsPerInstance: 10 }, 'W', 'w')
    const an = node('nosql', 0, 0, {}, 'An', 'an')
    const r = simulate({ nodes: [c, app, db, q, w, an], edges: [edge(c, app), edge(app, db), edge(app, q), edge(q, w), edge(w, an)] }, W, PEAK)
    const t = last(r.ticks)
    expect(t.queueBacklog).toBeCloseTo((0.001 * 1e9) / (500 * 3), 6)
    expect(t.nodes.q.failed).toBeGreaterThan(0)
  })
})

describe('response connections', () => {
  const build = (dbCfg: Record<string, number | string | boolean>) => {
    const c = node('client', 0, 0, {}, 'C', 'client')
    const lb = node('dns_lb', 0, 0, {}, 'LB', 'lb')
    const app = node('app_server', 0, 0, { instances: 4 }, 'App', 'app')
    const db = node('rdbms', 0, 0, dbCfg, 'DB', 'db')
    return { nodes: [c, lb, app, db], edges: [edge(c, lb), edge(lb, app), edge(app, db), { id: 'resp', source: 'app', target: 'client' }] }
  }

  it('do not route requests or create a cycle', () => {
    const r = simulate(build({ sizing: 'manual', readRps: 1e6, writeRps: 1e6 }), W, PEAK)
    expect(r.warnings.some((w) => w.includes('Cycle'))).toBe(false)
    const t = last(r.ticks)
    expect(t.nodes.client.offered.read).toBeGreaterThan(0) // only the generated load
    expect(t.nodes.app.offered.read + t.nodes.app.offered.write).toBeCloseTo(estimate(W).peakRps, 6)
  })

  it('carry the successful responses and their bandwidth', () => {
    const t = last(simulate(build({ sizing: 'manual', readRps: 1e6, writeRps: 1e6 }), W, PEAK).ticks)
    const e = estimate(W)
    expect(t.edges.resp.response).toBeCloseTo(e.peakRps, 6)
    expect(t.edges.resp.responseBytesPerSec).toBeCloseTo(e.peakReadRps * W.payloadBytes + e.peakWriteRps * 100, 3)
  })

  it('shrink when the database fails requests', () => {
    const ok = last(simulate(build({ sizing: 'manual', readRps: 1e6, writeRps: 1e6 }), W, PEAK).ticks).edges.resp.response!
    const down = last(simulate(build({ failed: true }), W, PEAK).ticks).edges.resp.response!
    expect(down).toBeLessThan(ok * 0.05)
  })
})

describe('field help', () => {
  it('every configurable field has an explanation', () => {
    for (const spec of Object.values(CATALOG)) for (const f of spec.fields) expect([spec.kind, f.key, (f.help ?? '').length > 10]).toEqual([spec.kind, f.key, true])
  })
})
