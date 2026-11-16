import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type OutputEntry = { filename?: string; subfolder?: string; type?: string }
type OutputGroup = { videos?: OutputEntry[]; gifs?: OutputEntry[]; audio?: OutputEntry[]; audios?: OutputEntry[] }

function firstOutput(outputs: unknown, kind: 'video' | 'audio'): OutputEntry | null {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null
  for (const group of Object.values(outputs as Record<string, OutputGroup>)) {
    for (const list of (kind === 'audio' ? [group?.audio, group?.audios] : [group?.videos, group?.gifs])) {
      const item = Array.isArray(list) ? list.find((entry) => typeof entry?.filename === 'string') : undefined
      if (item) return item
    }
  }
  return null
}

export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const jobId = request.nextUrl.searchParams.get('jobId')
  if (!jobId) return NextResponse.json({ error: 'A production job id is required.' }, { status: 400 })
  const job = await prisma.filmProductionJob.findFirst({ where: { id: jobId, userId: auth.session.user.id, status: 'completed' }, select: { outputs: true } })
  if (!job) return NextResponse.json({ error: 'Completed generated media was not found.' }, { status: 404 })
  const kind = request.nextUrl.searchParams.get('kind') === 'audio' ? 'audio' : 'video'
  const output = firstOutput(job.outputs, kind)
  if (!output || !output.filename || output.filename.includes('..') || output.filename.includes('/') || output.filename.includes('\\') || (output.subfolder ?? '').split('/').some((part) => part === '..' || part.includes('\\')) || !['input', 'output', 'temp', undefined].includes(output.type)) return NextResponse.json({ error: 'The generation job has no supported media output.' }, { status: 404 })
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  if (!baseUrl) return NextResponse.json({ error: 'ComfyUI is not configured.' }, { status: 503 })
  const upstream = new URL('/view', baseUrl)
  upstream.searchParams.set('filename', output.filename)
  upstream.searchParams.set('subfolder', output.subfolder ?? '')
  upstream.searchParams.set('type', output.type ?? 'output')
  try {
    const response = await fetch(upstream, { cache: 'no-store', signal: AbortSignal.timeout(30000) })
    if (!response.ok || !response.body) return NextResponse.json({ error: `Media provider returned HTTP ${response.status}.` }, { status: 502 })
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
    if (!(kind === 'audio' ? /^audio\//i.test(contentType) : /^video\//i.test(contentType))) return NextResponse.json({ error: 'Provider output does not match the requested media type.' }, { status: 415 })
    return new NextResponse(response.body, { headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' } })
  } catch {
    return NextResponse.json({ error: 'Could not retrieve generated media from ComfyUI.' }, { status: 502 })
  }
}
