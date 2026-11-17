import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from '@temporalio/client'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { prisma } from '@/lib/prisma'
import { getTemporalClient } from '@/lib/temporal/client'
import { getTemporalRuntimeConfig } from '@/lib/temporal/config'
import { FILM_PRODUCTION_STATE_QUERY } from '@/lib/temporal/film-production/contracts'
import type {
  FilmProductionRenderProfile,
  FilmProductionSceneInput,
  FilmProductionWorkflowInput,
  FilmProductionWorkflowView,
} from '@/lib/temporal/film-production/contracts'
import { TEMPORAL_WORKFLOW } from '@/lib/temporal/workflow-registry'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_SCENES = 30
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024
const FPS = new Set([24, 25, 30, 50, 60])
const PROFILES = new Set(['1280x720', '1920x1080', '3840x2160'])

function workflowIdFor(productionId: string, requestId: string): string {
  const digest = createHash('sha256').update(`${productionId}:${requestId}`).digest('hex').slice(0, 40)
  return `film-production-${digest}`
}

function validScene(value: unknown): value is FilmProductionSceneInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const scene = value as Record<string, unknown>
  return typeof scene.sceneId === 'string' && /^[a-zA-Z0-9_-]{1,191}$/.test(scene.sceneId)
    && typeof scene.title === 'string' && scene.title.trim().length > 0 && scene.title.length <= 191
    && typeof scene.prompt === 'string' && scene.prompt.trim().length > 0 && scene.prompt.length <= 100000
    && Boolean(scene.workflow) && typeof scene.workflow === 'object' && !Array.isArray(scene.workflow)
}

