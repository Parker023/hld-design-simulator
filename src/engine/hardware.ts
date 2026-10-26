/**
 * Hardware sizing: derive a component's throughput, memory and storage from
 * vCPU / RAM / disk. All per-core and per-disk figures are MODELED assumptions
 * (round numbers in a plausible range), not vendor benchmarks. Defaults are
 * chosen so the derived capacities equal the catalog's manual defaults.
 */
import { estimate } from './calculator'
import type { FieldDef } from './components'
import type { ComponentConfig, ComponentKind, Workload } from './types'

const num = (c: ComponentConfig, k: string, d = 0) => (typeof c[k] === 'number' && Number.isFinite(c[k] as number) ? (c[k] as number) : d)
const str = (c: ComponentConfig, k: string, d = '') => (typeof c[k] === 'string' ? (c[k] as string) : d)
const fmt = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '∞')

export type DiskType = 'ssd' | 'nvme' | 'hdd'
export const DISK: Record<DiskType, { iops: number; readMs: number; usdPerGb: number }> = {
  hdd: { iops: 250, readMs: 8, usdPerGb: 0.045 },
  ssd: { iops: 3000, readMs: 0.5, usdPerGb: 0.08 },
  nvme: { iops: 25000, readMs: 0.1, usdPerGb: 0.12 },
}
export const USD_PER_VCPU = 22
export const USD_PER_GB_RAM = 3

/** Constants used in the derivations (exported so docs/tests can reference them). */
export const HW = {
  appThreadsPerCore: 100,
  lbRpsPerCore: 25_000,
  gatewayRpsPerCore: 5_000,
  limiterRpsPerCore: 25_000,
  workerRpsPerCore: 250,
  lockRpsPerCore: 2_500,
  redisRpsPerCore: 50_000,
  redisMaxUsefulCores: 4,
  redisUsableRam: 0.8,
  sqlReadRpsPerCore: 500,
  sqlWriteRpsPerCore: 125,
  sqlBufferPoolRam: 0.7,
  sqlIosPerWrite: 2,
  sqlRamPerConnectionMb: 10,
  nosqlRpsPerCore: 2_500,
  nosqlCacheRam: 0.5,
  searchQueryRpsPerCore: 250,
  searchIndexRpsPerCore: 125,
  kafkaMsgsPerCore: 2_500,
  kafkaReplication: 3,
}

export interface Derivation {
  key: string
  label: string
  value: number
  unit: string
  formula: string
}

interface HardwareSpec {
  defaults: ComponentConfig
  fields: FieldDef[]
  /** config keys computed from hardware (hidden as inputs in hardware mode) */
  derived: string[]
  derive: (c: ComponentConfig, w?: Workload) => Derivation[]
}

const vcpuField = (help?: string): FieldDef => ({ key: 'vcpu', label: 'vCPU cores (per instance)', type: 'number', min: 1, step: 1, help })
const ramField = (help?: string): FieldDef => ({ key: 'ramGb', label: 'Memory / RAM (per instance)', type: 'number', min: 0.5, step: 1, unit: 'GB', help })
const diskField = (help?: string): FieldDef => ({ key: 'diskGb', label: 'Storage / disk (per instance)', type: 'number', min: 1, step: 10, unit: 'GB', help })
const diskTypeField: FieldDef = { key: 'diskType', label: 'Disk type', type: 'select', options: ['ssd', 'nvme', 'hdd'], help: 'IOPS: HDD 250 · SSD 3,000 · NVMe 25,000. Random read: 8 / 0.5 / 0.1 ms.' }

const d = (key: string, label: string, value: number, unit: string, formula: string): Derivation => ({ key, label, value, unit, formula })

/** Fraction of hot reads that miss an in-memory cache of `memBytes` (1% floor). */
function missFraction(memBytes: number, w?: Workload): { miss: number; hot: number } {
  const hot = w ? estimate(w).cacheMemoryBytes : 0
  if (hot <= 0) return { miss: 0.01, hot }
  return { miss: Math.max(0.01, 1 - memBytes / hot), hot }
}

