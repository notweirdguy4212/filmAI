import { createHash } from 'node:crypto'
import { ApplicationFailure } from '@temporalio/activity'
import { prisma } from '@/lib/prisma'
import { ingestCompletedFilmJob } from '@/features/film-studio/asset-ingestion'
import type {
  FilmProductionActivities,
  FilmProductionRenderProfile,
  FilmProductionSceneInput,
  FilmProductionSceneReceipt,
  FilmProductionSceneStatus,
} from './contracts'

function fail(code: string): never {
  throw ApplicationFailure.nonRetryable(code, 'FILM_PRODUCTION_VALIDATION')
}

function findVideoOutput(outputs: unknown): boolean {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return false
  return Object.values(outputs as Record<string, { videos?: unknown[]; gifs?: unknown[] }>).some(
    (group) => [...(group?.videos ?? []), ...(group?.gifs ?? [])].length > 0,
  )
}

export async function submitFilmProductionScene(input: {
  productionId: string
  userId: string
  scene: FilmProductionSceneInput
  workflowId: string
}): Promise<FilmProductionSceneReceipt> {
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  if (!baseUrl) fail('FILM_PRODUCTION_COMFYUI_NOT_CONFIGURED')
  const production = await prisma.filmProduction.findFirst({
    where: { id: input.productionId, userId: input.userId },
    select: { id: true },
  })
  if (!production) fail('FILM_PRODUCTION_NOT_FOUND')

  const id = `filmprod_${createHash('sha256').update(`${input.workflowId}:${input.scene.sceneId}`).digest('hex').slice(0, 40)}`
  let job = await prisma.filmProductionJob.findUnique({ where: { id } })
  if (job?.providerJobId) {
    return { sceneId: input.scene.sceneId, jobId: job.id, providerJobId: job.providerJobId }
  }
  // Never blindly repeat a remote POST after an ambiguous network/Worker failure:
  // ComfyUI does not expose a provider-side idempotency key for /prompt.
  if (job?.status === 'submitting') {
    throw ApplicationFailure.nonRetryable(
      `FILM_PRODUCTION_SUBMISSION_UNCONFIRMED:${job.id}`,
      'FILM_PRODUCTION_SUBMISSION_UNCONFIRMED',
    )
  }
  if (!job) {
    job = await prisma.filmProductionJob.create({
      data: {
        id,
        productionId: input.productionId,
        userId: input.userId,
        sceneId: input.scene.sceneId,
        sceneTitle: input.scene.title.slice(0, 191),
        prompt: input.scene.prompt.slice(0, 100000),
        workflow: input.scene.workflow as never,
        scheduler: { orchestrationWorkflowId: input.workflowId } as never,
        status: 'submitting',
      },
    })
  } else {
    job = await prisma.filmProductionJob.update({
      where: { id },
      data: { status: 'submitting', failure: null, finishedAt: null, attempt: { increment: 1 } },
    })
  }

  try {
    const response = await fetch(new URL('/prompt', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: input.scene.workflow }),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    })
    const result = await response.json().catch(() => ({})) as { prompt_id?: string; error?: string }
    if (!response.ok || !result.prompt_id) {
      await prisma.filmProductionJob.update({
        where: { id },
        data: { status: 'failed', failure: result.error || `ComfyUI rejected the workflow (HTTP ${response.status}).`, finishedAt: new Date() },
      })
      throw ApplicationFailure.nonRetryable(result.error || `COMFYUI_SUBMISSION_FAILED:${response.status}`, 'COMFYUI_SUBMISSION_REJECTED')
    }
    await prisma.filmProductionJob.update({
      where: { id },
      data: { status: 'queued', providerJobId: result.prompt_id },
    })
    return { sceneId: input.scene.sceneId, jobId: id, providerJobId: result.prompt_id }
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error
    // Keep the durable row in `submitting`; retrying could duplicate a provider job
    // if ComfyUI accepted the request but the acknowledgement was lost.
    throw ApplicationFailure.nonRetryable(
      `FILM_PRODUCTION_SUBMISSION_UNCONFIRMED:${id}`,
      'FILM_PRODUCTION_SUBMISSION_UNCONFIRMED',
    )
  }
}

