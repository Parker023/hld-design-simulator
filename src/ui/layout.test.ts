import { describe, expect, it } from 'vitest'
import { NODE_H, NODE_W, freeSpot } from './layout'

describe('freeSpot', () => {
  it('uses the requested spot when it is empty', () => {
    expect(freeSpot([], { x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
  })
  it('never places a node on top of an existing one', () => {
    const existing = [{ x: 0, y: 0 }]
    const placed = [...existing]
    for (let i = 0; i < 12; i++) {
      const p = freeSpot(placed, { x: 0, y: 0 })
      for (const e of placed) expect(Math.abs(e.x - p.x) >= NODE_W || Math.abs(e.y - p.y) >= NODE_H).toBe(true)
      placed.push(p)
    }
  })
})
