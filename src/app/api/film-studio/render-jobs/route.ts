import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'
const MAX_CLIPS = 30
export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const productionId = request.nextUrl.searchParams.get('productionId')
  if (!productionId) return NextResponse.json({ error: 'productionId is required.' }, { status: 400 })
  const production = await prisma.filmProduction.findFirst({ where: { id: productionId, userId: auth.session.user.id }, select: { id: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  await prisma.filmRenderJob.updateMany({ where: { productionId, userId: auth.session.user.id, status: 'running', startedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } }, data: { status: 'failed', failure: 'Render worker heartbeat expired. Retry this saved render job.', finishedAt: new Date() } })
  const jobs = await prisma.filmRenderJob.findMany({ where: { productionId, userId: auth.session.user.id }, orderBy: { createdAt: 'desc' }, take: 100 })
  return NextResponse.json({ jobs })
}
export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await request.json().catch(() => null) as { productionId?: string; clips?: unknown[]; audioJobId?: string; subtitles?: string; lutCube?: string; fps?: number; width?: number; height?: number; grade?: unknown } | null
  if (!body?.productionId || !Array.isArray(body.clips) || body.clips.length < 1 || body.clips.length > MAX_CLIPS) return NextResponse.json({ error: `A render requires between 1 and ${MAX_CLIPS} clips.` }, { status: 400 })
  const production = await prisma.filmProduction.findFirst({ where: { id: body.productionId, userId: auth.session.user.id }, select: { id: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const clipJobIds = body.clips.map((clip) => clip && typeof clip === 'object' && 'jobId' in clip ? (clip as { jobId?: unknown }).jobId : undefined)
  if (clipJobIds.some((id) => typeof id !== 'string') || new Set(clipJobIds).size !== clipJobIds.length) return NextResponse.json({ error: 'Every render clip must reference a unique completed generation job.' }, { status: 400 })
  const completedClips = await prisma.filmProductionJob.count({ where: { id: { in: clipJobIds as string[] }, productionId: production.id, userId: auth.session.user.id, status: 'completed' } })
  if (completedClips !== clipJobIds.length) return NextResponse.json({ error: 'Every render clip must reference a completed job in this production.' }, { status: 409 })
  if (body.audioJobId && !await prisma.filmProductionJob.findFirst({ where: { id: body.audioJobId, productionId: production.id, userId: auth.session.user.id, status: 'completed' }, select: { id: true } })) return NextResponse.json({ error: 'Selected soundtrack must be a completed job in this production.' }, { status: 409 })
  if (typeof body.subtitles === 'string' && Buffer.byteLength(body.subtitles, 'utf8') > 2 * 1024 * 1024) return NextResponse.json({ error: 'Subtitle data exceeds 2 MB.' }, { status: 413 })
  if (typeof body.lutCube === 'string' && Buffer.byteLength(body.lutCube, 'utf8') > 2 * 1024 * 1024) return NextResponse.json({ error: 'LUT data exceeds 2 MB.' }, { status: 413 })
  const active = await prisma.filmRenderJob.count({ where: { productionId: production.id, userId: auth.session.user.id, status: { in: ['queued', 'running'] } } })
  if (active >= 3) return NextResponse.json({ error: 'This production already has three active render jobs. Wait for one to finish.' }, { status: 429 })
  const payload = { productionId: production.id, clips: body.clips, audioJobId: body.audioJobId, subtitles: body.subtitles, lutCube: body.lutCube, fps: body.fps ?? 24, width: body.width ?? 1920, height: body.height ?? 1080, grade: body.grade ?? {} }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 5 * 1024 * 1024) return NextResponse.json({ error: 'Render job settings exceed 5 MB.' }, { status: 413 })
  const job = await prisma.filmRenderJob.create({ data: { productionId: production.id, userId: auth.session.user.id, payload: payload as never } })
  return NextResponse.json({ job }, { status: 202 })
}