export async function pollFilmProductionScene(input: {
  jobId: string
  providerJobId: string
  userId: string
}): Promise<FilmProductionSceneStatus> {
  const job = await prisma.filmProductionJob.findFirst({
    where: { id: input.jobId, userId: input.userId, providerJobId: input.providerJobId },
    select: { status: true, outputs: true, failure: true },
  })
  if (!job) fail('FILM_PRODUCTION_JOB_NOT_FOUND')
  if (job.status === 'completed' || job.status === 'failed') {
    return { status: job.status, outputs: job.outputs, failure: job.failure }
  }
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  if (!baseUrl) fail('FILM_PRODUCTION_COMFYUI_NOT_CONFIGURED')
  const response = await fetch(new URL(`/history/${encodeURIComponent(input.providerJobId)}`, baseUrl), {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`COMFYUI_HISTORY_HTTP_${response.status}`)
  const history = await response.json() as Record<string, { status?: { status_str?: string; completed?: boolean }; outputs?: unknown }>
  const item = history[input.providerJobId]
  if (!item) return { status: 'queued', outputs: null, failure: null }
  const completed = item.status?.completed === true || item.status?.status_str === 'success'
  const failed = item.status?.status_str === 'error'
  const status = completed ? 'completed' : failed ? 'failed' : 'running'
  await prisma.filmProductionJob.update({
    where: { id: input.jobId },
    data: {
      status,
      progress: completed ? 100 : job.status === 'running' ? 50 : 10,
      outputs: item.outputs as never,
      failure: failed ? 'ComfyUI reported a generation error.' : null,
      ...(status === 'running' && job.status !== 'running' ? { startedAt: new Date() } : {}),
      ...(['completed', 'failed'].includes(status) ? { finishedAt: new Date() } : {}),
    },
  })
  return { status, outputs: item.outputs ?? null, failure: failed ? 'ComfyUI reported a generation error.' : null }
}

export async function archiveFilmProductionScene(input: {
  jobId: string
  productionId: string
  userId: string
}): Promise<void> {
  const [job, production] = await Promise.all([
    prisma.filmProductionJob.findFirst({
      where: { id: input.jobId, productionId: input.productionId, userId: input.userId, status: 'completed' },
    }),
    prisma.filmProduction.findFirst({
      where: { id: input.productionId, userId: input.userId },
      select: { projectId: true },
    }),
  ])
  if (!job || !production) fail('FILM_PRODUCTION_ARCHIVE_SCOPE_INVALID')
  await ingestCompletedFilmJob(job, production.projectId)
}

export async function enqueueFilmProductionRender(input: {
  productionId: string
  userId: string
  workflowId: string
  sceneJobs: FilmProductionSceneReceipt[]
  profile: FilmProductionRenderProfile
}): Promise<string> {
  const ids = input.sceneJobs.map((scene) => scene.jobId)
  const completed = await prisma.filmProductionJob.findMany({
    where: { id: { in: ids }, productionId: input.productionId, userId: input.userId, status: 'completed' },
    select: { id: true, outputs: true },
  })
  if (completed.length !== ids.length || completed.some((job) => !findVideoOutput(job.outputs))) {
    fail('FILM_PRODUCTION_RENDER_INPUTS_INCOMPLETE')
  }
  const production = await prisma.filmProduction.findFirst({
    where: { id: input.productionId, userId: input.userId },
    select: { id: true },
  })
  if (!production) fail('FILM_PRODUCTION_NOT_FOUND')
  const payload = {
    productionId: input.productionId,
    clips: ids.map((jobId) => ({ jobId })),
    ...(input.profile.audioJobId ? { audioJobId: input.profile.audioJobId } : {}),
    ...(input.profile.subtitles ? { subtitles: input.profile.subtitles } : {}),
    ...(input.profile.lutCube ? { lutCube: input.profile.lutCube } : {}),
    fps: input.profile.fps,
    width: input.profile.width,
    height: input.profile.height,
    grade: input.profile.grade ?? {},
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 5 * 1024 * 1024) fail('FILM_PRODUCTION_RENDER_PAYLOAD_TOO_LARGE')
  const renderJobId = `filmrender_${createHash('sha256').update(input.workflowId).digest('hex').slice(0, 40)}`
  const existing = await prisma.filmRenderJob.findUnique({ where: { id: renderJobId }, select: { id: true } })
  if (existing) return existing.id
  const job = await prisma.filmRenderJob.create({
    data: { id: renderJobId, productionId: input.productionId, userId: input.userId, payload: payload as never },
  })
  return job.id
}
