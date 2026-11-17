import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

type OutputRecord = { filename?: string; subfolder?: string; type?: string }
export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const promptId = request.nextUrl.searchParams.get('promptId')
  if (!promptId) return NextResponse.json({ error: 'promptId is required.' }, { status: 400 })
  const job = await prisma.filmProductionJob.findFirst({ where: { providerJobId: promptId, userId: auth.session.user.id } })
  if (!job) return NextResponse.json({ error: 'Generation job not found.' }, { status: 404 })
  const outputs = job.outputs as Record<string, { images?: OutputRecord[]; videos?: OutputRecord[]; gifs?: OutputRecord[] }> | null
  const media = Object.entries(outputs ?? {}).flatMap(([nodeId, value]) => [...(value.images ?? []), ...(value.videos ?? []), ...(value.gifs ?? [])].filter((file) => typeof file.filename === 'string' && file.filename.length > 0).map((file) => ({ nodeId, filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output', kind: /\.(mp4|webm|mov|mkv)$/i.test(file.filename ?? '') ? 'video' : /\.(wav|mp3|flac|ogg)$/i.test(file.filename ?? '') ? 'audio' : /\.(png|jpe?g|webp|gif)$/i.test(file.filename ?? '') ? 'image' : 'other', url: `/api/film-studio/outputs/file?promptId=${encodeURIComponent(promptId)}&filename=${encodeURIComponent(file.filename ?? '')}&subfolder=${encodeURIComponent(file.subfolder ?? '')}&type=${encodeURIComponent(file.type ?? 'output')}` })))
  return NextResponse.json({ promptId, media })
}