/** Shared derivation for SQL-style stores (primary, replica, shard). */
function sqlDerive(c: ComponentConfig, w: Workload | undefined, keys: { read: string; write?: string; storage?: string }, perUnit: string): Derivation[] {
  const vcpu = num(c, 'vcpu', 1)
  const ram = num(c, 'ramGb', 1)
  const disk = DISK[(str(c, 'diskType', 'ssd') as DiskType)] ?? DISK.ssd
  const bp = ram * HW.sqlBufferPoolRam * 1e9
  const { miss, hot } = missFraction(bp, w)
  const cpuRead = vcpu * HW.sqlReadRpsPerCore
  const ioRead = (disk.iops * 0.5) / miss
  const out: Derivation[] = [
    d('bufferMiss', 'Buffer-pool miss rate', miss, 'fraction', `max(1%, 1 − (${ram} GB × ${HW.sqlBufferPoolRam}) ÷ hot set ${hot ? (hot / 1e9).toFixed(1) + ' GB' : 'n/a'})`),
    d(keys.read, `Read capacity ${perUnit}`, Math.min(cpuRead, ioRead), 'req/s', `min(${vcpu} vCPU × ${HW.sqlReadRpsPerCore}, ½ × ${fmt(disk.iops)} IOPS ÷ ${(miss * 100).toFixed(1)}% miss) = min(${fmt(cpuRead)}, ${fmt(ioRead)})`),
    d('effectiveReadLatencyMs', 'Effective read latency', num(c, 'readLatencyMs', 1) + miss * disk.readMs, 'ms', `${num(c, 'readLatencyMs', 1)} ms in-memory + ${(miss * 100).toFixed(1)}% × ${disk.readMs} ms disk read`),
  ]
  if (keys.write) {
    const cpuWrite = vcpu * HW.sqlWriteRpsPerCore
    const ioWrite = (disk.iops * 0.5) / HW.sqlIosPerWrite
    out.push(d(keys.write, `Write capacity ${perUnit}`, Math.min(cpuWrite, ioWrite), 'req/s', `min(${vcpu} vCPU × ${HW.sqlWriteRpsPerCore}, ½ × ${fmt(disk.iops)} IOPS ÷ ${HW.sqlIosPerWrite} IOs/write) = min(${fmt(cpuWrite)}, ${fmt(ioWrite)})`))
  }
  if ('connectionPool' in c) {
    const ramConns = Math.floor((ram * 1024) / HW.sqlRamPerConnectionMb)
    out.push(d('connectionPool', 'Usable connections', Math.min(num(c, 'connectionPool', 1), ramConns), 'conns', `min(configured ${num(c, 'connectionPool', 1)}, ${ram} GB ÷ ${HW.sqlRamPerConnectionMb} MB each = ${fmt(ramConns)})`))
  }
  if (keys.storage) out.push(d(keys.storage, `Storage ${perUnit}`, num(c, 'diskGb'), 'GB', `${num(c, 'diskGb')} GB ${str(c, 'diskType', 'ssd').toUpperCase()}`))
  return out
}

