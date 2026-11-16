import type { TimelineTrack } from './production-toolkit'

export type PipelineAsset = { id: string; path: string; mimeType: string }
export type FilmAudioRole = 'dialogue' | 'music' | 'effects'
export type PipelineTrack = TimelineTrack & { audioRole?: FilmAudioRole; zIndex?: number }
export type PipelineOptions = {
  fps: number
  width: number
  height: number
  durationFrames: number
  assets: readonly PipelineAsset[]
  ducking?: { enabled?: boolean; threshold?: number; ratio?: number; attackMs?: number; releaseMs?: number }
  masterGain?: number
}
export type MultitrackPlan = { inputs: string[]; filterComplex: string; outputMaps: string[]; durationSeconds: number }

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const seconds = (frames: number, fps: number) => (frames / fps).toFixed(6)
export function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

/**
 * Produces a deterministic FFmpeg filter graph for the persisted NLE timeline.
 * Alpha fades on overlapping picture clips create real composited crossfades;
 * audio is assembled as independent dialogue/music/effects buses.
 */
export function buildMultitrackFfmpegPlan(tracks: readonly PipelineTrack[], options: PipelineOptions): MultitrackPlan {
  const { fps, width, height, durationFrames } = options
  if (![24, 25, 30, 50, 60].includes(fps) || ![1280, 1920, 3840].includes(width) || height !== Math.round(width * 9 / 16)) throw new Error('INVALID_OUTPUT_PROFILE')
  if (!Number.isInteger(durationFrames) || durationFrames < 1 || durationFrames > fps * 60 * 60 * 8) throw new Error('INVALID_FILM_DURATION')
  if (tracks.length > 32) throw new Error('INVALID_TRACKS')
  const assets = new Map<string, PipelineAsset & { inputIndex: number }>(options.assets.map((asset, index) => [asset.id, { ...asset, inputIndex: index }] as const))
  const filters: string[] = []
  const duration = seconds(durationFrames, fps)
  filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${duration},format=rgba[vbase0]`)
  let pictureLabel = 'vbase0'
  let pictureIndex = 0
  const allClips = tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })))
  if (allClips.length > 30) throw new Error('CLIP_LIMIT_30')

  const visualTracks = tracks.filter((track) => ['video', 'title', 'effect'].includes(track.kind)).sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
  for (const track of visualTracks) {
    if (track.muted) continue
    const orderedClips = [...track.clips].sort((a, b) => a.startFrame - b.startFrame)
    const crossfadeSequence = track.kind === 'video' && orderedClips.length > 1 && orderedClips[0].startFrame === 0 && orderedClips.slice(1).every((clip, index) => {
      const previous = orderedClips[index]
      const previousDuration = Math.max(1, Math.round((previous.sourceOutFrame - previous.sourceInFrame) * fps / (previous.sourceFps ?? fps)))
      const overlapFrames = previous.startFrame + previousDuration - clip.startFrame
      const transitionFrames = Math.min(clip.transitionInFrames ?? 0, previous.transitionOutFrames ?? 0)
      return overlapFrames > 0 && transitionFrames > 0 && overlapFrames === transitionFrames
    })
    if (crossfadeSequence) {
      const clipLabels: string[] = []
      for (const clip of orderedClips) {
        const asset = assets.get(clip.assetId)
        if (!asset || !asset.mimeType.startsWith('video/')) throw new Error(`CROSSFADE_REQUIRES_VIDEO_ASSET:${clip.assetId}`)
        const sourceFps = clip.sourceFps ?? fps
        const clipFrames = Math.max(1, Math.round((clip.sourceOutFrame - clip.sourceInFrame) * fps / sourceFps))
        const clipDuration = clipFrames / fps
        const grade = clip.grade
        const brightness = clamp(grade?.brightness ?? 0, -0.2, 0.2)
        const contrast = clamp(grade?.contrast ?? 1, 0.5, 1.8)
        const saturation = clamp(grade?.saturation ?? 1, 0, 2)
        const gamma = clamp(grade?.gamma ?? 1, 0.5, 2)
        const effects = (clip.effects ?? []).map((effect) => effect.type === 'blur' ? `gblur=sigma=${(clamp(effect.amount ?? 0.5, 0, 1) * 20).toFixed(3)}` : effect.type === 'sharpen' ? `unsharp=5:5:${(clamp(effect.amount ?? 0.5, 0, 1) * 2).toFixed(3)}:5:5:0` : effect.type === 'vignette' ? `vignette=angle=${(clamp(effect.amount ?? 0.5, 0, 1) * 0.8).toFixed(3)}` : `noise=alls=${Math.round(clamp(effect.amount ?? 0.5, 0, 1) * 40)}:allf=t+u`).join(',')
        const label = `xfade_clip_${pictureIndex}_${clipLabels.length}`
        filters.push(`[${asset.inputIndex}:v:0]trim=start=${(clip.sourceInFrame / sourceFps).toFixed(6)}:duration=${clipDuration.toFixed(6)},setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}:gamma=${gamma},${effects ? `${effects},` : ''}format=yuv420p[${label}]`)
        clipLabels.push(label)
      }
      let chain = clipLabels[0]
      for (let index = 1; index < clipLabels.length; index += 1) {
        const clip = orderedClips[index]
        const previous = orderedClips[index - 1]
        const overlapFrames = Math.min(clip.transitionInFrames ?? 0, previous.transitionOutFrames ?? 0)
        const transitionDuration = overlapFrames / fps
        const offset = clip.startFrame / fps
        const next = `xfade_chain_${pictureIndex}_${index}`
        filters.push(`[${chain}][${clipLabels[index]}]xfade=transition=${clip.transitionType ?? 'fade'}:duration=${transitionDuration.toFixed(6)}:offset=${offset.toFixed(6)}[${next}]`)
        chain = next
      }
      const outputLabel = `vbase_${pictureIndex + 1}`
      filters.push(`[${pictureLabel}][${chain}]overlay=eof_action=pass:shortest=0[${outputLabel}]`)
      pictureLabel = outputLabel
      pictureIndex += 1
      continue
    }
    for (const clip of orderedClips) {
      const asset = assets.get(clip.assetId)
      if (!asset) throw new Error(`MISSING_TIMELINE_ASSET:${clip.assetId}`)
      if (!asset.mimeType.startsWith('video/') && !asset.mimeType.startsWith('image/')) throw new Error(`INVALID_VISUAL_ASSET:${clip.assetId}`)
      const sourceFps = clip.sourceFps ?? fps
      const clipFrames = Math.max(1, Math.round((clip.sourceOutFrame - clip.sourceInFrame) * fps / sourceFps))
      const clipDuration = clipFrames / fps
      const start = clip.startFrame / fps
      const end = Math.min(durationFrames, clip.startFrame + clipFrames) / fps
      if (start >= durationFrames) continue
      const inFade = clamp(clip.transitionInFrames ?? 0, 0, Math.min(clipFrames, fps * 10)) / fps
      const outFade = clamp(clip.transitionOutFrames ?? 0, 0, Math.min(clipFrames, fps * 10)) / fps
      const inputLabel = `vclip_${pictureIndex}`
      const outputLabel = `vbase_${pictureIndex + 1}`
      const grade = clip.grade
      const brightness = clamp(grade?.brightness ?? 0, -0.2, 0.2)
      const contrast = clamp(grade?.contrast ?? 1, 0.5, 1.8)
      const saturation = clamp(grade?.saturation ?? 1, 0, 2)
      const gamma = clamp(grade?.gamma ?? 1, 0.5, 2)
      const exposure = clamp(grade?.exposure ?? 0, -3, 3)
      const temperature = clamp(grade?.temperature ?? 0, -1, 1)
      const tint = clamp(grade?.tint ?? 0, -1, 1)
      const vignette = clamp(grade?.vignette ?? 0, 0, 1)
      const effects = (clip.effects ?? []).map((effect) => {
        const amount = clamp(effect.amount ?? 0.5, 0, 1)
        if (effect.type === 'blur') return `gblur=sigma=${(amount * 20).toFixed(3)}`
        if (effect.type === 'sharpen') return `unsharp=5:5:${(amount * 2).toFixed(3)}:5:5:0`
        if (effect.type === 'vignette') return `vignette=angle=${(amount * 0.8).toFixed(3)}`
        if (effect.type === 'grain') return `noise=alls=${Math.round(amount * 40)}:allf=t+u`
        return ''
      }).filter(Boolean).join(',')
      const trim = asset.mimeType.startsWith('image/')
        ? `trim=duration=${clipDuration.toFixed(6)}`
        : `trim=start=${(clip.sourceInFrame / sourceFps).toFixed(6)}:duration=${clipDuration.toFixed(6)}`
      const fadeFilters = [
        inFade > 0 ? `fade=t=in:st=0:d=${inFade.toFixed(6)}:alpha=1` : '',
        outFade > 0 ? `fade=t=out:st=${Math.max(0, clipDuration - outFade).toFixed(6)}:d=${outFade.toFixed(6)}:alpha=1` : '',
      ].filter(Boolean).join(',')
      const videoFilters = [
        trim, 'setpts=PTS-STARTPTS', `fps=${fps}`, `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`, 'setsar=1',
        `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}:gamma=${gamma}`,
        exposure !== 0 ? `exposure=exposure=${exposure}` : '',
        temperature !== 0 || tint !== 0 ? `colorbalance=rs=${(temperature * 0.15).toFixed(4)}:bs=${(-temperature * 0.15).toFixed(4)}:gs=${(tint * 0.1).toFixed(4)}` : '',
        vignette > 0 ? `vignette=angle=${(vignette * 0.8).toFixed(4)}` : '',
        effects,
        'format=rgba', fadeFilters, `setpts=PTS+${start.toFixed(6)}/TB`,
      ].filter(Boolean).join(',')
      filters.push(`[${asset.inputIndex}:v:0]${videoFilters}[${inputLabel}]`)
      filters.push(`[${pictureLabel}][${inputLabel}]overlay=eof_action=pass:shortest=0:enable='between(t,${start.toFixed(6)},${end.toFixed(6)})'[${outputLabel}]`)
      pictureLabel = outputLabel
      pictureIndex += 1
    }
  }
  filters.push(`[${pictureLabel}]format=yuv420p[vout]`)

  const audioByRole: Record<FilmAudioRole, string[]> = { dialogue: [], music: [], effects: [] }
  let audioIndex = 0
  for (const track of tracks.filter((item) => item.kind === 'audio')) {
    const requestedRole = track.audioRole
    const role: FilmAudioRole = requestedRole && ['dialogue', 'music', 'effects'].includes(requestedRole) ? requestedRole : (/dialog|voice|speech/i.test(track.name) ? 'dialogue' : /music|score/i.test(track.name) ? 'music' : 'effects')
    if (track.muted) continue
    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId)
      if (!asset) throw new Error(`MISSING_TIMELINE_ASSET:${clip.assetId}`)
      if (!asset.mimeType.startsWith('audio/') && !asset.mimeType.startsWith('video/')) throw new Error(`INVALID_AUDIO_ASSET:${clip.assetId}`)
      const sourceFps = clip.sourceFps ?? fps
      const clipFrames = Math.max(1, Math.round((clip.sourceOutFrame - clip.sourceInFrame) * fps / sourceFps))
      const start = clip.startFrame / fps
      if (start >= durationFrames) continue
      const clipDuration = clipFrames / fps
      const gain = clamp(clip.gain ?? 1, 0, 4)
      const delayMs = Math.round(start * 1000)
      const label = `aclip_${audioIndex}`
      filters.push(`[${asset.inputIndex}:a:0]atrim=start=${(clip.sourceInFrame / sourceFps).toFixed(6)}:duration=${clipDuration.toFixed(6)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(4)},adelay=${delayMs}|${delayMs}[${label}]`)
      audioByRole[role].push(label)
      audioIndex += 1
    }
  }

  const busLabels: string[] = []
  for (const role of ['dialogue', 'music', 'effects'] as const) {
    const labels = audioByRole[role]
    if (!labels.length) continue
    const bus = `${role}_bus`
    filters.push(`${labels.map((label) => `[${label}]`).join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[${bus}]`)
    busLabels.push(bus)
  }
  let finalAudio = ''
  if (audioByRole.dialogue.length && audioByRole.music.length && options.ducking?.enabled !== false) {
    const threshold = clamp(options.ducking?.threshold ?? 0.035, 0.001, 0.5)
    const ratio = clamp(options.ducking?.ratio ?? 8, 1, 20)
    const attack = clamp(options.ducking?.attackMs ?? 15, 1, 500)
    const release = clamp(options.ducking?.releaseMs ?? 420, 20, 3000)
    filters.push('[dialogue_bus]asplit=2[dialogue_key][dialogue_mix]')
    filters.push(`[music_bus][dialogue_key]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=${attack}:release=${release}[music_ducked]`)
    const mixInputs = ['[dialogue_mix]', '[music_ducked]', ...(audioByRole.effects.length ? ['[effects_bus]'] : [])].join('')
    filters.push(`${mixInputs}amix=inputs=${2 + (audioByRole.effects.length ? 1 : 0)}:duration=longest:dropout_transition=0:normalize=0,volume=${clamp(options.masterGain ?? 1, 0, 4)}[aout]`)
    finalAudio = 'aout'
  } else if (busLabels.length) {
    const inputs = busLabels.map((label) => `[${label}]`).join('')
    filters.push(`${inputs}amix=inputs=${busLabels.length}:duration=longest:dropout_transition=0:normalize=0,volume=${clamp(options.masterGain ?? 1, 0, 4)}[aout]`)
    finalAudio = 'aout'
  }
  const filterComplex = filters.join(';')
  return {
    inputs: options.assets.map((asset) => asset.path),
    filterComplex,
    outputMaps: finalAudio ? ['-map', '[vout]', '-map', `[${finalAudio}]`] : ['-map', '[vout]', '-an'],
    durationSeconds: durationFrames / fps,
  }
}

export type RenderSegment = { index: number; startFrame: number; endFrame: number }

export function sliceTimelineForRenderSegment(
  tracks: readonly PipelineTrack[],
  segment: RenderSegment,
  fps: number,
  totalDurationFrames: number,
  transitionGuardSeconds = 10,
) {
  const guardFrames = Math.max(0, Math.floor(transitionGuardSeconds * fps))
  const windowStartFrame = Math.max(0, segment.startFrame - guardFrames)
  const windowEndFrame = Math.min(totalDurationFrames, segment.endFrame + guardFrames)
  const slicedTracks: PipelineTrack[] = tracks.map((track) => ({
    ...track,
    clips: track.clips.flatMap((clip) => {
      const sourceFps = clip.sourceFps ?? fps
      const timelineFrames = Math.max(1, Math.round((clip.sourceOutFrame - clip.sourceInFrame) * fps / sourceFps))
      const clipEndFrame = clip.startFrame + timelineFrames
      const intersectionStart = Math.max(clip.startFrame, windowStartFrame)
      const intersectionEnd = Math.min(clipEndFrame, windowEndFrame)
      if (intersectionEnd <= intersectionStart) return []
      const sourceStartOffset = Math.round((intersectionStart - clip.startFrame) * sourceFps / fps)
      const sourceEndOffset = Math.round((intersectionEnd - clip.startFrame) * sourceFps / fps)
      const sourceInFrame = Math.min(clip.sourceOutFrame - 1, clip.sourceInFrame + sourceStartOffset)
      const sourceOutFrame = Math.max(sourceInFrame + 1, Math.min(clip.sourceOutFrame, clip.sourceInFrame + sourceEndOffset))
      return [{
        ...clip,
        startFrame: intersectionStart - windowStartFrame,
        sourceInFrame,
        sourceOutFrame,
        transitionInFrames: clip.startFrame >= windowStartFrame ? clip.transitionInFrames ?? 0 : 0,
        transitionOutFrames: clipEndFrame <= windowEndFrame ? clip.transitionOutFrames ?? 0 : 0,
      }]
    }),
  }))
  return {
    tracks: slicedTracks,
    durationFrames: windowEndFrame - windowStartFrame,
    windowStartFrame,
    windowEndFrame,
    trimStartFrames: segment.startFrame - windowStartFrame,
    outputDurationFrames: segment.endFrame - segment.startFrame,
  }
}

function srtTimeToSeconds(value: string): number | null {
  const match = value.match(/^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000
}
function secondsToSrtTime(value: number): string {
  const ms = Math.max(0, Math.round(value * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms % 3600000 / 60000)
  const s = Math.floor(ms % 60000 / 1000)
  const milli = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`
}

