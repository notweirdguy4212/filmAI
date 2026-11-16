import { describe, expect, it } from 'vitest'
import { buildFrameTimeline, exportCmx3600Edl, exportSrt, secondsToFrames } from '@/features/film-studio/production-toolkit'

describe('production toolkit', () => {
  it('converts seconds to exact frame counts', () => {
    expect(secondsToFrames(2.5, 24)).toBe(60)
  })

  it('builds a continuous timeline using explicit source frame ranges', () => {
    const timeline = buildFrameTimeline([
      { id: 'a', title: 'Opening', durationSeconds: 4, sourceInFrame: 12, sourceOutFrame: 84 },
      { id: 'b', title: 'Arrival', durationSeconds: 3 },
    ], 24)
    expect(timeline[0]).toMatchObject({ sourceInFrame: 12, sourceOutFrame: 84, durationFrames: 72, startFrame: 0, endFrame: 72 })
    expect(timeline[1]).toMatchObject({ startFrame: 72, endFrame: 144 })
  })

  it('rejects invalid source frame ranges', () => {
    expect(() => buildFrameTimeline([{ id: 'a', title: 'Bad', durationSeconds: 2, sourceInFrame: 10, sourceOutFrame: 10 }])).toThrow('INVALID_SOURCE_FRAME_RANGE')
  })

  it('exports source and timeline timecodes in CMX 3600 EDL format', () => {
    const edl = exportCmx3600Edl('Film', [{ id: 'a', title: 'Opening', durationSeconds: 2, sourceInFrame: 24, sourceOutFrame: 72 }], 24)
    expect(edl).toContain('00:00:01:00 00:00:03:00 00:00:00:00 00:00:02:00')
  })

  it('exports timed SRT cues', () => {
    expect(exportSrt([{ startSeconds: 1.25, endSeconds: 2.5, text: 'Hello.' }])).toContain('00:00:01,250 --> 00:00:02,500')
  })
})

describe('multitrack timeline and dialogue continuity', () => {
  it('validates multiple video/audio tracks with integer frame positions', async () => {
    const { validateMultitrackTimeline } = await import('@/features/film-studio/production-toolkit')
    const result = validateMultitrackTimeline([
      { id: 'v1', name: 'Main picture', kind: 'video', clips: [{ id: 'c1', assetId: 'asset-video', title: 'Opening', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120, sourceFps: 30 }] },
      { id: 'a1', name: 'Dialogue', kind: 'audio', clips: [{ id: 'c2', assetId: 'asset-audio', title: 'Dialogue', startFrame: 24, sourceInFrame: 0, sourceOutFrame: 240 }] },
    ], 24)
    expect(result.clipCount).toBe(2)
    expect(result.durationFrames).toBe(264)
    expect(result.clips[0].endFrame).toBe(96)
  })

  it('rejects more than thirty timeline clips and invalid transitions', async () => {
    const { validateMultitrackTimeline } = await import('@/features/film-studio/production-toolkit')
    const clips = Array.from({ length: 31 }, (_, index) => ({ id: `c${index}`, assetId: 'asset', title: 'Clip', startFrame: index * 24, sourceInFrame: 0, sourceOutFrame: 24 }))
    expect(() => validateMultitrackTimeline([{ id: 'v1', name: 'Video', kind: 'video', clips }], 24, 30)).toThrow('CLIP_LIMIT_30')
  })

  it('extracts exact speaker names, parenthetical directions and spoken lines', async () => {
    const { extractDialogueLines } = await import('@/features/film-studio/production-toolkit')
    expect(extractDialogueLines('MARA (into the radio)\nAnswer me.\nVOICE (V.O.)\nYou should not have come back.')).toEqual([
      { speaker: 'MARA', direction: 'into the radio', text: 'Answer me.' },
      { speaker: 'VOICE', direction: 'V.O.', text: 'You should not have come back.' },
    ])
  })
})

it('recognizes screenplay parenthetical directions on their own line', async () => {
  const { extractDialogueLines } = await import('@/features/film-studio/production-toolkit')
  expect(extractDialogueLines('MARA\n(into the receiver)\nAnswer me.')).toEqual([{ speaker: 'MARA', direction: 'into the receiver', text: 'Answer me.' }])
})

it('does not misattribute action after a dialogue block to the previous speaker', async () => {
  const { extractDialogueLines } = await import('@/features/film-studio/production-toolkit')
  expect(extractDialogueLines('MARA\nHello.\n\nMara crosses the room.')).toEqual([{ speaker: 'MARA', text: 'Hello.' }])
})