export const HARDWARE: Partial<Record<ComponentKind, HardwareSpec>> = {
  app_server: {
    defaults: { vcpu: 2, ramGb: 4, diskGb: 20, diskType: 'ssd', rpsPerCore: 500, memPerRequestMb: 20 },
    fields: [
      vcpuField(),
      ramField('Caps concurrent requests: RAM ÷ memory per request.'),
      diskField('Local disk for OS/logs. Stateless tier, so it affects cost only.'),
      { key: 'rpsPerCore', label: 'Req/s per core (your code’s efficiency)', type: 'number', min: 1, step: 50, unit: 'req/s' },
      { key: 'memPerRequestMb', label: 'Memory per in-flight request', type: 'number', min: 1, step: 5, unit: 'MB' },
    ],
    derived: ['rpsPerInstance', 'maxConcurrent'],
    derive: (c) => {
      const vcpu = num(c, 'vcpu', 1)
      const ram = num(c, 'ramGb', 1)
      const byThreads = vcpu * HW.appThreadsPerCore
      const byRam = Math.floor((ram * 1024) / Math.max(1, num(c, 'memPerRequestMb', 20)))
      return [
        d('rpsPerInstance', 'CPU throughput / instance', vcpu * num(c, 'rpsPerCore', 500), 'req/s', `${vcpu} vCPU × ${num(c, 'rpsPerCore', 500)} req/s per core`),
        d('maxConcurrent', 'Max concurrent / instance', Math.min(byThreads, byRam), 'reqs', `min(${vcpu} vCPU × ${HW.appThreadsPerCore} threads, ${ram} GB ÷ ${num(c, 'memPerRequestMb', 20)} MB) = min(${fmt(byThreads)}, ${fmt(byRam)})`),
      ]
    },
  },
  dns_lb: {
    defaults: { vcpu: 2, ramGb: 4, diskGb: 20, diskType: 'ssd' },
    fields: [vcpuField(), ramField(), diskField('Affects cost only.')],
    derived: ['rpsPerInstance'],
    derive: (c) => [d('rpsPerInstance', 'Throughput / instance', num(c, 'vcpu', 1) * HW.lbRpsPerCore, 'req/s', `${num(c, 'vcpu', 1)} vCPU × ${fmt(HW.lbRpsPerCore)}`)],
  },
  api_gateway: {
    defaults: { vcpu: 2, ramGb: 4, diskGb: 20, diskType: 'ssd' },
    fields: [vcpuField(), ramField(), diskField('Affects cost only.')],
    derived: ['rpsPerInstance'],
    derive: (c) => [d('rpsPerInstance', 'Throughput / instance', num(c, 'vcpu', 1) * HW.gatewayRpsPerCore, 'req/s', `${num(c, 'vcpu', 1)} vCPU × ${fmt(HW.gatewayRpsPerCore)} (auth, routing, validation)`)],
  },
  rate_limiter: {
    defaults: { vcpu: 8, ramGb: 8, diskGb: 20, diskType: 'ssd' },
    fields: [vcpuField(), ramField('Holds counters in memory.'), diskField('Affects cost only.')],
    derived: ['rpsCapacity'],
    derive: (c) => [d('rpsCapacity', 'Limiter capacity', num(c, 'vcpu', 1) * HW.limiterRpsPerCore, 'req/s', `${num(c, 'vcpu', 1)} vCPU × ${fmt(HW.limiterRpsPerCore)}`)],
  },
  worker: {
    defaults: { vcpu: 2, ramGb: 4, diskGb: 20, diskType: 'ssd' },
    fields: [vcpuField(), ramField(), diskField('Affects cost only.')],
    derived: ['rpsPerInstance'],
    derive: (c) => [d('rpsPerInstance', 'Events / s / instance', num(c, 'vcpu', 1) * HW.workerRpsPerCore, 'msg/s', `${num(c, 'vcpu', 1)} vCPU × ${HW.workerRpsPerCore}`)],
  },
  lock: {
    defaults: { vcpu: 2, ramGb: 4, diskGb: 20, diskType: 'ssd' },
    fields: [vcpuField(), ramField(), diskField('Lease log; affects cost only.')],
    derived: ['rpsCapacity'],
    derive: (c) => [d('rpsCapacity', 'Lock ops / s', num(c, 'vcpu', 1) * HW.lockRpsPerCore, 'ops/s', `${num(c, 'vcpu', 1)} vCPU × ${fmt(HW.lockRpsPerCore)}`)],
  },
  cache: {
    defaults: { vcpu: 2, ramGb: 20, diskGb: 40, diskType: 'ssd' },
    fields: [
      vcpuField('Redis executes commands on one main thread; I/O threads help up to ~4 cores.'),
      ramField(`Usable cache memory = RAM × ${HW.redisUsableRam} (headroom for fragmentation and fork on snapshot).`),
      diskField('Persistence (RDB/AOF). Affects cost only.'),
    ],
    derived: ['memoryGb', 'rpsCapacity'],
    derive: (c) => {
      const vcpu = num(c, 'vcpu', 1)
      const ram = num(c, 'ramGb', 1)
      return [
        d('memoryGb', 'Usable cache memory', ram * HW.redisUsableRam, 'GB', `${ram} GB RAM × ${HW.redisUsableRam}`),
        d('rpsCapacity', 'Throughput', HW.redisRpsPerCore * Math.min(vcpu, HW.redisMaxUsefulCores), 'ops/s', `${fmt(HW.redisRpsPerCore)} × min(${vcpu} vCPU, ${HW.redisMaxUsefulCores})`),
      ]
    },
  },
  rdbms: {
    defaults: { vcpu: 4, ramGb: 16, diskGb: 2000, diskType: 'ssd' },
    fields: [vcpuField('Replicas use the same machine size.'), ramField(`Buffer pool = RAM × ${HW.sqlBufferPoolRam}. If the hot set doesn’t fit, reads go to disk.`), diskField('Database storage (per copy).'), diskTypeField],
    derived: ['readRps', 'writeRps', 'storageGb'],
    derive: (c, w) => sqlDerive(c, w, { read: 'readRps', write: 'writeRps', storage: 'storageGb' }, '(primary)'),
  },
  read_replica: {
    defaults: { vcpu: 4, ramGb: 16, diskGb: 2000, diskType: 'ssd' },
    fields: [vcpuField(), ramField(`Buffer pool = RAM × ${HW.sqlBufferPoolRam}.`), diskField('Full copy of the primary’s data.'), diskTypeField],
    derived: ['readRps'],
    derive: (c, w) => sqlDerive(c, w, { read: 'readRps' }, ''),
  },
  sharded_db: {
    defaults: { vcpu: 4, ramGb: 16, diskGb: 1000, diskType: 'ssd' },
    fields: [vcpuField('Per shard.'), ramField('Per shard.'), diskField('Per shard.'), diskTypeField],
    derived: ['readRpsPerShard', 'writeRpsPerShard', 'storageGbPerShard'],
    derive: (c, w) => {
      // Each shard holds 1/shards of the hot set.
      const shards = Math.max(1, num(c, 'shards', 1))
      const perShardW = w ? { ...w, dau: w.dau / shards } : undefined
      return sqlDerive(c, perShardW, { read: 'readRpsPerShard', write: 'writeRpsPerShard', storage: 'storageGbPerShard' }, 'per shard')
    },
  },
  nosql: {
    defaults: { vcpu: 4, ramGb: 32, diskGb: 1000, diskType: 'nvme' },
    fields: [vcpuField('Per node.'), ramField(`Per node. Row/block cache = RAM × ${HW.nosqlCacheRam}.`), diskField('Per node.'), diskTypeField],
    derived: ['readRpsPerNode', 'writeRpsPerNode', 'storageGbPerNode'],
    derive: (c, w) => {
      const vcpu = num(c, 'vcpu', 1)
      const ram = num(c, 'ramGb', 1)
      const nodes = Math.max(1, num(c, 'nodes', 1))
      const rf = Math.max(1, num(c, 'replicationFactor', 1))
      const disk = DISK[(str(c, 'diskType', 'nvme') as DiskType)] ?? DISK.nvme
      const { miss, hot } = missFraction((nodes * ram * HW.nosqlCacheRam * 1e9) / rf, w)
      const cpu = vcpu * HW.nosqlRpsPerCore
      const ioRead = disk.iops / miss
      const ioWrite = disk.iops * 2 // LSM: sequential, batched writes
      return [
        d('bufferMiss', 'Cache miss rate', miss, 'fraction', `max(1%, 1 − (${nodes} nodes × ${ram} GB × ${HW.nosqlCacheRam} ÷ RF ${rf}) ÷ hot set ${hot ? (hot / 1e9).toFixed(1) + ' GB' : 'n/a'})`),
        d('readRpsPerNode', 'Reads / node', Math.min(cpu, ioRead), 'req/s', `min(${vcpu} vCPU × ${fmt(HW.nosqlRpsPerCore)}, ${fmt(disk.iops)} IOPS ÷ ${(miss * 100).toFixed(1)}% miss)`),
        d('writeRpsPerNode', 'Writes / node', Math.min(cpu, ioWrite), 'req/s', `min(${vcpu} vCPU × ${fmt(HW.nosqlRpsPerCore)}, ${fmt(disk.iops)} IOPS × 2 (LSM batching))`),
        d('effectiveReadLatencyMs', 'Effective read latency', num(c, 'readLatencyMs', 1) + miss * disk.readMs, 'ms', `${num(c, 'readLatencyMs', 1)} ms + ${(miss * 100).toFixed(1)}% × ${disk.readMs} ms disk`),
        d('storageGbPerNode', 'Storage / node', num(c, 'diskGb'), 'GB', `${num(c, 'diskGb')} GB ${str(c, 'diskType', 'nvme').toUpperCase()}`),
      ]
    },
  },
  search: {
    defaults: { vcpu: 4, ramGb: 16, diskGb: 500, diskType: 'ssd' },
    fields: [vcpuField('Per node.'), ramField('Per node (JVM heap + page cache).'), diskField('Per node (index).'), diskTypeField],
    derived: ['queryRpsPerNode', 'indexRpsPerNode'],
    derive: (c) => {
      const vcpu = num(c, 'vcpu', 1)
      const disk = DISK[(str(c, 'diskType', 'ssd') as DiskType)] ?? DISK.ssd
      return [
        d('queryRpsPerNode', 'Queries / node', vcpu * HW.searchQueryRpsPerCore, 'req/s', `${vcpu} vCPU × ${HW.searchQueryRpsPerCore}`),
        d('indexRpsPerNode', 'Index ops / node', Math.min(vcpu * HW.searchIndexRpsPerCore, disk.iops / 4), 'req/s', `min(${vcpu} vCPU × ${HW.searchIndexRpsPerCore}, ${fmt(disk.iops)} IOPS ÷ 4)`),
      ]
    },
  },
  queue: {
    defaults: { brokers: 3, vcpu: 4, ramGb: 16, diskGb: 1000, diskType: 'ssd' },
    fields: [
      { key: 'brokers', label: 'Brokers', type: 'number', min: 1, step: 1 },
      vcpuField('Per broker.'),
      ramField('Per broker (page cache).'),
      diskField(`Per broker. Bounds how much consumer lag can be retained (×${HW.kafkaReplication} replication).`),
      diskTypeField,
    ],
    derived: ['brokerRps', 'maxBacklogMsgs'],
    derive: (c, w) => {
      const brokers = num(c, 'brokers', 1)
      const vcpu = num(c, 'vcpu', 1)
      const payload = w?.payloadBytes ?? 500
      return [
        d('brokerRps', 'Broker throughput', brokers * vcpu * HW.kafkaMsgsPerCore, 'msg/s', `${brokers} brokers × ${vcpu} vCPU × ${fmt(HW.kafkaMsgsPerCore)}`),
        d('maxBacklogMsgs', 'Retainable backlog', (brokers * num(c, 'diskGb') * 1e9) / (payload * HW.kafkaReplication), 'msgs', `${brokers} × ${num(c, 'diskGb')} GB ÷ (${payload} B × ${HW.kafkaReplication} replicas)`),
      ]
    },
  },
}

