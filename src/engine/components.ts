import type { ComponentConfig, ComponentKind } from './types'

// Component catalog: defaults, editable fields, and the explicit (illustrative)
// cost + availability assumptions used by the simulator. These are MODELED
// numbers chosen to be in a plausible range, not vendor benchmarks.

export type FieldDef =
  | { key: string; label: string; type: 'number'; min?: number; max?: number; step?: number; unit?: string; help?: string }
  | { key: string; label: string; type: 'select'; options: string[]; help?: string }
  | { key: string; label: string; type: 'boolean'; help?: string }

export type Category = 'source' | 'edge' | 'proxy' | 'compute' | 'cache' | 'store' | 'async' | 'worker' | 'sidecar'

export interface ComponentSpec {
  kind: ComponentKind
  name: string
  short: string
  icon: string
  category: Category
  description: string
  defaults: ComponentConfig
  fields: FieldDef[]
}

const failField: FieldDef = {
  key: 'failed',
  label: 'Simulate outage',
  type: 'boolean',
  help: 'Takes this component down for the whole run.',
}

const timeoutField: FieldDef = {
  key: 'timeoutMs',
  label: 'Timeout',
  type: 'number',
  min: 10,
  step: 50,
  unit: 'ms',
  help: 'Requests queued longer than this fail. Max queue = capacity × timeout.',
}

