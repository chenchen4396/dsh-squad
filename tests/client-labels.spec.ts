import { describe, expect, it } from 'vitest'
import {
  memberModelLabel,
  modelDisplayName,
  PERMISSION_LABELS,
  TASK_STATE_LABELS,
  taskStatusLabel,
} from '../src/client/labels.js'

describe('taskStatusLabel', () => {
  it.each([
    ['pending', '待处理'],
    ['assigned', '已分配'],
    ['in_progress', '进行中'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
  ])('maps %s to its Chinese label', (status, label) => {
    expect(taskStatusLabel(status)).toBe(label)
  })

  it.each(['paused', 'unknown_state', ''])('returns an unknown status %j as-is', status => {
    expect(taskStatusLabel(status)).toBe(status)
  })

  it('keeps TASK_STATE_LABELS intact', () => {
    expect(TASK_STATE_LABELS).toEqual({
      pending: '待处理',
      assigned: '已分配',
      in_progress: '进行中',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    })
  })

  it('keeps PERMISSION_LABELS intact', () => {
    expect(PERMISSION_LABELS).toEqual({
      'read-only': '只读',
      'workspace-write': '工作区可写',
      'danger-full-access': '完全访问',
    })
  })

  describe('modelDisplayName', () => {
    const models = {
      commandcode: [
        { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (CC)' },
        { id: 'zai/glm-5.3', name: 'GLM 5.3' },
      ],
    }

    it('names a member model the way the Harness model selector does', () => {
      expect(modelDisplayName(models, 'commandcode', 'deepseek/deepseek-v4.1-flash'))
        .toBe('DeepSeek V4.1 Flash (CC)')
    })

    it('falls back to the raw model id when the catalog has no entry', () => {
      expect(modelDisplayName(models, 'commandcode', 'unknown/model')).toBe('unknown/model')
      expect(modelDisplayName(models, 'missing-provider', 'some/model')).toBe('some/model')
      expect(modelDisplayName(undefined, 'commandcode', 'some/model')).toBe('some/model')
    })
  })

  describe('memberModelLabel', () => {
    const models = { commandcode: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (CC)' }] }
    const assistant = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }

    it('names an ordinary member the way the Harness model selector does', () => {
      expect(memberModelLabel(models, { id: 'slot-member' }, 'slot-leader', assistant)).toEqual({
        name: 'DeepSeek V4.1 Flash (CC)',
        title: 'commandcode / deepseek/deepseek-v4.1-flash',
        showEffort: true,
      })
    })

    it('names the Leader as the Session instead of its assistant template', () => {
      // The leader assistant's route never runs: the Session's own Agent does.
      expect(memberModelLabel(models, { id: 'slot-leader' }, 'slot-leader', assistant)).toEqual({
        name: '本会话 Agent',
        title: 'Leader 是本会话自身的 Agent：模型与思考模式由会话决定',
        showEffort: false,
      })
    })

    it('says so when the member assistant no longer resolves', () => {
      expect(memberModelLabel(models, { id: 'slot-member' }, 'slot-leader', undefined)).toEqual({
        name: '助手不可用',
        title: '助手不可用',
        showEffort: false,
      })
    })
  })
})