/** Rebase absolute film-time SRT cues to the padded local segment timeline. */
export function shiftSrtForRenderSegment(srt: string, windowStartSeconds: number, windowEndSeconds: number): string {
  if (!Number.isFinite(windowStartSeconds) || !Number.isFinite(windowEndSeconds) || windowStartSeconds < 0 || windowEndSeconds <= windowStartSeconds) throw new Error('INVALID_SUBTITLE_WINDOW')
  const blocks = srt.replace(/\r/g, '').trim().split(/\n\s*\n/)
  const output: string[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) continue
    const match = lines[timeIndex].match(/^(\S+)\s+-->\s+(\S+)(.*)$/)
    if (!match) continue
    const start = srtTimeToSeconds(match[1])
    const end = srtTimeToSeconds(match[2])
    if (start === null || end === null || end <= windowStartSeconds || start >= windowEndSeconds) continue
    const localStart = Math.max(0, start - windowStartSeconds)
    const localEnd = Math.min(windowEndSeconds, end) - windowStartSeconds
    if (localEnd <= localStart) continue
    lines[timeIndex] = `${secondsToSrtTime(localStart)} --> ${secondsToSrtTime(localEnd)}${match[3]}`
    output.push(lines.join('\n'))
  }
  return output.join('\n\n') + (output.length ? '\n' : '')
}