export const CATALOG: Record<ComponentKind, ComponentSpec> = {
  client: {
    kind: 'client',
    name: 'Client / Mobile App',
    short: 'Client',
    icon: '📱',
    category: 'source',
    description: 'Traffic source. Generates the workload defined in the calculator.',
    defaults: {},
    fields: [],
  },
  dns_lb: {
    kind: 'dns_lb',
    name: 'DNS / Load Balancer',
    short: 'Load Balancer',
    icon: '⚖️',
    category: 'proxy',
    description: 'Spreads traffic evenly (round-robin) across downstream compute.',
    defaults: { instances: 1, rpsPerInstance: 50000, latencyMs: 1, timeoutMs: 1000, failed: false },
    fields: [
      { key: 'instances', label: 'Instances', type: 'number', min: 1, step: 1 },
      { key: 'rpsPerInstance', label: 'Capacity / instance', type: 'number', min: 1, step: 1000, unit: 'req/s' },
      { key: 'latencyMs', label: 'Added latency', type: 'number', min: 0, step: 0.5, unit: 'ms' },
      timeoutField,
      failField,
    ],
  },
  api_gateway: {
    kind: 'api_gateway',
    name: 'API Gateway',
    short: 'API Gateway',
    icon: '🚪',
    category: 'proxy',
    description: 'Auth, routing and request validation in front of services.',
    defaults: { instances: 2, rpsPerInstance: 10000, latencyMs: 3, timeoutMs: 1000, failed: false },
    fields: [
      { key: 'instances', label: 'Instances', type: 'number', min: 1, step: 1 },
      { key: 'rpsPerInstance', label: 'Capacity / instance', type: 'number', min: 1, step: 1000, unit: 'req/s' },
      { key: 'latencyMs', label: 'Added latency', type: 'number', min: 0, step: 0.5, unit: 'ms' },
      timeoutField,
      failField,
    ],
  },
  rate_limiter: {
    kind: 'rate_limiter',
    name: 'Rate Limiter',
    short: 'Rate Limiter',
    icon: '🚦',
    category: 'proxy',
    description: 'Rejects traffic above a global limit (HTTP 429) to protect downstream.',
    defaults: { limitRps: 20000, rpsCapacity: 200000, latencyMs: 1, timeoutMs: 1000, failed: false },
    fields: [
      { key: 'limitRps', label: 'Allowed rate', type: 'number', min: 1, step: 500, unit: 'req/s', help: 'Traffic above this is rejected, not queued.' },
      { key: 'rpsCapacity', label: 'Limiter capacity', type: 'number', min: 1, step: 1000, unit: 'req/s' },
      { key: 'latencyMs', label: 'Added latency', type: 'number', min: 0, step: 0.5, unit: 'ms' },
      timeoutField,
      failField,
    ],
  },
  app_server: {
    kind: 'app_server',
    name: 'Application Servers',
    short: 'App Servers',
    icon: '🖥️',
    category: 'compute',
    description: 'Stateless service tier. Threads block while waiting on downstream calls.',
    defaults: {
      instances: 2,
      rpsPerInstance: 1000,
      processingMs: 10,
      maxConcurrent: 200,
      timeoutMs: 1000,
      eventsPerRequest: 0,
      failed: false,
    },
    fields: [
      { key: 'instances', label: 'Instances', type: 'number', min: 1, step: 1 },
      { key: 'rpsPerInstance', label: 'Sustainable req/s / instance', type: 'number', min: 1, step: 100, unit: 'req/s', help: 'CPU-bound ceiling per instance.' },
      { key: 'processingMs', label: 'Processing time', type: 'number', min: 0, step: 1, unit: 'ms' },
      { key: 'maxConcurrent', label: 'Max concurrent / instance', type: 'number', min: 1, step: 10, help: 'Thread/connection limit. Throughput ≤ concurrency ÷ (processing + downstream latency).' },
      timeoutField,
      { key: 'eventsPerRequest', label: 'Side-effect events / request', type: 'number', min: 0, step: 0.1, help: 'Non-critical work (e.g. click analytics). Goes to a queue if connected, otherwise becomes synchronous DB writes.' },
      failField,
    ],
  },
  cache: {
    kind: 'cache',
    name: 'Cache (Redis)',
    short: 'Redis',
    icon: '⚡',
    category: 'cache',
    description: 'Look-aside/read-through cache. Hits are served here; misses continue downstream.',
    defaults: {
      memoryGb: 16,
      hitRatioMode: 'fixed',
      hitRatio: 0.8,
      rpsCapacity: 100000,
      latencyMs: 1,
      eviction: 'LRU',
      onFailure: 'fallthrough',
      failed: false,
    },
    fields: [
      { key: 'hitRatioMode', label: 'Hit ratio model', type: 'select', options: ['fixed', 'working-set'], help: 'working-set: hit = 0.95 × min(1, memory ÷ working set)^k, k depends on eviction policy.' },
      { key: 'hitRatio', label: 'Hit ratio (fixed mode)', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'memoryGb', label: 'Memory', type: 'number', min: 0.1, step: 1, unit: 'GB' },
      { key: 'eviction', label: 'Eviction policy', type: 'select', options: ['LRU', 'LFU', 'TTL'] },
      { key: 'rpsCapacity', label: 'Throughput capacity', type: 'number', min: 1, step: 10000, unit: 'req/s' },
      { key: 'latencyMs', label: 'Lookup latency', type: 'number', min: 0, step: 0.1, unit: 'ms' },
      { key: 'onFailure', label: 'When unavailable/overloaded', type: 'select', options: ['fallthrough', 'fail'], help: 'fallthrough sends reads to the database instead.' },
      failField,
    ],
  },
  rdbms: {
    kind: 'rdbms',
    name: 'Relational Database',
    short: 'SQL DB',
    icon: '🗄️',
    category: 'store',
    description: 'Single primary for writes. Read replicas add read capacity only.',
    defaults: {
      readRps: 2000,
      writeRps: 500,
      readLatencyMs: 5,
      writeLatencyMs: 10,
      connectionPool: 100,
      storageGb: 2000,
      replicationFactor: 1,
      readReplicas: 0,
      timeoutMs: 1000,
      failed: false,
    },
    fields: [
      { key: 'readRps', label: 'Max read throughput', type: 'number', min: 1, step: 100, unit: 'req/s' },
      { key: 'writeRps', label: 'Max write throughput', type: 'number', min: 1, step: 50, unit: 'req/s' },
      { key: 'readLatencyMs', label: 'Read latency', type: 'number', min: 0.1, step: 1, unit: 'ms' },
      { key: 'writeLatencyMs', label: 'Write latency', type: 'number', min: 0.1, step: 1, unit: 'ms' },
      { key: 'connectionPool', label: 'Connection pool', type: 'number', min: 1, step: 10, help: 'Little’s law: throughput ≤ pool ÷ query latency.' },
      { key: 'readReplicas', label: 'Read replicas', type: 'number', min: 0, step: 1, help: 'Each replica adds one primary’s worth of read capacity and its own pool.' },
      { key: 'storageGb', label: 'Storage capacity', type: 'number', min: 1, step: 100, unit: 'GB' },
      { key: 'replicationFactor', label: 'Copies of data (incl. primary)', type: 'number', min: 1, step: 1 },
      timeoutField,
      failField,
    ],
  },
  nosql: {
    kind: 'nosql',
    name: 'NoSQL Database',
    short: 'NoSQL',
    icon: '🧩',
    category: 'store',
    description: 'Partitioned key-value/wide-column store. Each write is applied on RF replicas.',
    defaults: {
      nodes: 3,
      readRpsPerNode: 10000,
      writeRpsPerNode: 10000,
      readLatencyMs: 3,
      writeLatencyMs: 4,
      replicationFactor: 3,
      consistency: 'eventual',
      storageGbPerNode: 1000,
      timeoutMs: 1000,
      failed: false,
    },
    fields: [
      { key: 'nodes', label: 'Nodes', type: 'number', min: 1, step: 1 },
      { key: 'readRpsPerNode', label: 'Reads / node', type: 'number', min: 1, step: 1000, unit: 'req/s' },
      { key: 'writeRpsPerNode', label: 'Writes / node', type: 'number', min: 1, step: 1000, unit: 'req/s' },
      { key: 'readLatencyMs', label: 'Read latency', type: 'number', min: 0.1, step: 0.5, unit: 'ms' },
      { key: 'writeLatencyMs', label: 'Write latency', type: 'number', min: 0.1, step: 0.5, unit: 'ms' },
      { key: 'replicationFactor', label: 'Replication factor', type: 'number', min: 1, step: 1, help: 'Write capacity ÷ RF.' },
      { key: 'consistency', label: 'Consistency', type: 'select', options: ['eventual', 'quorum', 'strong'], help: 'quorum: reads hit ⌈RF/2⌉ replicas; strong: reads hit all RF. Latency ×1.5 / ×2.' },
      { key: 'storageGbPerNode', label: 'Storage / node', type: 'number', min: 1, step: 100, unit: 'GB' },
      timeoutField,
      failField,
    ],
  },
  read_replica: {
    kind: 'read_replica',
    name: 'Read Replica',
    short: 'Read Replica',
    icon: '📖',
    category: 'store',
    description: 'Read-only copy. Reads are spread across stores by read capacity; writes never go here.',
    defaults: { readRps: 2000, readLatencyMs: 5, connectionPool: 100, replicationLagMs: 100, timeoutMs: 1000, failed: false },
    fields: [
      { key: 'readRps', label: 'Max read throughput', type: 'number', min: 1, step: 100, unit: 'req/s' },
      { key: 'readLatencyMs', label: 'Read latency', type: 'number', min: 0.1, step: 1, unit: 'ms' },
      { key: 'connectionPool', label: 'Connection pool', type: 'number', min: 1, step: 10 },
      { key: 'replicationLagMs', label: 'Replication lag (informational)', type: 'number', min: 0, step: 50, unit: 'ms' },
      timeoutField,
      failField,
    ],
  },
  sharded_db: {
    kind: 'sharded_db',
    name: 'Sharded Database',
    short: 'Sharded DB',
    icon: '🧱',
    category: 'store',
    description: 'N independent shards. The hottest shard saturates first (skew).',
    defaults: {
      shards: 4,
      readRpsPerShard: 2000,
      writeRpsPerShard: 500,
      readLatencyMs: 5,
      writeLatencyMs: 10,
      strategy: 'hash',
      hotShardSkew: 1.2,
      storageGbPerShard: 1000,
      timeoutMs: 1000,
      failed: false,
    },
    fields: [
      { key: 'shards', label: 'Shards', type: 'number', min: 1, step: 1 },
      { key: 'readRpsPerShard', label: 'Reads / shard', type: 'number', min: 1, step: 100, unit: 'req/s' },
      { key: 'writeRpsPerShard', label: 'Writes / shard', type: 'number', min: 1, step: 50, unit: 'req/s' },
      { key: 'readLatencyMs', label: 'Read latency', type: 'number', min: 0.1, step: 1, unit: 'ms' },
      { key: 'writeLatencyMs', label: 'Write latency', type: 'number', min: 0.1, step: 1, unit: 'ms' },
      { key: 'strategy', label: 'Shard key strategy', type: 'select', options: ['hash', 'range', 'geo'] },
      { key: 'hotShardSkew', label: 'Hot-shard skew', type: 'number', min: 1, step: 0.1, help: 'Hottest shard load ÷ average. Effective capacity = shards × per-shard ÷ skew.' },
      { key: 'storageGbPerShard', label: 'Storage / shard', type: 'number', min: 1, step: 100, unit: 'GB' },
      timeoutField,
      failField,
    ],
  },
  queue: {
    kind: 'queue',
    name: 'Message Queue (Kafka / SQS)',
    short: 'Queue',
    icon: '📨',
    category: 'async',
    description: 'Buffers async events. Delivery rate is limited by broker and consumer capacity; the rest becomes lag.',
    defaults: { partitions: 6, rpsPerPartition: 5000, enqueueLatencyMs: 2, failed: false },
    fields: [
      { key: 'partitions', label: 'Partitions', type: 'number', min: 1, step: 1 },
      { key: 'rpsPerPartition', label: 'Throughput / partition', type: 'number', min: 1, step: 500, unit: 'msg/s' },
      { key: 'enqueueLatencyMs', label: 'Publish latency', type: 'number', min: 0, step: 0.5, unit: 'ms' },
      failField,
    ],
  },
  worker: {
    kind: 'worker',
    name: 'Background Workers',
    short: 'Workers',
    icon: '⚙️',
    category: 'worker',
    description: 'Consume queue events and write results to stores, off the request path.',
    defaults: { instances: 2, rpsPerInstance: 500, processingMs: 20, failed: false },
    fields: [
      { key: 'instances', label: 'Instances', type: 'number', min: 1, step: 1 },
      { key: 'rpsPerInstance', label: 'Events / s / instance', type: 'number', min: 1, step: 50 },
      { key: 'processingMs', label: 'Processing time', type: 'number', min: 0, step: 1, unit: 'ms' },
      failField,
    ],
  },
  object_storage: {
    kind: 'object_storage',
    name: 'Object Storage (S3)',
    short: 'Object Store',
    icon: '🪣',
    category: 'store',
    description: 'Durable blob storage; very high throughput but higher per-request latency.',
    defaults: { readRps: 50000, writeRps: 10000, latencyMs: 40, timeoutMs: 2000, failed: false },
    fields: [
      { key: 'readRps', label: 'Read throughput', type: 'number', min: 1, step: 1000, unit: 'req/s' },
      { key: 'writeRps', label: 'Write throughput', type: 'number', min: 1, step: 1000, unit: 'req/s' },
      { key: 'latencyMs', label: 'Latency', type: 'number', min: 1, step: 5, unit: 'ms' },
      timeoutField,
      failField,
    ],
  },
  cdn: {
    kind: 'cdn',
    name: 'CDN',
    short: 'CDN',
    icon: '🌐',
    category: 'edge',
    description: 'Edge cache in front of the origin. Serves cacheable reads; misses and writes go to origin.',
    defaults: { hitRatio: 0.5, rpsCapacity: 1000000, latencyMs: 15, failed: false },
    fields: [
      { key: 'hitRatio', label: 'Edge hit ratio (reads)', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'rpsCapacity', label: 'Edge capacity', type: 'number', min: 1, step: 100000, unit: 'req/s' },
      { key: 'latencyMs', label: 'Edge latency', type: 'number', min: 0, step: 1, unit: 'ms' },
      failField,
    ],
  },
  search: {
    kind: 'search',
    name: 'Search Engine',
    short: 'Search',
    icon: '🔎',
    category: 'store',
    description: 'Inverted index (Elasticsearch-like). Modeled as a read/write store with index cost.',
    defaults: { nodes: 3, queryRpsPerNode: 1000, indexRpsPerNode: 500, latencyMs: 20, timeoutMs: 1000, failed: false },
    fields: [
      { key: 'nodes', label: 'Nodes', type: 'number', min: 1, step: 1 },
      { key: 'queryRpsPerNode', label: 'Queries / node', type: 'number', min: 1, step: 100, unit: 'req/s' },
      { key: 'indexRpsPerNode', label: 'Index ops / node', type: 'number', min: 1, step: 100, unit: 'req/s' },
      { key: 'latencyMs', label: 'Latency', type: 'number', min: 1, step: 1, unit: 'ms' },
      timeoutField,
      failField,
    ],
  },
  lock: {
    kind: 'lock',
    name: 'Distributed Lock',
    short: 'Lock',
    icon: '🔒',
    category: 'sidecar',
    description: 'Every write from the caller acquires a lock synchronously (adds latency, has its own capacity).',
    defaults: { rpsCapacity: 5000, latencyMs: 3, timeoutMs: 500, failed: false },
    fields: [
      { key: 'rpsCapacity', label: 'Lock ops / s', type: 'number', min: 1, step: 500 },
      { key: 'latencyMs', label: 'Acquire latency', type: 'number', min: 0, step: 0.5, unit: 'ms' },
      timeoutField,
      failField,
    ],
  },
}