export const SIZING_FIELD: FieldDef = {
  key: 'sizing',
  label: 'Sizing mode',
  type: 'select',
  options: ['hardware', 'manual'],
  help: 'hardware: set vCPU, RAM and disk, and capacity is calculated. manual: type throughput numbers directly.',
}

export const supportsHardware = (kind: ComponentKind) => kind in HARDWARE
export const isHardwareMode = (kind: ComponentKind, c: ComponentConfig) => supportsHardware(kind) && str(c, 'sizing', 'hardware') === 'hardware'

/** Derivation steps for display (empty in manual mode). */
export function hardwareDerivations(kind: ComponentKind, c: ComponentConfig, w?: Workload): Derivation[] {
  if (!isHardwareMode(kind, c)) return []
  return HARDWARE[kind]!.derive(c, w)
}

/** Config with hardware-derived values applied (no-op in manual mode). */
export function applyHardware(kind: ComponentKind, c: ComponentConfig, w?: Workload): ComponentConfig {
  if (!isHardwareMode(kind, c)) return c
  const out: ComponentConfig = { ...c }
  for (const step of HARDWARE[kind]!.derive(c, w)) out[step.key] = step.value
  return out
}

/** Monthly cost of one machine of this shape (illustrative). */
export function machineCost(c: ComponentConfig): number {
  const disk = DISK[(str(c, 'diskType', 'ssd') as DiskType)] ?? DISK.ssd
  return num(c, 'vcpu', 1) * USD_PER_VCPU + num(c, 'ramGb', 1) * USD_PER_GB_RAM + num(c, 'diskGb') * disk.usdPerGb
}

export interface OverriddenValue {
  key: string
  manual: number
  derived: number
}

/**
 * Values the user typed (in manual mode) that hardware sizing is currently replacing.
 * A stored value counts as user-typed when it differs from the catalog default — new
 * components copy defaults into their config, so a default value isn't a user choice.
 */
export function overriddenManualValues(kind: ComponentKind, c: ComponentConfig, catalogDefaults: ComponentConfig, w?: Workload): OverriddenValue[] {
  if (!isHardwareMode(kind, c)) return []
  const derived = new Map(HARDWARE[kind]!.derive(c, w).map((s) => [s.key, s.value]))
  const out: OverriddenValue[] = []
  for (const key of HARDWARE[kind]!.derived) {
    const v = c[key]
    const dv = derived.get(key)
    if (typeof v !== 'number' || dv === undefined) continue
    if (v === catalogDefaults[key] || Math.abs(v - dv) < 1e-9) continue
    out.push({ key, manual: v, derived: dv })
  }
  return out
}
