import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { normalizeComfyGpuStats } from '@/features/film-studio/gpu-scheduler'
import { ingestCompletedFilmJob } from '@/features/film-studio/asset-ingestion'
import { getObjectBuffer } from '@/lib/storage'

export const dynamic = 'force-dynamic'
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024

type HistoryItem = { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, unknown> }
type ReferenceBinding = { assetId: string; nodeId: string; input?: string }

async function uploadReferenceImage(baseUrl: string, bytes: Buffer, filename: string, mimeType: string) {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename)
  form.append('type', 'input')
  form.append('overwrite', 'true')
  const response = await fetch(new URL('/upload/image', baseUrl), { method: 'POST', body: form, cache: 'no-store', signal: AbortSignal.timeout(120000) })
  const result = await response.json().catch(() => ({})) as { name?: string; subfolder?: string; error?: string }
  if (!response.ok || !result.name) throw new Error(result.error || `ComfyUI reference-image upload failed (HTTP ${response.status}).`)
  return result
}

export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const productionId = request.nextUrl.searchParams.get('productionId')
  if (productionId) {
    const production = await prisma.filmProduction.findFirst({ where: { id: productionId, userId: auth.session.user.id }, select: { id: true, projectId: true } })
    if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
    const jobs = await prisma.filmProductionJob.findMany({ where: { productionId, userId: auth.session.user.id }, orderBy: { createdAt: 'desc' }, take: 200 })
    const baseUrl = process.env.FILMAI_COMFYUI_URL
    if (baseUrl) {
      await Promise.all(jobs.filter((job) => job.providerJobId && ['submitting', 'queued', 'running'].includes(job.status)).slice(0, 16).map(async (job) => {
        try {
          const response = await fetch(new URL(`/history/${encodeURIComponent(job.providerJobId!)}`, baseUrl), { signal: AbortSignal.timeout(5000), cache: 'no-store' })
          if (!response.ok) return
          const history = await response.json() as Record<string, HistoryItem>
          const item = history[job.providerJobId!]
          if (!item) return
          const status = item.status?.completed || item.status?.status_str === 'success' ? 'completed' : item.status?.status_str === 'error' ? 'failed' : 'running'
          await prisma.filmProductionJob.update({ where: { id: job.id }, data: { status, progress: status === 'completed' ? 100 : job.progress, outputs: item.outputs as never, failure: status === 'failed' ? 'ComfyUI reported a generation error.' : null, ...(status === 'running' && !job.startedAt ? { startedAt: new Date() } : {}), ...(['completed', 'failed'].includes(status) ? { finishedAt: new Date() } : {}) } })
        } catch { /* retain the last durable state if provider history is temporarily unavailable */ }
      }))
    }
    const refreshedJobs = await prisma.filmProductionJob.findMany({ where: { productionId, userId: auth.session.user.id }, orderBy: { createdAt: 'desc' }, take: 200 })
    let assetsImported = 0
    const ingestionCandidates = await prisma.filmProductionJob.findMany({ where: { productionId, userId: auth.session.user.id, status: 'completed' }, orderBy: { updatedAt: 'asc' }, take: 200 })
    for (const completedJob of ingestionCandidates.slice(0, 8)) {
      try { assetsImported += await ingestCompletedFilmJob(completedJob, production.projectId) } catch { /* provider/storage failures do not change the completed generation job */ }
      await prisma.filmProductionJob.update({ where: { id: completedJob.id }, data: { updatedAt: new Date() } }).catch(() => undefined)
    }
    return NextResponse.json({ jobs: refreshedJobs, assetsImported })
  }
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  const promptId = request.nextUrl.searchParams.get('promptId')
  if (!baseUrl) return NextResponse.json({ error: 'ComfyUI is not configured.' }, { status: 503 })
  if (!promptId || !/^[a-zA-Z0-9-]{8,128}$/.test(promptId)) return NextResponse.json({ error: 'A valid promptId is required.' }, { status: 400 })
  try {
    const response = await fetch(new URL(`/history/${encodeURIComponent(promptId)}`, baseUrl), { signal: AbortSignal.timeout(8000), cache: 'no-store' })
    if (!response.ok) return NextResponse.json({ error: `ComfyUI history returned HTTP ${response.status}.` }, { status: 502 })
    const history = await response.json() as Record<string, HistoryItem>
    const item = history[promptId]
    const status = item?.status?.completed || item?.status?.status_str === 'success' ? 'completed' : item?.status?.status_str === 'error' ? 'failed' : item ? 'running' : 'queued'
    await prisma.filmProductionJob.updateMany({ where: { userId: auth.session.user.id, providerJobId: promptId }, data: { status, progress: status === 'completed' ? 100 : undefined, outputs: item?.outputs as never, failure: status === 'failed' ? 'ComfyUI reported a generation error.' : null, finishedAt: ['completed', 'failed'].includes(status) ? new Date() : null } })
    return NextResponse.json({ prompt_id: promptId, found: Boolean(item), status: item?.status ?? null, outputs: item?.outputs ?? null })
  } catch {
    return NextResponse.json({ error: 'Could not read job history from ComfyUI.' }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  if (!baseUrl) return NextResponse.json({ error: 'ComfyUI is not configured. Set FILMAI_COMFYUI_URL on the application host.' }, { status: 503 })
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_WORKFLOW_BYTES) return NextResponse.json({ error: 'Workflow exceeds the 2 MB request limit.' }, { status: 413 })
  let body: unknown
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 }) }
  if (!body || typeof body !== 'object' || !('workflow' in body)) return NextResponse.json({ error: 'A workflow object is required.' }, { status: 400 })
  const data = body as { workflow: unknown; productionId?: string; sceneId?: string; sceneTitle?: string; prompt?: string; referenceImages?: ReferenceBinding[] }
  if (!data.workflow || typeof data.workflow !== 'object' || Array.isArray(data.workflow)) return NextResponse.json({ error: 'Workflow must be a ComfyUI API-format object.' }, { status: 400 })
  if (!data.productionId || !data.sceneId || !data.sceneTitle) return NextResponse.json({ error: 'Production and scene identifiers are required for durable queueing.' }, { status: 400 })
  const production = await prisma.filmProduction.findFirst({ where: { id: data.productionId, userId: auth.session.user.id }, select: { id: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  if (data.referenceImages !== undefined && (!Array.isArray(data.referenceImages) || data.referenceImages.length > 20 || data.referenceImages.some((binding) => !binding || typeof binding.assetId !== 'string' || !binding.assetId || typeof binding.nodeId !== 'string' || !binding.nodeId || binding.nodeId.length > 128 || (binding.input !== undefined && (typeof binding.input !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(binding.input)))))) return NextResponse.json({ error: 'Reference bindings must contain up to 20 image asset/node/input mappings.' }, { status: 400 })
  const workflow = structuredClone(data.workflow) as Record<string, { inputs?: Record<string, unknown> }>
  if (data.referenceImages?.length) {
    const bindings = data.referenceImages
    const bindingKeys = bindings.map((binding) => `${binding.nodeId}:${binding.input || 'image'}`)
    if (new Set(bindingKeys).size !== bindingKeys.length) return NextResponse.json({ error: 'Each reference image must map to a unique workflow node/input pair.' }, { status: 400 })
    const ids = [...new Set(bindings.map((binding) => binding.assetId))]
    const referenceAssets = await prisma.filmAsset.findMany({ where: { id: { in: ids }, productionId: production.id, userId: auth.session.user.id, kind: 'image' } })
    if (referenceAssets.length !== ids.length) return NextResponse.json({ error: 'Every reference image must be an image asset owned by this production.' }, { status: 409 })
    const byId = new Map<string, (typeof referenceAssets)[number]>(referenceAssets.map((asset) => [asset.id, asset] as const))
    let referenceBytesTotal = 0
    try {
      for (const binding of bindings) {
        const node = workflow[binding.nodeId]
        if (!node?.inputs) return NextResponse.json({ error: `Reference loader node ${binding.nodeId} was not found in the workflow.` }, { status: 400 })
        const asset = byId.get(binding.assetId)!
        if (asset.sizeBytes > BigInt(20 * 1024 * 1024)) throw new Error(`Reference image ${asset.filename} exceeds the 20 MB per-image limit.`)
        const bytes = await getObjectBuffer(asset.storageKey)
        referenceBytesTotal += bytes.length
        if (!bytes.length || referenceBytesTotal > 100 * 1024 * 1024) throw new Error('Reference images are empty or exceed the 100 MB combined upload limit.')
        const uploaded = await uploadReferenceImage(baseUrl, bytes, asset.filename, asset.mimeType)
        node.inputs[binding.input || 'image'] = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
      }
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not bind reference images to the ComfyUI workflow.' }, { status: 502 })
    }
  }
  if (Buffer.byteLength(JSON.stringify(workflow), 'utf8') > MAX_WORKFLOW_BYTES) return NextResponse.json({ error: 'Workflow with reference bindings exceeds 2 MB.' }, { status: 413 })
  let scheduler = normalizeComfyGpuStats(null)
  try {
    const statsResponse = await fetch(new URL('/system_stats', baseUrl), { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    if (statsResponse.ok) scheduler = normalizeComfyGpuStats(await statsResponse.json())
  } catch { /* safe single-slot fallback when provider telemetry is unavailable */ }
  const activeJobs = await prisma.filmProductionJob.count({ where: { productionId: production.id, userId: auth.session.user.id, status: { in: ['submitting', 'queued', 'running'] } } })
  if (activeJobs >= scheduler.recommendedConcurrentJobs) return NextResponse.json({ error: `GPU-aware back-pressure: ${activeJobs} generation job(s) are already active. Current safe concurrency is ${scheduler.recommendedConcurrentJobs}. Refresh the queue and retry when a slot is free.`, scheduler }, { status: 429 })
  const job = await prisma.filmProductionJob.create({ data: { productionId: production.id, userId: auth.session.user.id, sceneId: data.sceneId.slice(0, 191), sceneTitle: data.sceneTitle.slice(0, 191), prompt: (data.prompt ?? data.sceneTitle).slice(0, 100000), workflow: workflow as never, scheduler: { ...scheduler, referenceImageAssetIds: data.referenceImages?.map((binding) => binding.assetId) ?? [] } as never, status: 'submitting' } })
  try {
    const response = await fetch(new URL('/prompt', baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow }), signal: AbortSignal.timeout(15000), cache: 'no-store' })
    const result = await response.json().catch(() => ({})) as { prompt_id?: string; error?: string; node_errors?: unknown }
    if (!response.ok || !result.prompt_id) {
      await prisma.filmProductionJob.update({ where: { id: job.id }, data: { status: 'failed', failure: result.error || `ComfyUI rejected the workflow (HTTP ${response.status}).`, finishedAt: new Date() } })
      return NextResponse.json({ error: result.error || `ComfyUI rejected the workflow (HTTP ${response.status}).`, details: result.node_errors, jobId: job.id }, { status: 502 })
    }
    await prisma.filmProductionJob.update({ where: { id: job.id }, data: { status: 'queued', providerJobId: result.prompt_id } })
    return NextResponse.json({ prompt_id: result.prompt_id, jobId: job.id }, { status: 202 })
  } catch {
    await prisma.filmProductionJob.update({ where: { id: job.id }, data: { status: 'failed', failure: 'Could not submit the workflow to ComfyUI.', finishedAt: new Date() } })
    return NextResponse.json({ error: 'Could not submit the workflow to ComfyUI. Check the server URL and network access.', jobId: job.id }, { status: 502 })
  }
}
