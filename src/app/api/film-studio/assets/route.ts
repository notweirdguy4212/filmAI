import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { generateUniqueKey, getSignedUrl, uploadObject } from '@/lib/storage'
import { probeFilmMediaMetadata } from '@/features/film-studio/asset-ingestion'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const MAX_ASSET_BYTES = 500 * 1024 * 1024
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'generated-media'

export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const productionId = request.nextUrl.searchParams.get('productionId')
  if (!productionId) return NextResponse.json({ error: 'productionId is required.' }, { status: 400 })
  const production = await prisma.filmProduction.findFirst({ where: { id: productionId, userId: auth.session.user.id }, select: { id: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const assets = await prisma.filmAsset.findMany({ where: { productionId, userId: auth.session.user.id }, orderBy: { createdAt: 'desc' }, take: 500 })
  return NextResponse.json({ assets: assets.map((asset) => ({ ...asset, sizeBytes: asset.sizeBytes.toString(), url: getSignedUrl(asset.storageKey, 3600) })) })
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await request.json().catch(() => null) as { productionId?: string; jobId?: string; kind?: 'video' | 'audio' | 'image'; filename?: string } | null
  if (!body?.productionId || !body.jobId || !['video', 'audio', 'image'].includes(body.kind ?? '')) return NextResponse.json({ error: 'productionId, jobId and a supported media kind are required.' }, { status: 400 })
  const job = await prisma.filmProductionJob.findFirst({ where: { id: body.jobId, productionId: body.productionId, userId: auth.session.user.id, status: 'completed' } })
  if (!job) return NextResponse.json({ error: 'Completed generation job not found.' }, { status: 404 })
  const existingAsset = await prisma.filmAsset.findFirst({ where: { sourceJobId: job.id, kind: body.kind }, orderBy: { createdAt: 'desc' } })
  if (existingAsset) return NextResponse.json({ asset: { ...existingAsset, sizeBytes: existingAsset.sizeBytes.toString(), url: getSignedUrl(existingAsset.storageKey, 3600) }, reused: true })
  const production = await prisma.filmProduction.findFirst({ where: { id: body.productionId, userId: auth.session.user.id }, select: { id: true, projectId: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const outputs = job.outputs as Record<string, { videos?: { filename: string; subfolder?: string; type?: string }[]; gifs?: { filename: string; subfolder?: string; type?: string }[]; audio?: { filename: string; subfolder?: string; type?: string }[]; audios?: { filename: string; subfolder?: string; type?: string }[]; images?: { filename: string; subfolder?: string; type?: string }[] }> | null
  const list = Object.values(outputs ?? {}).flatMap((group) => body.kind === 'audio' ? [...(group.audio ?? []), ...(group.audios ?? [])] : body.kind === 'image' ? (group.images ?? []) : [...(group.videos ?? []), ...(group.gifs ?? [])])
  const output = list.find((item) => item.filename === body.filename) ?? list[0]
  if (!output || !output.filename || output.filename.includes('..') || /[\\/]/.test(output.filename) || (output.subfolder ?? '').split('/').some((part) => part === '..' || part.includes('\\')) || !['input', 'output', 'temp', undefined].includes(output.type)) return NextResponse.json({ error: 'No safe matching output was found for this job.' }, { status: 404 })
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  if (!baseUrl) return NextResponse.json({ error: 'ComfyUI is not configured.' }, { status: 503 })
  const source = new URL('/view', baseUrl); source.searchParams.set('filename', output.filename); source.searchParams.set('subfolder', output.subfolder ?? ''); source.searchParams.set('type', output.type ?? 'output')
  try {
    const upstream = await fetch(source, { cache: 'no-store', signal: AbortSignal.timeout(120000) })
    if (!upstream.ok) return NextResponse.json({ error: `Media provider returned HTTP ${upstream.status}.` }, { status: 502 })
    const declared = Number(upstream.headers.get('content-length') ?? 0)
    if (declared > MAX_ASSET_BYTES) return NextResponse.json({ error: 'Generated media exceeds the 500 MB asset limit.' }, { status: 413 })
    const bytes = Buffer.from(await upstream.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) return NextResponse.json({ error: 'Generated media is empty or exceeds the 500 MB asset limit.' }, { status: 413 })
    const mimeType = upstream.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream'
    const expected = body.kind === 'video' ? /^video\// : body.kind === 'audio' ? /^audio\// : /^image\//
    if (!expected.test(mimeType)) return NextResponse.json({ error: 'Provider returned a MIME type that does not match the selected asset kind.' }, { status: 415 })
    const filename = safeName(body.filename ?? output.filename)
    const checksum = createHash('sha256').update(bytes).digest('hex')
    let mediaMetadata: { durationSeconds?: number; durationIsEstimate?: boolean } = {}
    try { mediaMetadata = await probeFilmMediaMetadata(bytes, body.kind) } catch { /* retain the asset even if optional metadata probing is unavailable */ }
    const key = generateUniqueKey(`film-studio/${auth.session.user.id}/${production.projectId}/${body.kind}`, filename.split('.').pop() || 'bin')
    await uploadObject(bytes, key, mimeType)
    const asset = await prisma.filmAsset.create({ data: { productionId: production.id, userId: auth.session.user.id, sourceJobId: job.id, kind: body.kind, filename, mimeType, storageKey: key, sizeBytes: BigInt(bytes.length), checksum, metadata: { provider: job.provider, providerJobId: job.providerJobId, sceneId: job.sceneId, ...mediaMetadata } as never } })
    return NextResponse.json({ asset: { ...asset, sizeBytes: asset.sizeBytes.toString(), url: getSignedUrl(key, 3600) } }, { status: 201 })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Generated media ingestion failed.' }, { status: 502 }) }
}
