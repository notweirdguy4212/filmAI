import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'
const MAX_SCRIPT = 2 * 1024 * 1024

export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const id = request.nextUrl.searchParams.get('id')
  if (id) {
    const production = await prisma.filmProduction.findFirst({ where: { id, userId: auth.session.user.id }, include: { jobs: { orderBy: { createdAt: 'desc' }, take: 100 } } })
    if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
    return NextResponse.json({ production })
  }
  const productions = await prisma.filmProduction.findMany({ where: { userId: auth.session.user.id }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, title: true, format: true, genre: true, revision: true, updatedAt: true } })
  return NextResponse.json({ productions })
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.title !== 'string' || typeof body.script !== 'string' || !Array.isArray(body.scenes)) return NextResponse.json({ error: 'Title, screenplay and scenes are required.' }, { status: 400 })
  if (Buffer.byteLength(body.script, 'utf8') > MAX_SCRIPT) return NextResponse.json({ error: 'Screenplay exceeds the 2 MB limit.' }, { status: 413 })
  const title = body.title.trim().slice(0, 191) || 'Untitled production'
  const production = await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({ data: { name: title, description: 'filmAI Studio production', userId: auth.session.user.id } })
    return tx.filmProduction.create({ data: { projectId: project.id, userId: auth.session.user.id, title, format: typeof body.format === 'string' ? body.format.slice(0, 64) : 'Short film', genre: typeof body.genre === 'string' ? body.genre.slice(0, 191) : '', screenplay: body.script, scenes: body.scenes as never, settings: body.settings as never } })
  })
  return NextResponse.json({ production }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.id !== 'string') return NextResponse.json({ error: 'Production id is required.' }, { status: 400 })
  if (typeof body.script === 'string' && Buffer.byteLength(body.script, 'utf8') > MAX_SCRIPT) return NextResponse.json({ error: 'Screenplay exceeds the 2 MB limit.' }, { status: 413 })
  const existing = await prisma.filmProduction.findFirst({ where: { id: body.id, userId: auth.session.user.id }, select: { id: true, projectId: true } })
  if (!existing) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const data: Record<string, unknown> = { revision: { increment: 1 } }
  if (typeof body.title === 'string') data.title = body.title.trim().slice(0, 191)
  if (typeof body.format === 'string') data.format = body.format.slice(0, 64)
  if (typeof body.genre === 'string') data.genre = body.genre.slice(0, 191)
  if (typeof body.script === 'string') data.screenplay = body.script
  if (Array.isArray(body.scenes)) data.scenes = body.scenes
  if (body.settings && typeof body.settings === 'object') data.settings = body.settings
  const production = await prisma.$transaction(async (tx) => {
    const updated = await tx.filmProduction.update({ where: { id: existing.id }, data: data as never })
    if (typeof body.title === 'string') await tx.project.update({ where: { id: existing.projectId }, data: { name: body.title.trim().slice(0, 191) } })
    return updated
  })
  return NextResponse.json({ production })
}
