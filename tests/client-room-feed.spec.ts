import { describe, expect, it } from 'vitest'
import type { RoomMessageView } from '../src/transport/contracts.js'
import { roomSpeech } from '../src/client/room-feed.js'

function message(partial: Partial<RoomMessageView> & { id: string }): RoomMessageView {
  return {
    kind: 'agent',
    seq: 1,
    time: 1_700_000_000_000,
    text: '内容',
    senderName: 'Mika',
    senderRole: 'member',
    ...partial,
  }
}

describe('roomSpeech', () => {
  it('keeps what the reader sent and what a member answered', () => {
    const speech = roomSpeech([
      message({ id: 'a', kind: 'user', senderRole: 'user', senderName: '你' }),
      message({ id: 'b' }),
    ])

    expect(speech.map(item => item.id)).toEqual(['a', 'b'])
  })

  it('keeps process detail out of the room', () => {
    const speech = roomSpeech([
      message({ id: 'a', kind: 'tool', text: 'team_create_task · completed' }),
      message({ id: 'b', kind: 'notice', text: '成员状态变化' }),
      message({ id: 'c', kind: 'system', text: '团队已启动' }),
      message({ id: 'd' }),
    ])

    expect(speech.map(item => item.id)).toEqual(['d'])
  })

  it('drops an answer that only thought or called tools', () => {
    const speech = roomSpeech([
      message({ id: 'a', text: '', reasoning: '先看看目录' }),
      message({ id: 'b', text: '   ' }),
      message({ id: 'c', text: '结论是这样' }),
    ])

    expect(speech.map(item => item.id)).toEqual(['c'])
  })

  it('returns nothing for an empty room', () => {
    expect(roomSpeech([])).toEqual([])
  })
})
