export interface TaskProgressSummary {
  total: number
  completed: number
  inProgress: number
  pending: number
  assigned: number
  failed: number
  cancelled: number
  completionRate: number
}

export function summarizeTaskProgress(tasks: Record<string, { status: string }>): TaskProgressSummary {
  const summary: TaskProgressSummary = {
    total: 0,
    completed: 0,
    inProgress: 0,
    pending: 0,
    assigned: 0,
    failed: 0,
    cancelled: 0,
    completionRate: 0,
  }

  for (const task of Object.values(tasks)) {
    summary.total += 1
    switch (task.status) {
      case 'completed':
        summary.completed += 1
        break
      case 'in_progress':
        summary.inProgress += 1
        break
      case 'pending':
        summary.pending += 1
        break
      case 'assigned':
        summary.assigned += 1
        break
      case 'failed':
        summary.failed += 1
        break
      case 'cancelled':
        summary.cancelled += 1
        break
    }
  }

  if (summary.total > 0) {
    summary.completionRate = Math.round((summary.completed / summary.total) * 100) / 100
  }

  return summary
}