export function planRenderSegments(durationFrames: number, fps: number, segmentSeconds = 300): RenderSegment[] {
  if (!Number.isInteger(durationFrames) || durationFrames < 1 || ![24, 25, 30, 50, 60].includes(fps) || !Number.isFinite(segmentSeconds) || segmentSeconds < 10 || segmentSeconds > 900) throw new Error('INVALID_SEGMENT_PLAN')
  const segmentFrames = Math.max(fps * 10, Math.floor(segmentSeconds * fps))
  const segments: RenderSegment[] = []
  for (let startFrame = 0, index = 0; startFrame < durationFrames; startFrame += segmentFrames, index += 1) {
    segments.push({ index, startFrame, endFrame: Math.min(durationFrames, startFrame + segmentFrames) })
  }
  return segments
}

export function pendingRenderSegments(segments: readonly RenderSegment[], checkpoint: RenderCheckpoint): RenderSegment[] {
  const completed = new Set(checkpoint.completedSegments)
  return segments.filter((segment) => !completed.has(segment.index))
}

/** FFmpeg concat-demuxer manifest; paths are escaped for single-quoted concat entries. */
export function buildSegmentConcatManifest(paths: readonly string[]): string {
  if (!paths.length || paths.length > 10000 || paths.some((path) => !path || path.includes('\n') || path.includes('\r'))) throw new Error('INVALID_SEGMENT_PATHS')
  return `${paths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n')}\n`
}

