import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { generateUniqueKey, uploadObject } from '@/lib/storage'

type OutputEntry = { filename?: string; subfolder?: string; type?: string }
type OutputGroup = { videos?: OutputEntry[]; gifs?: OutputEntry[]; audio?: OutputEntry[]; audios?: OutputEntry[]; images?: OutputEntry[] }
type CompletedJob = { id: string; productionId: string; userId: string; providerJobId: string | null; outputs: unknown }
function outputsFor(outputs: unknown, kind: 'video' | 'audio' | 'image') {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return [] as OutputEntry[]
  return Object.values(outputs as Record<string, OutputGroup>).flatMap((group) => kind === 'video' ? [...(group.videos ?? []), ...(group.gifs ?? [])] : kind === 'audio' ? [...(group.audio ?? []), ...(group.audios ?? [])] : [...(group.images ?? [])]).filter((item) => typeof item.filename === 'string')
}
function validOutput(item: OutputEntry) {
  return Boolean(item.filename && item.filename.length <= 255 && !item.filename.includes('..') && !/[\\/]/.test(item.filename) && (!(item.subfolder ?? '') || !(item.subfolder ?? '').split('/').some((part) => !part || part === '..' || part.includes('\\')))  && ['input', 'output', 'temp', undefined].includes(item.type))
}
export async function ingestCompletedFilmJob(job: CompletedJob, projectId: string): Promise<number> {
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  if (!baseUrl || !job.providerJobId) return 0
  let imported = 0
  for (const kind of ['video', 'audio', 'image'] as const) {
    if (await prisma.filmAsset.findFirst({ where: { sourceJobId: job.id, kind }, select: { id: true } })) continue
    const output = outputsFor(job.outputs, kind).find(validOutput)
    if (!output?.filename) continue
    const url = new URL('/view', baseUrl); url.searchParams.set('filename', output.filename); url.searchParams.set('subfolder', output.subfolder ?? ''); url.searchParams.set('type', output.type ?? 'output')
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(45000) })
    if (!response.ok) continue
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > 500 * 1024 * 1024) continue
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > 500 * 1024 * 1024) continue
    const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream'
    if (!(kind === 'video' ? /^video\// : kind === 'audio' ? /^audio\// : /^image\//).test(mimeType)) continue
    let mediaMetadata: { durationSeconds?: number; durationIsEstimate?: boolean } = {}
    try { mediaMetadata = await probeFilmMediaMetadata(bytes, kind) } catch { /* media can still be archived if ffprobe cannot inspect it */ }
    const extension = output.filename.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin'
    const storageKey = generateUniqueKey(`film-studio/${job.userId}/${projectId}/${kind}`, extension)
    await uploadObject(bytes, storageKey, mimeType)
    try {
      await prisma.filmAsset.create({ data: { productionId: job.productionId, userId: job.userId, sourceJobId: job.id, kind, filename: output.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180), mimeType, storageKey, sizeBytes: BigInt(bytes.length), checksum: createHash('sha256').update(bytes).digest('hex'), metadata: { provider: 'comfyui', providerJobId: job.providerJobId, subfolder: output.subfolder ?? '', ...mediaMetadata } as never } })
      imported += 1
    } catch (error) {
      // A concurrent poll may have won the unique sourceJobId+kind insert.
      await import('@/lib/storage').then(({ deleteObject }) => deleteObject(storageKey)).catch(() => undefined)
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) throw error
    }
  }
  return imported
}

export async function probeFilmMediaMetadata(bytes: Buffer, kind: 'video' | 'audio' | 'image') {
  if (kind === 'image') return { durationSeconds: 5, durationIsEstimate: true }
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { probeMediaDurationSeconds } = await import('@/lib/video-compose/ffmpeg-command')
  const directory = await mkdtemp(join(tmpdir(), 'filmai-asset-probe-'))
  try {
    const path = join(directory, kind === 'video' ? 'source-video' : 'source-audio')
    await writeFile(path, bytes)
    const durationSeconds = await probeMediaDurationSeconds(path, 'film_studio_asset_probe')
    let sourceFps: number | undefined
    if (kind === 'video') {
      const { runFfmpegCommand } = await import('@/lib/video-compose/ffmpeg-command')
      const probe = await runFfmpegCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'json', path], { stage: 'film_studio_asset_fps_probe' })
      const parsed = JSON.parse(probe.stdout) as { streams?: { avg_frame_rate?: string; r_frame_rate?: string }[] }
      for (const rate of [parsed.streams?.[0]?.avg_frame_rate, parsed.streams?.[0]?.r_frame_rate]) {
        if (!rate) continue
        const [numerator, denominator] = rate.split('/').map(Number)
        if (Number.isFinite(numerator) && Number.isFinite(denominator) && numerator > 0 && denominator > 0) { sourceFps = Math.min(120, Math.max(1, numerator / denominator)); break }
      }
    }
    return { durationSeconds, durationIsEstimate: false, ...(sourceFps ? { sourceFps } : {}) }
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined) }
}