export const PALETTE_ORDER: ComponentKind[] = [
  'client',
  'cdn',
  'dns_lb',
  'api_gateway',
  'rate_limiter',
  'app_server',
  'cache',
  'rdbms',
  'read_replica',
  'nosql',
  'sharded_db',
  'queue',
  'worker',
  'object_storage',
  'search',
  'lock',
]

export const num = (cfg: ComponentConfig, key: string, fallback = 0): number => {
  const v = cfg[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
export const str = (cfg: ComponentConfig, key: string, fallback = ''): string => {
  const v = cfg[key]
  return typeof v === 'string' ? v : fallback
}

export const withDefaults = (kind: ComponentKind, cfg: ComponentConfig = {}): ComponentConfig => ({
  ...CATALOG[kind].defaults,
  ...cfg,
})

// ---- Illustrative monthly cost model (USD). Ballpark cloud list prices, rounded.
export function monthlyCost(kind: ComponentKind, raw: ComponentConfig): number {
  const c = withDefaults(kind, raw)
  switch (kind) {
    case 'client':
      return 0
    case 'dns_lb':
      return 25 * num(c, 'instances', 1)
    case 'api_gateway':
      return 60 * num(c, 'instances', 1)
    case 'rate_limiter':
      return 50
    case 'app_server':
      return 70 * num(c, 'instances', 1)
    case 'cache':
      return 12 * num(c, 'memoryGb')
    case 'rdbms':
      return 400 * (1 + num(c, 'readReplicas')) + 0.12 * num(c, 'storageGb') * num(c, 'replicationFactor', 1)
    case 'read_replica':
      return 300
    case 'nosql':
      return 300 * num(c, 'nodes', 1)
    case 'sharded_db':
      return 400 * num(c, 'shards', 1)
    case 'queue':
      return 40 * num(c, 'partitions', 1)
    case 'worker':
      return 50 * num(c, 'instances', 1)
    case 'object_storage':
      return 100
    case 'cdn':
      return 200
    case 'search':
      return 300 * num(c, 'nodes', 1)
    case 'lock':
      return 100
  }
}

// ---- Illustrative availability model. Per-unit availability; redundant units fail independently.
export function componentAvailability(kind: ComponentKind, raw: ComponentConfig): number {
  const c = withDefaults(kind, raw)
  if (c.failed === true) return 0
  const redundant = (a: number, n: number) => 1 - Math.pow(1 - a, Math.max(1, n))
  switch (kind) {
    case 'client':
      return 1
    case 'dns_lb':
      return redundant(0.999, num(c, 'instances', 1))
    case 'api_gateway':
      return redundant(0.999, num(c, 'instances', 1))
    case 'rate_limiter':
      return 0.9995
    case 'app_server':
      return redundant(0.995, num(c, 'instances', 1))
    case 'cache':
      // With fallthrough a cache outage degrades latency/load but not availability.
      return str(c, 'onFailure') === 'fallthrough' ? 1 : 0.999
    case 'rdbms':
      // Replicas can be promoted on primary failure.
      return redundant(0.999, 1 + num(c, 'readReplicas'))
    case 'read_replica':
      return 0.999
    case 'nosql':
      return redundant(0.999, num(c, 'replicationFactor', 1))
    case 'sharded_db':
      // Any shard down makes its key range unavailable.
      return Math.pow(0.999, num(c, 'shards', 1))
    case 'queue':
      return 0.9995
    case 'worker':
      return 1 // async: does not affect request availability
    case 'object_storage':
      return 0.9999
    case 'cdn':
      return 0.9999
    case 'search':
      return redundant(0.999, num(c, 'nodes', 1))
    case 'lock':
      return 0.9995
  }
}