function validRender(value: unknown): value is FilmProductionRenderProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const profile = value as Record<string, unknown>
  return typeof profile.fps === 'number' && FPS.has(profile.fps)
    && typeof profile.width === 'number' && typeof profile.height === 'number'
    && PROFILES.has(`${profile.width}x${profile.height}`)
    && (profile.audioJobId === undefined || typeof profile.audioJobId === 'string')
    && (profile.subtitles === undefined || typeof profile.subtitles === 'string')
    && (profile.lutCube === undefined || typeof profile.lutCube === 'string')
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await request.json().catch(() => null) as {
    productionId?: string
    requestId?: string
    scenes?: unknown[]
    render?: unknown
    pollIntervalMs?: number
    generationTimeoutMs?: number
  } | null

  if (!body || typeof body.productionId !== 'string' || typeof body.requestId !== 'string'
    || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)
    || !Array.isArray(body.scenes) || body.scenes.length < 1 || body.scenes.length > MAX_SCENES
    || !body.scenes.every(validScene)
    || (body.render !== undefined && body.render !== null && !validRender(body.render))) {
    return NextResponse.json({ error: 'Provide a production, unique requestId, 1–30 valid ComfyUI scenes, and an optional supported render profile.' }, { status: 400 })
  }
  const scenes = body.scenes as FilmProductionSceneInput[]
  if (new Set(scenes.map((scene) => scene.sceneId)).size !== scenes.length) {
    return NextResponse.json({ error: 'Scene IDs must be unique within a production command.' }, { status: 400 })
  }
  const scenePayloadBytes = Buffer.byteLength(JSON.stringify(scenes), 'utf8')
  if (scenePayloadBytes > 5 * 1024 * 1024) return NextResponse.json({ error: 'Scene instructions exceed the 5 MB command limit.' }, { status: 413 })
  const workflowBytes = scenes.reduce((total, scene) => total + Buffer.byteLength(JSON.stringify(scene.workflow), 'utf8'), 0)
  if (workflowBytes > MAX_WORKFLOW_BYTES) return NextResponse.json({ error: 'Combined ComfyUI workflows exceed the 2 MB limit.' }, { status: 413 })
  const profile = body.render as FilmProductionRenderProfile | undefined
  if (profile && (Buffer.byteLength(profile.subtitles ?? '', 'utf8') > 2 * 1024 * 1024 || Buffer.byteLength(profile.lutCube ?? '', 'utf8') > 2 * 1024 * 1024)) {
    return NextResponse.json({ error: 'Subtitle or LUT data exceeds the 2 MB limit.' }, { status: 413 })
  }
  const production = await prisma.filmProduction.findFirst({
    where: { id: body.productionId, userId: auth.session.user.id },
    select: { id: true },
  })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  if (profile?.audioJobId) {
    const audio = await prisma.filmProductionJob.findFirst({
      where: { id: profile.audioJobId, productionId: production.id, userId: auth.session.user.id, status: 'completed' },
      select: { id: true },
    })
    if (!audio) return NextResponse.json({ error: 'The selected soundtrack must be a completed job in this production.' }, { status: 409 })
  }

  const workflowId = workflowIdFor(production.id, body.requestId)
  const input: FilmProductionWorkflowInput = {
    workflowId,
    productionId: production.id,
    userId: auth.session.user.id,
    scenes,
    render: profile ?? null,
    pollIntervalMs: Math.max(2000, Math.min(30000, body.pollIntervalMs ?? 5000)),
    generationTimeoutMs: Math.max(60000, Math.min(24 * 60 * 60 * 1000, body.generationTimeoutMs ?? 2 * 60 * 60 * 1000)),
  }
  try {
    const [client, temporalConfig] = await Promise.all([getTemporalClient(), Promise.resolve(getTemporalRuntimeConfig())])
    try {
      await client.workflow.start(TEMPORAL_WORKFLOW.FILM_PRODUCTION.type, {
        workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        taskQueue: temporalConfig.taskQueue,
        args: [input],
      })
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
    }
    return NextResponse.json({ workflowId, status: 'accepted' }, { status: 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not start the Temporal production workflow.'
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 503 })
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const productionId = request.nextUrl.searchParams.get('productionId')
  const requestId = request.nextUrl.searchParams.get('requestId')
  if (!productionId || !requestId || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) {
    return NextResponse.json({ error: 'Production and request IDs are required.' }, { status: 400 })
  }
  const production = await prisma.filmProduction.findFirst({
    where: { id: productionId, userId: auth.session.user.id },
    select: { id: true },
  })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const workflowId = workflowIdFor(production.id, requestId)
  try {
    const client = await getTemporalClient()
    const handle = client.workflow.getHandle(workflowId)
    const description = await handle.describe()
    let state: FilmProductionWorkflowView | null = null
    let workflowError: string | null = null
    try {
      state = await handle.query<FilmProductionWorkflowView>(FILM_PRODUCTION_STATE_QUERY)
    } catch {
      const settled = await Promise.race([
        handle.result().then((result) => ({ result: result as FilmProductionWorkflowView, error: null as string | null }))
          .catch((error: unknown) => ({ result: null, error: error instanceof Error ? error.message.slice(0, 400) : 'Workflow failed.' })),
        new Promise<{ result: null; error: string }>((resolve) => {
          setTimeout(() => resolve({ result: null, error: 'Workflow state is initializing or unavailable; retry shortly.' }), 1500)
        }),
      ])
      state = settled.result
      workflowError = settled.error
    }
    return NextResponse.json({ workflowId, executionStatus: description.status, state, error: workflowError })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workflow status is unavailable.'
    return NextResponse.json({ error: message.slice(0, 400) }, { status: 404 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const productionId = request.nextUrl.searchParams.get('productionId')
  const requestId = request.nextUrl.searchParams.get('requestId')
  if (!productionId || !requestId || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) {
    return NextResponse.json({ error: 'Production and request IDs are required.' }, { status: 400 })
  }
  const production = await prisma.filmProduction.findFirst({
    where: { id: productionId, userId: auth.session.user.id },
    select: { id: true },
  })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  try {
    const client = await getTemporalClient()
    await client.workflow.getHandle(workflowIdFor(production.id, requestId)).cancel()
    return NextResponse.json({ status: 'cancellation_requested' }, { status: 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not request workflow cancellation.'
    return NextResponse.json({ error: message.slice(0, 400) }, { status: 409 })
  }
}
