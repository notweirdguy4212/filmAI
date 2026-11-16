export type TimelineClip = { id: string; title: string; durationSeconds: number; mediaPath?: string | null; sourceInFrame?: number; sourceOutFrame?: number }

export function secondsToFrames(seconds: number, fps = 24): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('INVALID_TIMECODE')
  return Math.round(seconds * fps)
}

export function buildFrameTimeline(clips: readonly TimelineClip[], fps = 24) {
  let cursor = 0
  return clips.map((clip, index) => {
    const plannedFrames = secondsToFrames(clip.durationSeconds, fps)
    const sourceInFrame = clip.sourceInFrame ?? 0
    const sourceOutFrame = clip.sourceOutFrame ?? sourceInFrame + plannedFrames
    if (!Number.isInteger(sourceInFrame) || sourceInFrame < 0 || !Number.isInteger(sourceOutFrame) || sourceOutFrame <= sourceInFrame) throw new Error('INVALID_SOURCE_FRAME_RANGE')
    const durationFrames = sourceOutFrame - sourceInFrame
    const item = { ...clip, index: index + 1, sourceInFrame, sourceOutFrame, startFrame: cursor, endFrame: cursor + durationFrames, durationFrames }
    cursor += durationFrames
    return item
  })
}

function toTimecode(frame: number, fps: number): string {
  const wholeSeconds = Math.floor(frame / fps)
  const frames = frame % fps
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const seconds = wholeSeconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

export function exportCmx3600Edl(title: string, clips: readonly TimelineClip[], fps = 24): string {
  const timeline = buildFrameTimeline(clips, fps)
  const lines = [`TITLE: ${title.replace(/[\r\n]/g, ' ').slice(0, 64)}`, `FCM: NON-DROP FRAME`, '']
  for (const clip of timeline) {
    const sourceIn = toTimecode(clip.sourceInFrame ?? 0, fps)
    const sourceOut = toTimecode(clip.sourceOutFrame ?? clip.durationFrames, fps)
    lines.push(`${String(clip.index).padStart(3, '0')}  AX       V     C        ${sourceIn} ${sourceOut} ${toTimecode(clip.startFrame, fps)} ${toTimecode(clip.endFrame, fps)}`)
    lines.push(`* FROM CLIP NAME: ${clip.title.replace(/[\r\n]/g, ' ').slice(0, 64)}`)
    if (clip.mediaPath) lines.push(`* SOURCE FILE: ${clip.mediaPath.replace(/[\r\n]/g, ' ')}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

export type CaptionCue = { startSeconds: number; endSeconds: number; text: string }
function srtTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const secs = Math.floor(milliseconds % 60_000 / 1000)
  const ms = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

export function exportSrt(cues: readonly CaptionCue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startSeconds)} --> ${srtTimestamp(cue.endSeconds)}\n${cue.text.replace(/\r/g, '').trim()}\n`).join('\n')
}

export function buildContinuityPrompt(input: { sceneTitle: string; sceneDescription: string; visualStyle?: string; characterBible?: string; previousSceneSummary?: string }) {
  return [
    `SCENE: ${input.sceneTitle}`,
    input.sceneDescription,
    input.visualStyle ? `GLOBAL VISUAL LANGUAGE (keep consistent across every shot): ${input.visualStyle}` : '',
    input.characterBible ? `CHARACTER CONTINUITY BIBLE (identity, facial features, hair, age, costume, body proportions and props must remain stable): ${input.characterBible}` : '',
    input.previousSceneSummary ? `CONTINUITY FROM PREVIOUS SCENE (preserve screen direction, time of day, wardrobe and emotional state): ${input.previousSceneSummary}` : '',
    'CINEMATOGRAPHY: coherent geography, motivated camera movement, natural motion, stable anatomy, consistent lighting direction, physically plausible shadows.',
    'AVOID: identity drift, costume changes, face morphing, extra limbs, flicker, abrupt camera jumps, inconsistent props, text overlays, logos, watermarks.',
  ].filter(Boolean).join('\n\n')
}

export type TimelineTrack = { id: string; name: string; kind: 'video' | 'audio' | 'title' | 'effect'; muted?: boolean; locked?: boolean; audioRole?: 'dialogue' | 'music' | 'effects'; zIndex?: number; clips: TimelineTrackClip[] }
export type TimelineTrackClip = { id: string; assetId: string; title: string; startFrame: number; sourceInFrame: number; sourceOutFrame: number; gain?: number; transitionInFrames?: number; transitionOutFrames?: number; transitionType?: 'fade' | 'dissolve' | 'wipeleft' | 'wiperight' | 'slideleft' | 'slideright' | 'circleopen' | 'circleclose'; sourceFps?: number; grade?: { brightness?: number; contrast?: number; saturation?: number; gamma?: number; exposure?: number; temperature?: number; tint?: number; vignette?: number }; effects?: Array<{ type: 'blur' | 'sharpen' | 'vignette' | 'grain'; amount?: number }> }

/** Validate and flatten a multitrack edit decision timeline without floating-point time drift. */
export function validateMultitrackTimeline(tracks: readonly TimelineTrack[], fps: number, maxClips = 30) {
  if (!Number.isInteger(fps) || ![24, 25, 30, 50, 60].includes(fps)) throw new Error('INVALID_FPS')
  if (!Array.isArray(tracks) || tracks.length > 32) throw new Error('INVALID_TRACKS')
  const ids = new Set<string>()
  const flattened: Array<TimelineTrackClip & { trackId: string; trackKind: TimelineTrack['kind']; endFrame: number }> = []
  for (const track of tracks) {
    if (!track || typeof track.id !== 'string' || track.id.length > 128 || typeof track.name !== 'string' || track.name.length > 120 || !['video', 'audio', 'title', 'effect'].includes(track.kind) || !Array.isArray(track.clips) || (track.audioRole !== undefined && !['dialogue', 'music', 'effects'].includes(track.audioRole)) || (track.zIndex !== undefined && (!Number.isInteger(track.zIndex) || track.zIndex < -1000 || track.zIndex > 1000))) throw new Error('INVALID_TRACK')
    for (const clip of track.clips) {
      if (!clip || typeof clip.id !== 'string' || clip.id.length > 128 || ids.has(clip.id)) throw new Error('DUPLICATE_CLIP_ID')
      ids.add(clip.id)
      if (typeof clip.assetId !== 'string' || !clip.assetId || clip.assetId.length > 191 || typeof clip.title !== 'string' || clip.title.length > 255 || !Number.isInteger(clip.startFrame) || clip.startFrame < 0 || clip.startFrame > 100_000_000 || !Number.isInteger(clip.sourceInFrame) || clip.sourceInFrame < 0 || !Number.isInteger(clip.sourceOutFrame) || clip.sourceOutFrame <= clip.sourceInFrame || clip.sourceOutFrame > 100_000_000) throw new Error('INVALID_CLIP_RANGE')
      const sourceDuration = clip.sourceOutFrame - clip.sourceInFrame
      const timelineDuration = Math.max(1, Math.round(sourceDuration * fps / (clip.sourceFps ?? fps)))
      const transitionIn = clip.transitionInFrames ?? 0
      const transitionOut = clip.transitionOutFrames ?? 0
      if (![transitionIn, transitionOut].every((v) => Number.isInteger(v) && v >= 0 && v <= Math.min(timelineDuration, fps * 10))) throw new Error('INVALID_TRANSITION')
      if (clip.transitionType !== undefined && !['fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'circleclose'].includes(clip.transitionType)) throw new Error('INVALID_TRANSITION_TYPE')
      if (clip.gain !== undefined && (!Number.isFinite(clip.gain) || clip.gain < 0 || clip.gain > 4)) throw new Error('INVALID_CLIP_GAIN')
      if (clip.sourceFps !== undefined && (!Number.isFinite(clip.sourceFps) || clip.sourceFps < 1 || clip.sourceFps > 120)) throw new Error('INVALID_SOURCE_FPS')
      if (clip.grade && Object.entries(clip.grade).some(([key, value]) => !['brightness', 'contrast', 'saturation', 'gamma', 'exposure', 'temperature', 'tint', 'vignette'].includes(key) || !Number.isFinite(value))) throw new Error('INVALID_CLIP_GRADE')
      if (clip.effects && (!Array.isArray(clip.effects) || clip.effects.length > 8 || clip.effects.some((effect: { type: string; amount?: number }) => !effect || !['blur', 'sharpen', 'vignette', 'grain'].includes(effect.type) || (effect.amount !== undefined && (!Number.isFinite(effect.amount) || effect.amount < 0 || effect.amount > 1))))) throw new Error('INVALID_CLIP_EFFECTS')
      flattened.push({ ...clip, trackId: track.id, trackKind: track.kind, endFrame: clip.startFrame + timelineDuration })
    }
  }
  if (flattened.length > maxClips) throw new Error(`CLIP_LIMIT_${maxClips}`)
  return { fps, clipCount: flattened.length, durationFrames: flattened.reduce((max, clip) => Math.max(max, clip.endFrame), 0), clips: flattened.sort((a, b) => a.startFrame - b.startFrame || a.trackId.localeCompare(b.trackId)) }
}

export type DialogueLine = { speaker: string; text: string; direction?: string }
export function extractDialogueLines(screenplay: string): DialogueLine[] {
  const lines = screenplay.split(/\r?\n/)
  const result: DialogueLine[] = []
  let speaker = ''
  let direction = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { speaker = ''; direction = ''; continue }
    const cue = line.match(/^([A-Z][A-Z0-9 ._'-]{1,38})(?:\s*\(([^)]*)\))?$/)
    if (cue && !/^(INT|EXT|INT\/EXT|FADE|CUT|DISSOLVE|SMASH CUT|CONTINUED)/.test(cue[1])) {
      speaker = cue[1].replace(/\s+/g, ' ').trim()
      direction = cue[2] ?? ''
      continue
    }
    if (speaker && /^\([^)]*\)$/.test(line)) { direction = line.slice(1, -1).trim(); continue }
    if (speaker && !/^(INT\.|EXT\.|FADE|CUT TO:)/i.test(line)) {
      result.push({ speaker, text: line, ...(direction ? { direction } : {}) })
    }
  }
  return result
}
