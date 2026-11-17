import { NextRequest, NextResponse } from 'next/server'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { generateUniqueKey, getObjectBuffer, getSignedUrl, uploadObject } from '@/lib/storage'
import { runFfmpegCommand } from '@/lib/video-compose/ffmpeg-command'
import { validateMultitrackTimeline, type TimelineTrack } from '@/features/film-studio/production-toolkit'
import { buildMultitrackFfmpegPlan, buildSegmentConcatManifest, escapeFilterPath, normalizeRenderCheckpoint, pendingRenderSegments, planRenderSegments, shiftSrtForRenderSegment, sliceTimelineForRenderSegment, type PipelineTrack } from '@/features/film-studio/production-pipeline'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_ASSET_BYTES = 350 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_JOB_PAYLOAD_BYTES = 5 * 1024 * 1024

type RenderPayload = {
  mode: 'multitrack'
  timelineRevision: number
  segmentSeconds: number
  subtitles?: string
  lutCube?: string
  ducking?: { enabled?: boolean; threshold?: number; ratio?: number; attackMs?: number; releaseMs?: number }
  masterGain?: number
  checkpoint: { version: 1; completedSegments: number[]; segmentCount: number; updatedAt: string }
  segmentStorageKeys: string[]
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await request.json().catch(() => null) as { productionId?: string; expectedRevision?: number; renderJobId?: string; subtitles?: string; lutCube?: string; segmentSeconds?: number; ducking?: RenderPayload['ducking']; masterGain?: number } | null
  if (!body?.productionId) return NextResponse.json({ error: 'productionId is required.' }, { status: 400 })
  if (typeof body.subtitles === 'string' && Buffer.byteLength(body.subtitles, 'utf8') > 2 * 1024 * 1024) return NextResponse.json({ error: 'Subtitle file exceeds the 2 MB limit.' }, { status: 413 })
  if (typeof body.lutCube === 'string' && (Buffer.byteLength(body.lutCube, 'utf8') > 2 * 1024 * 1024 || !/^\s*LUT_3D_SIZE\s+\d+/m.test(body.lutCube))) return NextResponse.json({ error: 'The colour LUT must be a valid .cube file no larger than 2 MB.' }, { status: 400 })

  const production = await prisma.filmProduction.findFirst({ where: { id: body.productionId, userId: auth.session.user.id }, select: { id: true, projectId: true, title: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const timeline = await prisma.filmTimeline.findUnique({ where: { productionId: production.id } })
  if (!timeline) return NextResponse.json({ error: 'Save a multitrack timeline before rendering.' }, { status: 409 })
  if (body.expectedRevision !== undefined && body.expectedRevision !== timeline.revision) return NextResponse.json({ error: 'TIMELINE_REVISION_CONFLICT', revision: timeline.revision }, { status: 409 })

  let job = body.renderJobId
    ? await prisma.filmRenderJob.findFirst({ where: { id: body.renderJobId, productionId: production.id, userId: auth.session.user.id } })
    : null
  if (body.renderJobId && !job) return NextResponse.json({ error: 'Multitrack render job not found.' }, { status: 404 })
  if (job && job.status === 'completed') {
    const asset = job.outputAssetId ? await prisma.filmAsset.findFirst({ where: { id: job.outputAssetId, productionId: production.id, userId: auth.session.user.id } }) : null
    if (asset) return NextResponse.json({ jobId: job.id, status: 'completed', progress: 100, asset: { id: asset.id, filename: asset.filename, sizeBytes: Number(asset.sizeBytes), url: getSignedUrl(asset.storageKey, 3600) } })
    return NextResponse.json({ error: 'Completed render job has no archived output asset.' }, { status: 409 })
  }

  let payload: RenderPayload
  if (!job) {
    if (!Number.isInteger(timeline.fps) || ![24, 25, 30, 50, 60].includes(timeline.fps)) return NextResponse.json({ error: 'Timeline frame rate is invalid.' }, { status: 400 })
    const requestedSegmentSeconds = typeof body.segmentSeconds === 'number' && Number.isFinite(body.segmentSeconds) ? Math.floor(body.segmentSeconds) : 90
    const segmentSeconds = Math.max(30, Math.min(120, requestedSegmentSeconds))
    let validated
    try { validated = validateMultitrackTimeline(timeline.tracks as TimelineTrack[], timeline.fps, 30) }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid timeline.' }, { status: 400 }) }
    if (!validated.clipCount) return NextResponse.json({ error: 'The timeline contains no clips.' }, { status: 400 })
    const segmentCount = planRenderSegments(validated.durationFrames, timeline.fps, segmentSeconds).length
    payload = {
      mode: 'multitrack', timelineRevision: timeline.revision, segmentSeconds,
      ...(body.subtitles ? { subtitles: body.subtitles } : {}),
      ...(body.lutCube ? { lutCube: body.lutCube } : {}),
      ...(body.ducking ? { ducking: body.ducking } : {}),
      ...(body.masterGain !== undefined ? { masterGain: body.masterGain } : {}),
      checkpoint: normalizeRenderCheckpoint(null, segmentCount), segmentStorageKeys: [],
    }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_JOB_PAYLOAD_BYTES) return NextResponse.json({ error: 'Render settings exceed the 5 MB job limit.' }, { status: 413 })
    job = await prisma.filmRenderJob.create({ data: { productionId: production.id, userId: auth.session.user.id, status: 'queued', payload: payload as never } })
  } else {
    payload = job.payload as unknown as RenderPayload
    if (payload.mode !== 'multitrack' || payload.timelineRevision !== timeline.revision) return NextResponse.json({ error: 'Saved render snapshot does not match the current timeline revision. Keep the original timeline unchanged or create a new render job.' }, { status: 409 })
  }

  const claimed = await prisma.filmRenderJob.updateMany({
    where: { id: job.id, userId: auth.session.user.id, OR: [{ status: { in: ['queued', 'failed'] } }, { status: 'running', startedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } }] },
    data: { status: 'running', failure: null, startedAt: new Date(), finishedAt: null, attempt: { increment: 1 } },
  })
  if (!claimed.count) return NextResponse.json({ error: 'Render segment is already being processed by another worker.' }, { status: 409 })

  const workDir = await mkdtemp(join(tmpdir(), 'filmai-multitrack-'))
  try {
    const validated = validateMultitrackTimeline(timeline.tracks as TimelineTrack[], timeline.fps, 30)
    const segments = planRenderSegments(validated.durationFrames, timeline.fps, payload.segmentSeconds)
    payload.checkpoint = normalizeRenderCheckpoint(payload.checkpoint, segments.length)
    const completed = new Set(payload.checkpoint.completedSegments)
    const pending = pendingRenderSegments(segments, payload.checkpoint)

    if (pending.length) {
      const segment = pending[0]
      const ids = [...new Set(validated.clips.map((clip) => clip.assetId))]
      const records = await prisma.filmAsset.findMany({ where: { id: { in: ids }, productionId: production.id, userId: auth.session.user.id } })
      if (records.length !== ids.length) throw new Error('Every timeline asset must belong to this production.')
      const recordById = new Map(records.map((asset) => [asset.id, asset]))
      let totalBytes = 0
      const pipelineAssets = []
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]
        const record = recordById.get(id)!
        if (record.sizeBytes > BigInt(MAX_ASSET_BYTES)) throw new Error(`Asset ${record.filename} exceeds the 350 MB render limit.`)
        totalBytes += Number(record.sizeBytes)
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Timeline assets exceed the 2 GB render limit.')
        const bytes = await getObjectBuffer(record.storageKey)
        if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw new Error(`Asset ${record.filename} is empty or exceeds the render limit.`)
        const inputPath = join(workDir, `asset-${index}.${record.filename.split('.').pop()?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'media'}`)
        await writeFile(inputPath, bytes)
        pipelineAssets.push({ id, path: inputPath, mimeType: record.mimeType })
      }
      const sliced = sliceTimelineForRenderSegment(timeline.tracks as PipelineTrack[], segment, timeline.fps, validated.durationFrames, 10)
      const plan = buildMultitrackFfmpegPlan(sliced.tracks, {
        fps: timeline.fps, width: timeline.width, height: timeline.height, durationFrames: sliced.durationFrames,
        assets: pipelineAssets, ducking: payload.ducking, masterGain: payload.masterGain,
      })
      const args: string[] = ['-y']
      for (const asset of pipelineAssets) {
        if (asset.mimeType.startsWith('image/')) args.push('-loop', '1', '-framerate', String(timeline.fps), '-t', String(plan.durationSeconds))
        args.push('-i', asset.path)
      }
      let graph = plan.filterComplex
      if (payload.lutCube?.trim() || payload.subtitles?.trim()) {
        const filters: string[] = []
        if (payload.lutCube?.trim()) {
          const lutPath = join(workDir, 'grade.cube')
          await writeFile(lutPath, payload.lutCube, 'utf8')
          filters.push(`lut3d=file='${escapeFilterPath(lutPath)}':interp=tetrahedral`)
        }
        if (payload.subtitles?.trim()) {
          const subtitlePath = join(workDir, 'captions.srt')
          await writeFile(subtitlePath, shiftSrtForRenderSegment(payload.subtitles, sliced.windowStartFrame / timeline.fps, sliced.windowEndFrame / timeline.fps), 'utf8')
          filters.push(`subtitles='${escapeFilterPath(subtitlePath)}':force_style='FontName=Arial,FontSize=22,Outline=2,Shadow=1,Alignment=2'`)
        }
        graph = graph.replace('[vout]', '[vpre]') + `;[vpre]${filters.join(',')}[vout]`
      }
      const segmentPath = join(workDir, `segment-${segment.index}.mp4`)
      const segmentStart = sliced.trimStartFrames / timeline.fps
      const segmentDuration = sliced.outputDurationFrames / timeline.fps
      args.push('-filter_complex', graph, ...plan.outputMaps, '-ss', segmentStart.toFixed(6), '-t', segmentDuration.toFixed(6),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
        '-r', String(timeline.fps), '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', segmentPath)
      await runFfmpegCommand('ffmpeg', args, { stage: 'film_studio_multitrack_segment', expectedDurationSeconds: Math.max(45, plan.durationSeconds * 2) })
      const bytes = await readFile(segmentPath)
      if (!bytes.length || bytes.length > MAX_TOTAL_BYTES) throw new Error(`Rendered segment ${segment.index + 1} is empty or too large.`)
      const key = generateUniqueKey(`film-studio/${auth.session.user.id}/${production.projectId}/render-segments`, 'mp4')
      await uploadObject(bytes, key, 'video/mp4')
      payload.segmentStorageKeys[segment.index] = key
      payload.checkpoint = normalizeRenderCheckpoint({ completedSegments: [...completed, segment.index] }, segments.length)
      await prisma.filmRenderJob.update({ where: { id: job.id }, data: { status: 'queued', progress: Math.floor(payload.checkpoint.completedSegments.length / segments.length * 95), payload: payload as never, startedAt: null } })
      return NextResponse.json({ jobId: job.id, status: 'queued', progress: Math.floor(payload.checkpoint.completedSegments.length / segments.length * 95), completedSegments: payload.checkpoint.completedSegments.length, totalSegments: segments.length })
    }

    const concatPaths: string[] = []
    for (let index = 0; index < segments.length; index += 1) {
      const key = payload.segmentStorageKeys[index]
      if (!key || !completed.has(index)) throw new Error(`Render checkpoint is missing segment ${index}.`)
      const bytes = await getObjectBuffer(key)
      const segmentPath = join(workDir, `concat-${index}.mp4`)
      await writeFile(segmentPath, bytes)
      concatPaths.push(segmentPath)
    }
    const concatList = join(workDir, 'segments.txt')
    await writeFile(concatList, buildSegmentConcatManifest(concatPaths), 'utf8')
    const masterPath = join(workDir, 'filmAI-multitrack-master.mp4')
    await runFfmpegCommand('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', '-movflags', '+faststart', masterPath], { stage: 'film_studio_multitrack_assemble', expectedDurationSeconds: 90 })
    const master = await readFile(masterPath)
    if (!master.length || master.length > MAX_TOTAL_BYTES) throw new Error('Rendered master is empty or exceeds the 2 GB archival limit.')
    const checksum = createHash('sha256').update(master).digest('hex')
    const storageKey = generateUniqueKey(`film-studio/${auth.session.user.id}/${production.projectId}/renders`, 'mp4')
    await uploadObject(master, storageKey, 'video/mp4')
    const asset = await prisma.filmAsset.create({ data: {
      productionId: production.id, userId: auth.session.user.id, kind: 'video',
      filename: `${production.title.replace(/[^a-z0-9-_]/gi, '-') || 'film'}-multitrack-master.mp4`,
      mimeType: 'video/mp4', storageKey, sizeBytes: BigInt(master.length), checksum,
      metadata: { renderJobId: job.id, timelineRevision: timeline.revision, fps: timeline.fps, width: timeline.width, height: timeline.height, multitrack: true, segmentCount: segments.length } as never,
    } })
    await prisma.filmRenderJob.update({ where: { id: job.id }, data: { status: 'completed', progress: 100, outputAssetId: asset.id, finishedAt: new Date(), payload: payload as never } })
    return NextResponse.json({ jobId: job.id, status: 'completed', progress: 100, asset: { id: asset.id, filename: asset.filename, sizeBytes: master.length, url: getSignedUrl(storageKey, 3600) } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Multitrack render failed.'
    await prisma.filmRenderJob.update({ where: { id: job.id }, data: { status: 'failed', failure: message.slice(0, 4000), finishedAt: new Date(), payload: payload as never } }).catch(() => undefined)
    return NextResponse.json({ error: message, jobId: job.id, resumable: true }, { status: 502 })
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
