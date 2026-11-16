import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'
const safeSegment = (value: string) => value.length <= 255 && !value.includes('..') && !/[\\/\\\\\0]/.test(value)
export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const params = request.nextUrl.searchParams
  const promptId = params.get('promptId') ?? ''
  const filename = params.get('filename') ?? ''
  const subfolder = params.get('subfolder') ?? ''
  const type = params.get('type') ?? 'output'
  if (!promptId || !safeSegment(filename) || !filename || (subfolder && subfolder.split('/').some((part) => !safeSegment(part))) || !['input', 'output', 'temp'].includes(type)) return NextResponse.json({ error: 'Invalid media reference.' }, { status: 400 })
  const job = await prisma.filmProductionJob.findFirst({ where: { providerJobId: promptId, userId: auth.session.user.id }, select: { id: true } })
  if (!job) return NextResponse.json({ error: 'Media reference not found.' }, { status: 404 })
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  if (!baseUrl) return NextResponse.json({ error: 'ComfyUI is not configured.' }, { status: 503 })
  const url = new URL('/view', baseUrl)
  url.searchParams.set('filename', filename)
  url.searchParams.set('subfolder', subfolder)
  url.searchParams.set('type', type)
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(30000), cache: 'no-store' })
    if (!upstream.ok || !upstream.body) return NextResponse.json({ error: 'Generated media is not available from ComfyUI.' }, { status: 502 })
    return new NextResponse(upstream.body, { status: 200, headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'Content-Disposition': `inline; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' } })
  } catch { return NextResponse.json({ error: 'Could not retrieve generated media.' }, { status: 502 }) }
}
