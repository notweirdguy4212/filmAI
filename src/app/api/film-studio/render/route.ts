import { NextRequest, NextResponse } from 'next/server'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { getObjectBuffer } from '@/lib/storage'
import { probeMediaDurationSeconds, probeMediaFrameRate, runFfmpegCommand } from '@/lib/video-compose/ffmpeg-command'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_CLIPS = 30
const MAX_CLIP_BYTES = 350 * 1024 * 1024
const FPS_ALLOWED = new Set([24, 25, 30, 50, 60])
type OutputEntry = { filename?: string; subfolder?: string; type?: string }
type OutputGroup = { videos?: OutputEntry[]; gifs?: OutputEntry[]; audio?: OutputEntry[]; audios?: OutputEntry[] }
type ClipInput = { jobId: string; startFrame?: number; endFrame?: number }

function findOutput(outputs: unknown, kind: 'video' | 'audio'): OutputEntry | null {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null
  for (const group of Object.values(outputs as Record<string, OutputGroup>)) {
    const list = kind === 'audio' ? [...(group?.audio ?? []), ...(group?.audios ?? [])] : [...(group?.videos ?? []), ...(group?.gifs ?? [])]
    const item = list.find((entry) => typeof entry?.filename === 'string')
    if (item) return item
  }
  return null
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  const body = await request.json().catch(() => null) as { productionId?: string; clips?: ClipInput[]; audioJobId?: string; subtitles?: string; lutCube?: string; fps?: number; width?: number; height?: number; grade?: { brightness?: number; contrast?: number; saturation?: number } } | null
  if (!body || typeof body.productionId !== 'string' || !Array.isArray(body.clips) || body.clips.length === 0 || body.clips.length > MAX_CLIPS) return NextResponse.json({ error: `Provide a production and between 1 and ${MAX_CLIPS} completed scene clips.` }, { status: 400 })
  const fps = FPS_ALLOWED.has(body.fps ?? 24) ? body.fps ?? 24 : 24
  const is720p = body.width === 1280 && body.height === 720
  const is4k = body.width === 3840 && body.height === 2160
  const width = is4k ? 3840 : is720p ? 1280 : 1920
  const height = is4k ? 2160 : is720p ? 720 : 1080
  const brightness = boundedNumber(body.grade?.brightness, 0, -0.2, 0.2)
  const contrast = boundedNumber(body.grade?.contrast, 1, 0.5, 1.8)
  const saturation = boundedNumber(body.grade?.saturation, 1, 0, 2)
  const production = await prisma.filmProduction.findFirst({ where: { id: body.productionId, userId: auth.session.user.id }, select: { id: true, title: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const ids = body.clips.map((clip) => clip?.jobId).filter((id): id is string => typeof id === 'string')
  if (ids.length !== body.clips.length || new Set(ids).size !== ids.length) return NextResponse.json({ error: 'Each clip must reference a unique production job.' }, { status: 400 })
  const jobs = await prisma.filmProductionJob.findMany({ where: { id: { in: ids }, productionId: production.id, userId: auth.session.user.id, status: 'completed' } })
  const audioJob = body.audioJobId ? await prisma.filmProductionJob.findFirst({ where: { id: body.audioJobId, productionId: production.id, userId: auth.session.user.id, status: 'completed' } }) : null
  if (body.audioJobId && !audioJob) return NextResponse.json({ error: 'Selected soundtrack job is not a completed job in this production.' }, { status: 409 })
  if (typeof body.subtitles === 'string' && Buffer.byteLength(body.subtitles, 'utf8') > 2 * 1024 * 1024) return NextResponse.json({ error: 'Subtitle file exceeds the 2 MB limit.' }, { status: 413 })
  if (typeof body.lutCube === 'string' && (Buffer.byteLength(body.lutCube, 'utf8') > 2 * 1024 * 1024 || !/^\s*(?:TITLE|LUT_3D_SIZE)\b/m.test(body.lutCube) || !/^\s*LUT_3D_SIZE\s+\d+/m.test(body.lutCube))) return NextResponse.json({ error: 'The colour LUT must be a valid .cube file no larger than 2 MB.' }, { status: 400 })
  const byId = new Map(jobs.map((job) => [job.id, job]))
  if (jobs.length !== ids.length) return NextResponse.json({ error: 'Every timeline clip must reference a completed generation job in this production.' }, { status: 409 })
  const workDir = await mkdtemp(join(tmpdir(), 'filmai-render-'))
  try {
    const clipPaths: string[] = []
    let totalBytes = 0
    for (let index = 0; index < body.clips.length; index += 1) {
      const clip = body.clips[index]
      const job = byId.get(clip.jobId)!
      const storedAsset = await prisma.filmAsset.findFirst({ where: { sourceJobId: job.id, productionId: production.id, userId: auth.session.user.id, kind: 'video' }, select: { storageKey: true, sizeBytes: true } })
      let bytes: Buffer
      if (storedAsset) {
        if (storedAsset.sizeBytes > BigInt(MAX_CLIP_BYTES)) throw new Error('Archived generated clip exceeds the per-file render limit.')
        bytes = await getObjectBuffer(storedAsset.storageKey)
      } else {
        if (!baseUrl) throw new Error('Generated media is not archived and ComfyUI is not configured. Set FILMAI_COMFYUI_URL or ingest the media first.')
        const output = findOutput(job.outputs, 'video')
        if (!output?.filename || output.filename.includes('..') || output.filename.includes('/') || output.filename.includes('\\') || (output.subfolder ?? '').split('/').some((part) => part === '..' || part.includes('\\')) || !['input', 'output', 'temp', undefined].includes(output.type)) throw new Error(`No safe video output was found for ${job.sceneTitle}.`)
        const sourceUrl = new URL('/view', baseUrl)
        sourceUrl.searchParams.set('filename', output.filename)
        sourceUrl.searchParams.set('subfolder', output.subfolder ?? '')
        sourceUrl.searchParams.set('type', output.type ?? 'output')
        const upstream = await fetch(sourceUrl, { cache: 'no-store', signal: AbortSignal.timeout(60000) })
        if (!upstream.ok) throw new Error(`Could not ingest ${job.sceneTitle} from ComfyUI (HTTP ${upstream.status}).`)
        const declaredSize = Number(upstream.headers.get('content-length') ?? 0)
        if (declaredSize > MAX_CLIP_BYTES) throw new Error('Generated clip exceeds the per-file ingestion limit.')
        bytes = Buffer.from(await upstream.arrayBuffer())
      }
      totalBytes += bytes.byteLength
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIP_BYTES || totalBytes > 2 * 1024 * 1024 * 1024) throw new Error('Generated media exceeded the render ingestion size limit.')
      const inputPath = join(workDir, `source-${index}.media`)
      const outputPath = join(workDir, `clip-${index}.mp4`)
      await writeFile(inputPath, bytes)
      const startFrame = Math.floor(boundedNumber(clip.startFrame, 0, 0, 10_000_000))
      const endFrame = Math.floor(boundedNumber(clip.endFrame, 0, 1, 10_000_000))
      if (endFrame > 0 && endFrame <= startFrame) throw new Error(`Invalid frame range for ${job.sceneTitle}: end frame must be greater than start frame.`)
      const sourceDuration = await probeMediaDurationSeconds(inputPath, 'film_studio_render_probe')
      const sourceFps = await probeMediaFrameRate(inputPath, 'film_studio_render_fps_probe').catch(() => fps)
      const clipDuration = endFrame > startFrame ? (endFrame - startFrame) / sourceFps : Math.max(0.25, sourceDuration - startFrame / sourceFps)
      const trim = endFrame > startFrame ? `trim=start_frame=${startFrame}:end_frame=${endFrame},` : startFrame > 0 ? `trim=start_frame=${startFrame},` : ''
      const fadeFilters = [index === 0 ? 'fade=t=in:st=0:d=0.35' : '', index === body.clips.length - 1 ? `fade=t=out:st=${Math.max(0, clipDuration - 0.35)}:d=0.35` : ''].filter(Boolean).join(',')
      const filters = [trim + 'setpts=PTS-STARTPTS', `fps=${fps}`, `scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1', `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`, 'format=yuv420p', fadeFilters].filter(Boolean).join(',')
      await runFfmpegCommand('ffmpeg', ['-y', '-i', inputPath, '-vf', filters, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-r', String(fps), '-movflags', '+faststart', outputPath], { stage: 'film_studio_render_normalize', expectedDurationSeconds: 60 })
      clipPaths.push(outputPath)
    }
    const concatList = join(workDir, 'concat.txt')
    await writeFile(concatList, `${clipPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n')}\n`, 'utf8')
    const finalPath = join(workDir, 'filmAI-final.mp4')
    const renderArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', concatList]
    if (audioJob) {
      const storedAudio = await prisma.filmAsset.findFirst({ where: { sourceJobId: audioJob.id, productionId: production.id, userId: auth.session.user.id, kind: 'audio' }, select: { storageKey: true, sizeBytes: true } })
      let audioBytes: Buffer
      if (storedAudio) {
        if (storedAudio.sizeBytes > BigInt(MAX_CLIP_BYTES)) throw new Error('Archived soundtrack exceeds the audio render limit.')
        audioBytes = await getObjectBuffer(storedAudio.storageKey)
      } else {
        if (!baseUrl) throw new Error('The soundtrack is not archived and ComfyUI is not configured. Ingest the audio asset first.')
        const audio = findOutput(audioJob.outputs, 'audio')
        if (!audio?.filename || audio.filename.includes('..') || audio.filename.includes('/') || audio.filename.includes('\\') || (audio.subfolder ?? '').split('/').some((part) => part === '..' || part.includes('\\')) || !['input', 'output', 'temp', undefined].includes(audio.type)) throw new Error('The selected soundtrack job has no safe audio output.')
        const audioUrl = new URL('/view', baseUrl); audioUrl.searchParams.set('filename', audio.filename); audioUrl.searchParams.set('subfolder', audio.subfolder ?? ''); audioUrl.searchParams.set('type', audio.type ?? 'output')
        const audioResponse = await fetch(audioUrl, { cache: 'no-store', signal: AbortSignal.timeout(60000) })
        if (!audioResponse.ok) throw new Error(`Could not retrieve soundtrack from ComfyUI (HTTP ${audioResponse.status}).`)
        const audioDeclaredSize = Number(audioResponse.headers.get('content-length') ?? 0)
        if (audioDeclaredSize > MAX_CLIP_BYTES) throw new Error('Soundtrack exceeds the audio ingestion limit.')
        audioBytes = Buffer.from(await audioResponse.arrayBuffer())
      }
      if (!audioBytes.length || audioBytes.length > MAX_CLIP_BYTES) throw new Error('Soundtrack exceeded the audio ingestion limit.')
      const audioPath = join(workDir, 'soundtrack.audio'); await writeFile(audioPath, audioBytes); renderArgs.push('-i', audioPath)
    }
    let subtitlePath = ''
    if (typeof body.subtitles === 'string' && body.subtitles.trim()) { subtitlePath = join(workDir, 'subtitles.srt'); await writeFile(subtitlePath, body.subtitles, 'utf8') }
    let lutPath = ''
    if (typeof body.lutCube === 'string' && body.lutCube.trim()) { lutPath = join(workDir, 'look.cube'); await writeFile(lutPath, body.lutCube, 'utf8') }
    if (audioJob) renderArgs.push('-map', '0:v:0', '-map', '1:a:0', '-af', 'apad', '-c:a', 'aac', '-b:a', '256k', '-shortest')
    else renderArgs.push('-an')
    const finalFilters = [lutPath ? `lut3d=file=${lutPath}:interp=tetrahedral` : '', subtitlePath ? `subtitles=${subtitlePath}:force_style='FontName=Arial,FontSize=22,Outline=2,Shadow=1,Alignment=2'` : ''].filter(Boolean)
    if (finalFilters.length) renderArgs.push('-vf', finalFilters.join(','))
    renderArgs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', finalPath)
    await runFfmpegCommand('ffmpeg', renderArgs, { stage: 'film_studio_render_assemble', expectedDurationSeconds: 600 })
    const rendered = await readFile(finalPath)
    return new NextResponse(new Uint8Array(rendered), { headers: { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${production.title.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 80) || 'filmAI-film'}.mp4"`, 'Content-Length': String(rendered.byteLength), 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Final render failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
