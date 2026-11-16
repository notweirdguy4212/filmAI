import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { generateUniqueKey, getSignedUrl, uploadObject } from '@/lib/storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300
export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await request.json().catch(() => null) as { jobId?: string } | null
  if (!body?.jobId) return NextResponse.json({ error: 'jobId is required.' }, { status: 400 })
  const job = await prisma.filmRenderJob.findFirst({ where: { id: body.jobId, userId: auth.session.user.id, status: { in: ['queued', 'failed'] } } })
  if (!job) return NextResponse.json({ error: 'Queued or retryable render job not found.' }, { status: 404 })
  if (job.payload !== null && typeof job.payload === 'object' && !Array.isArray(job.payload) && 'mode' in job.payload && job.payload.mode === 'multitrack') return NextResponse.json({ error: 'This is a segmented multitrack job. Resume it through /api/film-studio/render-multitrack with renderJobId.' }, { status: 409 })
  const claim = await prisma.filmRenderJob.updateMany({ where: { id: job.id, userId: auth.session.user.id, status: { in: ['queued', 'failed'] } }, data: { status: 'running', progress: 5, failure: null, startedAt: new Date(), finishedAt: null, attempt: { increment: 1 } } })
  if (!claim.count) return NextResponse.json({ error: 'Render job was already claimed by another worker.' }, { status: 409 })
  try {
    const origin = new URL(request.url).origin
    const render = await fetch(new URL('/api/film-studio/render', origin), { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: request.headers.get('cookie') ?? '' }, body: JSON.stringify(job.payload), cache: 'no-store', signal: AbortSignal.timeout(240000) })
    if (!render.ok) {
      const details = await render.json().catch(() => ({})) as { error?: string }
      throw new Error(details.error || `Renderer returned HTTP ${render.status}.`)
    }
    const contentType = render.headers.get('content-type') ?? ''
    if (!contentType.startsWith('video/mp4')) throw new Error('Renderer did not return an MP4 file.')
    const bytes = Buffer.from(await render.arrayBuffer())
    if (!bytes.length || bytes.length > 2 * 1024 * 1024 * 1024) throw new Error('Rendered file is empty or exceeds the 2 GB asset limit.')
    const production = await prisma.filmProduction.findFirst({ where: { id: job.productionId, userId: auth.session.user.id }, select: { projectId: true, title: true } })
    if (!production) throw new Error('Production was deleted during rendering.')
    const checksum = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
    const key = generateUniqueKey(`film-studio/${auth.session.user.id}/${production.projectId}/renders`, 'mp4')
    await uploadObject(bytes, key, 'video/mp4')
    const asset = await prisma.filmAsset.create({ data: { productionId: job.productionId, userId: auth.session.user.id, kind: 'video', filename: `${production.title.replace(/[^a-z0-9-_]/gi, '-') || 'film'}-final.mp4`, mimeType: 'video/mp4', storageKey: key, sizeBytes: BigInt(bytes.length), checksum, metadata: { renderJobId: job.id, fps: (job.payload as { fps?: number }).fps ?? 24 } as never } })
    const updated = await prisma.filmRenderJob.update({ where: { id: job.id }, data: { status: 'completed', progress: 100, outputAssetId: asset.id, finishedAt: new Date() } })
    return NextResponse.json({ job: updated, asset: { id: asset.id, filename: asset.filename, sizeBytes: bytes.length, url: getSignedUrl(key, 3600) } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Background render failed.'
    await prisma.filmRenderJob.update({ where: { id: job.id }, data: { status: 'failed', failure: message.slice(0, 4000), finishedAt: new Date() } }).catch(() => undefined)
    return NextResponse.json({ error: message, jobId: job.id }, { status: 502 })
  }
}