export type RenderCheckpoint = { version: 1; completedSegments: number[]; segmentCount: number; updatedAt: string }
export function normalizeRenderCheckpoint(value: unknown, segmentCount: number): RenderCheckpoint {
  if (!Number.isInteger(segmentCount) || segmentCount < 1 || segmentCount > 10000) throw new Error('INVALID_SEGMENT_COUNT')
  const source = value && typeof value === 'object' ? value as Partial<RenderCheckpoint> : {}
  const completedSegments = [...new Set((Array.isArray(source.completedSegments) ? source.completedSegments : []).filter((item): item is number => Number.isInteger(item) && item >= 0 && item < segmentCount))].sort((a, b) => a - b)
  return { version: 1, completedSegments, segmentCount, updatedAt: new Date().toISOString() }
}

export type CharacterVoiceAssignment = { character: string; voiceId: string; language?: string; notes?: string }
export function assignVoicesToDialogue<T extends { speaker: string; text: string; direction?: string }>(dialogue: readonly T[], assignments: readonly CharacterVoiceAssignment[]) {
  const byCharacter = new Map(assignments.map((item) => [item.character.trim().toLocaleUpperCase(), item]))
  return dialogue.map((line) => {
    const assignment = byCharacter.get(line.speaker.trim().toLocaleUpperCase())
    return { ...line, ...(assignment?.voiceId.trim() ? { voice: { voiceId: assignment.voiceId, language: assignment.language, notes: assignment.notes } } : { voice: null }) }
  })
}

