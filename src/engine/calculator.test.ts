import { describe, expect, it } from 'vitest'
import { compareEstimate, estimate, fmtBytes, parseEstimate, perDayToRps, rpsToPerDay } from './calculator'
import { CHALLENGES } from '../data/challenges'

const url = CHALLENGES.find((c) => c.id === 'url-shortener')!.workload

describe('back-of-the-envelope calculator (URL shortener)', () => {
  const e = estimate(url)

  it('computes traffic', () => {
    expect(e.dailyRequests).toBe(100_000_000)
    expect(e.avgRps).toBeCloseTo(100_000_000 / 86_400, 9) // ≈ 1157.41
    expect(e.peakRps).toBeCloseTo(e.avgRps * 3, 9) // ≈ 3472.22
    expect(e.readFraction).toBeCloseTo(100 / 101, 12)
    expect(e.peakReadRps + e.peakWriteRps).toBeCloseTo(e.peakRps, 9)
    expect(e.peakReadRps / e.peakWriteRps).toBeCloseTo(100, 9)
  })

  it('computes storage', () => {
    const dailyWrites = 100_000_000 / 101
    expect(e.dailyStorageBytes).toBeCloseTo(dailyWrites * 500, 3) // ≈ 495 MB/day
    expect(e.rawStorageBytes).toBeCloseTo(dailyWrites * 500 * 5 * 365.25, 0) // ≈ 904 GB
    expect(e.rawStorageBytes / 1e9).toBeGreaterThan(900)
    expect(e.rawStorageBytes / 1e9).toBeLessThan(910)
    expect(e.totalStorageBytes).toBeCloseTo(e.rawStorageBytes * 1.3 * 3, 0)
  })

  it('computes capacity requirements', () => {
    expect(e.appInstances).toBe(Math.ceil(e.peakRps / (1000 * 0.7))) // 5
    expect(e.dbReadNodesNoCache).toBe(Math.ceil(e.peakReadRps / (2000 * 0.7))) // 3
    expect(e.dbReadNodesWithCache).toBe(1)
    expect(e.cacheMemoryBytes).toBeCloseTo(100_000_000 * (100 / 101) * 0.2 * 500, 0) // ≈ 9.9 GB
  })

  it('recomputes immediately when inputs change', () => {
    const e10 = estimate({ ...url, peakMultiplier: 10, dau: 20_000_000 })
    expect(e10.peakRps).toBeCloseTo(((20_000_000 * 10) / 86_400) * 10, 9)
  })
})

describe('units and estimates', () => {
  it('formats bytes in decimal SI', () => {
    expect(fmtBytes(500)).toBe('500 B')
    expect(fmtBytes(1_500_000_000)).toBe('1.5 GB')
    expect(fmtBytes(904e9)).toBe('904 GB')
    expect(fmtBytes(2.4e12)).toBe('2.4 TB')
  })
  it('converts rates', () => {
    expect(rpsToPerDay(1)).toBe(86_400)
    expect(perDayToRps(86_400_000)).toBe(1000)
  })
  it('parses shorthand estimates', () => {
    expect(parseEstimate('1.2k')).toBe(1200)
    expect(parseEstimate('3,500')).toBe(3500)
    expect(parseEstimate('900 GB')).toBe(900e9)
    expect(parseEstimate('100M')).toBe(100e6)
    expect(parseEstimate('abc')).toBeNull()
  })
  it('grades estimates by order of magnitude', () => {
    expect(compareEstimate(1150, 1157).verdict).toBe('exact')
    expect(compareEstimate(2000, 1157).verdict).toBe('close')
    expect(compareEstimate(5000, 1157).verdict).toBe('same order')
    expect(compareEstimate(50000, 1157).verdict).toBe('off')
  })
})
