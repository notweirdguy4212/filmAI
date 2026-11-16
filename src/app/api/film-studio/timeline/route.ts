import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { validateMultitrackTimeline, type TimelineTrack } from '@/features/film-studio/production-toolkit'

export const dynamic = 'force-dynamic'
const ALLOWED_FPS = new Set([24, 25, 30, 50, 60])

export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const productionId = request.nextUrl.searchParams.get('productionId')
  if (!productionId) return NextResponse.json({ error: 'productionId is required.' }, { status: 400 })
  const production = await prisma.filmProduction.findFirst({ where: { id: productionId, userId: auth.session.user.id }, select: { id: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const timeline = await prisma.filmTimeline.findUnique({ where: { productionId } })
  return NextResponse.json({ timeline: timeline ?? { productionId, fps: 24, width: 1920, height: 1080, revision: 0, tracks: [] } })
}

export async function PUT(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) return NextResponse.json({ error: 'Timeline payload exceeds 2 MB.' }, { status: 413 })
  const body = (await (async () => { try { return JSON.parse(raw) } catch { return null } })()) as { productionId?: string; fps?: number; width?: number; height?: number; tracks?: TimelineTrack[]; expectedRevision?: number } | null
  if (!body?.productionId || !Array.isArray(body.tracks) || !ALLOWED_FPS.has(body.fps ?? 24)) return NextResponse.json({ error: 'A production, valid frame rate and tracks are required.' }, { status: 400 })
  const width = body.width === 1280 ? 1280 : body.width === 3840 ? 3840 : 1920
  const height = width === 1280 ? 720 : width === 3840 ? 2160 : 1080
  let validated: ReturnType<typeof validateMultitrackTimeline>
  try { validated = validateMultitrackTimeline(body.tracks, body.fps ?? 24, 30) }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid timeline.' }, { status: 400 }) }
  const production = await prisma.filmProduction.findFirst({ where: { id: body.productionId, userId: auth.session.user.id }, select: { id: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const assetIds = [...new Set(validated.clips.map((clip) => clip.assetId))]
  if (assetIds.length) {
    const ownedAssets = await prisma.filmAsset.count({ where: { id: { in: assetIds }, productionId: production.id, userId: auth.session.user.id } })
    if (ownedAssets !== assetIds.length) return NextResponse.json({ error: 'Every timeline clip must reference a permanent asset owned by this production.' }, { status: 409 })
  }
  const existing = await prisma.filmTimeline.findUnique({ where: { productionId: production.id } })
  let timeline
  if (existing) {
    if (existing.userId !== auth.session.user.id) return NextResponse.json({ error: 'Timeline not found.' }, { status: 404 })
    if (body.expectedRevision === undefined || body.expectedRevision !== existing.revision) return NextResponse.json({ error: 'TIMELINE_REVISION_CONFLICT', revision: existing.revision }, { status: 409 })
    const claimed = await prisma.filmTimeline.updateMany({ where: { id: existing.id, userId: auth.session.user.id, revision: body.expectedRevision }, data: { fps: body.fps ?? 24, width, height, tracks: body.tracks as never, revision: { increment: 1 } } })
    if (!claimed.count) return NextResponse.json({ error: 'TIMELINE_REVISION_CONFLICT', revision: existing.revision }, { status: 409 })
    timeline = await prisma.filmTimeline.findUnique({ where: { productionId: production.id } })
  } else {
    if (body.expectedRevision !== undefined && body.expectedRevision !== 0) return NextResponse.json({ error: 'TIMELINE_REVISION_CONFLICT', revision: 0 }, { status: 409 })
    try { timeline = await prisma.filmTimeline.create({ data: { productionId: production.id, userId: auth.session.user.id, fps: body.fps ?? 24, width, height, tracks: body.tracks as never } }) }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return NextResponse.json({ error: 'TIMELINE_REVISION_CONFLICT' }, { status: 409 }); throw error }
  }
  return NextResponse.json({ timeline, validation: { clipCount: validated.clipCount, durationFrames: validated.durationFrames } })
}
