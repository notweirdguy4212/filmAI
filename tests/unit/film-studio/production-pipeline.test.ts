import { describe, expect, it } from 'vitest'
import {
  assignVoicesToDialogue,
  buildSegmentConcatManifest,
  buildMultitrackFfmpegPlan,
  normalizeRenderCheckpoint,
  planRenderSegments,
  pendingRenderSegments,
  shiftSrtForRenderSegment,
  sliceTimelineForRenderSegment,
  propagateSceneReferences,
} from '@/features/film-studio/production-pipeline'

describe('film production pipeline', () => {
  it('builds layered picture compositing with xfade transitions and clip-level grading', () => {
    const plan = buildMultitrackFfmpegPlan([
      { id: 'v1', name: 'Picture', kind: 'video', clips: [
        { id: 'a', assetId: 'a', title: 'A', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 96, transitionOutFrames: 24 },
        { id: 'b', assetId: 'b', title: 'B', startFrame: 72, sourceInFrame: 0, sourceOutFrame: 96, transitionInFrames: 24, grade: { contrast: 1.1 } },
      ] },
      { id: 'v2', name: 'Overlay', kind: 'video', zIndex: 2, clips: [
        { id: 'c', assetId: 'c', title: 'Overlay', startFrame: 24, sourceInFrame: 0, sourceOutFrame: 48 },
      ] },
    ], { fps: 24, width: 1920, height: 1080, durationFrames: 168, assets: [
      { id: 'a', path: '/tmp/a.mp4', mimeType: 'video/mp4' },
      { id: 'b', path: '/tmp/b.mp4', mimeType: 'video/mp4' },
      { id: 'c', path: '/tmp/c.mp4', mimeType: 'video/mp4' },
    ] })
    expect(plan.filterComplex).toContain('xfade=transition=fade')
    expect(plan.filterComplex).toContain('overlay=')

    expect(plan.filterComplex).toContain('contrast=1.1')
    expect(plan.outputMaps).toEqual(['-map', '[vout]', '-an'])
  })

  it('mixes separate dialogue and music buses with sidechain ducking', () => {
    const plan = buildMultitrackFfmpegPlan([
      { id: 'd', name: 'Dialogue', kind: 'audio', audioRole: 'dialogue', clips: [{ id: 'd1', assetId: 'd1', title: 'Dialogue', startFrame: 24, sourceInFrame: 0, sourceOutFrame: 240, gain: 1 }] },
      { id: 'm', name: 'Score', kind: 'audio', audioRole: 'music', clips: [{ id: 'm1', assetId: 'm1', title: 'Score', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 480, gain: 0.6 }] },
    ], { fps: 24, width: 1920, height: 1080, durationFrames: 480, assets: [
      { id: 'd1', path: '/tmp/d.wav', mimeType: 'audio/wav' },
      { id: 'm1', path: '/tmp/m.wav', mimeType: 'audio/wav' },
    ] })
    expect(plan.filterComplex).toContain('sidechaincompress')
    expect(plan.filterComplex).toContain('adelay=1000|1000')
    expect(plan.outputMaps).toContain('[aout]')
  })

  it('plans bounded render segments and sanitizes durable checkpoints', () => {
    expect(planRenderSegments(24 * 620, 24, 300)).toEqual([
      { index: 0, startFrame: 0, endFrame: 7200 },
      { index: 1, startFrame: 7200, endFrame: 14400 },
      { index: 2, startFrame: 14400, endFrame: 14880 },
    ])
    const checkpoint = normalizeRenderCheckpoint({ completedSegments: [0, 0, 4, -1, '2'] }, 3)
    expect(checkpoint.completedSegments).toEqual([0])
    expect(pendingRenderSegments(planRenderSegments(24 * 620, 24, 300), checkpoint).map((segment) => segment.index)).toEqual([1, 2])
    expect(buildSegmentConcatManifest(['/tmp/part-0.mp4', "/tmp/part-'1.mp4"])).toContain("file '/tmp/part-'\\''1.mp4'")
  })

  it('slices a segment with transition pre-roll and post-roll while rebasing source frames', () => {
    const sliced = sliceTimelineForRenderSegment([
      { id: 'v', name: 'Picture', kind: 'video', clips: [
        { id: 'a', assetId: 'a', title: 'A', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 240, transitionOutFrames: 24 },
        { id: 'b', assetId: 'b', title: 'B', startFrame: 216, sourceInFrame: 0, sourceOutFrame: 240, transitionInFrames: 24 },
      ] },
    ], { index: 1, startFrame: 240, endFrame: 480 }, 24, 720, 10)
    expect(sliced).toMatchObject({ windowStartFrame: 0, windowEndFrame: 720, trimStartFrames: 240, outputDurationFrames: 240 })
    expect(sliced.tracks[0].clips).toHaveLength(2)
  })

  it('rebases absolute SRT timestamps into a padded render segment', () => {
    const srt = '1\\n00:00:09,000 --> 00:00:12,000\\nBefore and during\\n\\n2\\n00:00:30,000 --> 00:00:32,000\\nOutside'
    expect(shiftSrtForRenderSegment(srt, 10, 25)).toContain('00:00:00,000 --> 00:00:02,000')
    expect(shiftSrtForRenderSegment(srt, 10, 25)).not.toContain('Outside')
  })

  it('locks dialogue speakers to configured voice identities', () => {
    expect(assignVoicesToDialogue([{ speaker: 'MARA', text: 'Answer me.' }, { speaker: 'VOICE', text: 'I am here.' }], [
      { character: 'Mara', voiceId: 'voice-a', language: 'en-GB' },
    ])).toEqual([
      { speaker: 'MARA', text: 'Answer me.', voice: { voiceId: 'voice-a', language: 'en-GB', notes: undefined } },
      { speaker: 'VOICE', text: 'I am here.', voice: null },
    ])
  })

  it('propagates character, location and style reference assets between scenes', () => {
    const result = propagateSceneReferences([
      { sceneId: 's1', characterAssetIds: ['char-a'], locationAssetIds: ['loc-a'], styleAssetIds: ['style-a'] },
      { sceneId: 's2', characterAssetIds: [], locationAssetIds: ['loc-b'], styleAssetIds: [] },
    ])
    expect(result[1]).toMatchObject({ previousSceneId: 's1', characterAssetIds: ['char-a'], locationAssetIds: ['loc-a', 'loc-b'], styleAssetIds: ['style-a'] })
  })
})
