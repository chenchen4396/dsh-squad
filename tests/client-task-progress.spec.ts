import { describe, expect, it } from 'vitest'
import { summarizeTaskProgress } from '../src/client/task-progress.js'

describe('summarizeTaskProgress', () => {
  it('returns an all-zero summary for an empty task collection', () => {
    expect(summarizeTaskProgress({})).toEqual({
      total: 0,
      completed: 0,
      inProgress: 0,
      pending: 0,
      assigned: 0,
      failed: 0,
      cancelled: 0,
      completionRate: 0,
    })
  })

  it.each([
    ['pending', 'pending'],
    ['assigned', 'assigned'],
    ['in_progress', 'inProgress'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('counts a lone %s task only in its own bucket', (status, bucket) => {
    const summary = summarizeTaskProgress({ only: { status } })

    expect(summary.total).toBe(1)
    expect(summary[bucket]).toBe(1)
    expect(summary.completionRate).toBe(status === 'completed' ? 1 : 0)
  })

  it('summarizes a board with mixed statuses', () => {
    const summary = summarizeTaskProgress({
      first: { status: 'pending' },
      second: { status: 'assigned' },
      third: { status: 'in_progress' },
      fourth: { status: 'completed' },
      fifth: { status: 'failed' },
      sixth: { status: 'cancelled' },
    })

    expect(summary).toEqual({
      total: 6,
      completed: 1,
      inProgress: 1,
      pending: 1,
      assigned: 1,
      failed: 1,
      cancelled: 1,
      completionRate: 0.17,
    })
  })

  it('rounds the completion rate to two decimals', () => {
    const summary = summarizeTaskProgress({
      done: { status: 'completed' },
      open1: { status: 'pending' },
      open2: { status: 'in_progress' },
    })

    expect(summary.completionRate).toBe(0.33)
  })

  it('keeps the completion rate at 0 when dividing by an empty total', () => {
    expect(summarizeTaskProgress({}).completionRate).toBe(0)
  })

  it('counts unknown statuses toward total without classifying or throwing', () => {
    const summary = summarizeTaskProgress({
      running: { status: 'running' },
      blocked: { status: 'blocked' },
      done: { status: 'completed' },
    })

    expect(summary).toEqual({
      total: 3,
      completed: 1,
      inProgress: 0,
      pending: 0,
      assigned: 0,
      failed: 0,
      cancelled: 0,
      completionRate: 0.33,
    })
  })

  it('tolerates exotic statuses without throwing', () => {
    expect(() => summarizeTaskProgress({ weird: { status: '???' } })).not.toThrow()
  })
})