export type SceneReferenceState = { sceneId: string; previousSceneId?: string; characterAssetIds: string[]; locationAssetIds: string[]; styleAssetIds: string[]; continuitySummary?: string }
export function propagateSceneReferences(scenes: readonly SceneReferenceState[]) {
  const seen = new Set<string>()
  const sceneIds = new Set<string>()
  return scenes.map((scene, index) => {
    if (!scene.sceneId || sceneIds.has(scene.sceneId)) throw new Error('DUPLICATE_SCENE_ID')
    sceneIds.add(scene.sceneId)
    const previous = index > 0 ? scenes[index - 1] : undefined
    const unique = (ids: string[]) => [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
    const characterAssetIds = unique([...(previous?.characterAssetIds ?? []), ...scene.characterAssetIds])
    const locationAssetIds = unique([...(previous?.locationAssetIds ?? []), ...scene.locationAssetIds])
    const styleAssetIds = unique([...(previous?.styleAssetIds ?? []), ...scene.styleAssetIds])
    const key = `${scene.sceneId}:${characterAssetIds.join(',')}:${locationAssetIds.join(',')}:${styleAssetIds.join(',')}`
    if (seen.has(key)) throw new Error('DUPLICATE_SCENE_REFERENCE_STATE')
    seen.add(key)
    return { ...scene, previousSceneId: previous?.sceneId, characterAssetIds, locationAssetIds, styleAssetIds }
  })
}
