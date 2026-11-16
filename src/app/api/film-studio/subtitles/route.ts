import { NextRequest, NextResponse } from 'next/server'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { runFfmpegCommand } from '@/lib/video-compose/ffmpeg-command'
import { exportSrt, type CaptionCue } from '@/features/film-studio/production-toolkit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120
const MAX_MEDIA_BYTES = 100 * 1024 * 1024

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const endpoint = process.env.FILMAI_WHISPER_URL
  if (!endpoint) return NextResponse.json({ error: 'Speech transcription is not configured. Set FILMAI_WHISPER_URL to an OpenAI-compatible audio transcription endpoint.' }, { status: 503 })
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'Upload an audio or video file to transcribe.' }, { status: 400 })
  if (file.size === 0 || file.size > MAX_MEDIA_BYTES) return NextResponse.json({ error: 'Media must be non-empty and no larger than 100 MB.' }, { status: 413 })
  if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) return NextResponse.json({ error: 'Choose a supported audio or video file.' }, { status: 415 })

  const workDir = await mkdtemp(join(tmpdir(), 'filmai-subtitles-'))
  try {
    let transcriptionFile: File = file
    if (file.type.startsWith('video/')) {
      const sourcePath = join(workDir, 'source-video')
      const audioPath = join(workDir, 'transcription.wav')
      await writeFile(sourcePath, Buffer.from(await file.arrayBuffer()))
      await runFfmpegCommand('ffmpeg', ['-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath], { stage: 'film_studio_subtitle_extract_audio', expectedDurationSeconds: 60 })
      const audioBytes = await readFile(audioPath)
      if (!audioBytes.length || audioBytes.byteLength > MAX_MEDIA_BYTES) return NextResponse.json({ error: 'Extracted audio exceeded the transcription size limit.' }, { status: 413 })
      transcriptionFile = new File([new Uint8Array(audioBytes).buffer], 'film-audio.wav', { type: 'audio/wav' })
    }

    const upstreamForm = new FormData()
    upstreamForm.append('file', transcriptionFile, transcriptionFile.name || 'film-audio')
    upstreamForm.append('model', process.env.FILMAI_WHISPER_MODEL || 'whisper-1')
    upstreamForm.append('response_format', 'verbose_json')
    upstreamForm.append('timestamp_granularities[]', 'segment')
    const headers = new Headers()
    if (process.env.FILMAI_WHISPER_API_KEY) headers.set('Authorization', `Bearer ${process.env.FILMAI_WHISPER_API_KEY}`)
    const response = await fetch(endpoint, { method: 'POST', headers, body: upstreamForm, signal: AbortSignal.timeout(110000), cache: 'no-store' })
    const result = await response.json().catch(() => null) as { segments?: { start?: number; end?: number; text?: string }[]; text?: string; error?: { message?: string } | string } | null
    if (!response.ok || !result) return NextResponse.json({ error: typeof result?.error === 'string' ? result.error : result?.error?.message || `Transcription provider returned HTTP ${response.status}.` }, { status: 502 })
    const cues: CaptionCue[] = (result.segments ?? []).filter((segment) => typeof segment.start === 'number' && typeof segment.end === 'number' && segment.end > segment.start && typeof segment.text === 'string' && segment.text.trim()).map((segment) => ({ startSeconds: segment.start!, endSeconds: segment.end!, text: segment.text!.trim() }))
    if (!cues.length) return NextResponse.json({ error: result.text ? 'The transcription provider returned text without segment timestamps. Use a verbose_json Whisper endpoint with segment timestamps enabled.' : 'The transcription provider returned no speech segments.' }, { status: 422 })
    return NextResponse.json({ cues, srt: exportSrt(cues), count: cues.length })
  } catch {
    return NextResponse.json({ error: 'Could not extract or transcribe audio. Check the media file, FFmpeg installation and configured transcription provider.' }, { status: 502 })
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
