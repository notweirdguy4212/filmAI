import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { getObjectBuffer } from '@/lib/storage'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024

type Node = { inputs?: Record<string, unknown> }
async function uploadToComfy(baseUrl: string, path: string, bytes: Buffer, filename: string, mimeType: string) {
  if (!path.startsWith('/upload/') || path.includes('..')) throw new Error('Upload endpoint must be a safe ComfyUI /upload/ path.')
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename)
  form.append('type', 'input')
  form.append('overwrite', 'true')
  const response = await fetch(new URL(path, baseUrl), { method: 'POST', body: form, cache: 'no-store', signal: AbortSignal.timeout(120000) })
  const result = await response.json().catch(() => ({})) as { name?: string; subfolder?: string; error?: string }
  if (!response.ok || !result.name) throw new Error(result.error || `ComfyUI media upload failed (HTTP ${response.status}). Check that the selected custom nodes accept this media type.`)
  return result
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  if (!baseUrl) return NextResponse.json({ error: 'ComfyUI is not configured.' }, { status: 503 })
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_WORKFLOW_BYTES) return NextResponse.json({ error: 'Workflow exceeds 2 MB.' }, { status: 413 })
  let body: { productionId?: string; sceneId?: string; sceneTitle?: string; speaker?: string; dialogue?: string; workflow?: Record<string, Node>; videoAssetId?: string; audioAssetId?: string; videoNodeId?: string; videoInput?: string; audioNodeId?: string; audioInput?: string; promptNodeId?: string; promptInput?: string; videoUploadPath?: string; audioUploadPath?: string }
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 }) }
  if (!body.productionId || !body.sceneId || !body.speaker?.trim() || !body.dialogue?.trim() || !body.workflow || !body.videoAssetId || !body.audioAssetId || !body.videoNodeId || !body.audioNodeId) return NextResponse.json({ error: 'Production, scene, speaker, exact dialogue, source video/audio assets, workflow and loader node IDs are required.' }, { status: 400 })
  const production = await prisma.filmProduction.findFirst({ where: { id: body.productionId, userId: auth.session.user.id }, select: { id: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const [video, audio] = await Promise.all([
    prisma.filmAsset.findFirst({ where: { id: body.videoAssetId, productionId: production.id, userId: auth.session.user.id, kind: 'video' } }),
    prisma.filmAsset.findFirst({ where: { id: body.audioAssetId, productionId: production.id, userId: auth.session.user.id, kind: 'audio' } }),
  ])
  if (!video || !audio) return NextResponse.json({ error: 'Source video and dialogue audio must be permanent assets in this production.' }, { status: 404 })
  if (Buffer.byteLength(JSON.stringify(body.workflow), 'utf8') > MAX_WORKFLOW_BYTES) return NextResponse.json({ error: 'Workflow exceeds 2 MB.' }, { status: 413 })
  const workflow = structuredClone(body.workflow)
  const videoNode = workflow[body.videoNodeId]
  const audioNode = workflow[body.audioNodeId]
  if (!videoNode?.inputs || !audioNode?.inputs) return NextResponse.json({ error: 'Configured video/audio loader node IDs were not found in the workflow.' }, { status: 400 })
  try {
    const [videoBytes, audioBytes] = await Promise.all([getObjectBuffer(video.storageKey), getObjectBuffer(audio.storageKey)])
    const [uploadedVideo, uploadedAudio] = await Promise.all([
      uploadToComfy(baseUrl, body.videoUploadPath ?? '/upload/image', videoBytes, video.filename, video.mimeType),
      uploadToComfy(baseUrl, body.audioUploadPath ?? '/upload/image', audioBytes, audio.filename, audio.mimeType),
    ])
    videoNode.inputs[body.videoInput || 'video'] = uploadedVideo.subfolder ? `${uploadedVideo.subfolder}/${uploadedVideo.name}` : uploadedVideo.name
    audioNode.inputs[body.audioInput || 'audio'] = uploadedAudio.subfolder ? `${uploadedAudio.subfolder}/${uploadedAudio.name}` : uploadedAudio.name
    const exactDirection = `LIP-SYNC CHARACTER LOCK: ${body.speaker}. Only ${body.speaker} speaks. Preserve the source video identity, face, hairstyle, costume, body proportions, scene background, lighting, camera, framing and every non-speaking character exactly. Sync mouth motion to this exact dialogue without rewriting, adding or omitting words: “${body.dialogue.trim()}”. No other character speaks. Natural restrained facial performance.`
    if (body.promptNodeId) {
      const promptNode = workflow[body.promptNodeId]
      if (!promptNode?.inputs) return NextResponse.json({ error: 'Configured prompt node was not found.' }, { status: 400 })
      promptNode.inputs[body.promptInput || 'text'] = exactDirection
    }
    const job = await prisma.filmProductionJob.create({ data: { productionId: production.id, userId: auth.session.user.id, sceneId: body.sceneId.slice(0, 191), sceneTitle: `${body.sceneTitle ?? body.sceneId} — ${body.speaker} lip-sync`.slice(0, 191), provider: 'comfyui', prompt: exactDirection, workflow: workflow as never, status: 'submitting', scheduler: { kind: 'lip-sync', sourceVideoAssetId: video.id, sourceAudioAssetId: audio.id, speaker: body.speaker } as never } })
    const response = await fetch(new URL('/prompt', baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow }), signal: AbortSignal.timeout(15000), cache: 'no-store' })
    const result = await response.json().catch(() => ({})) as { prompt_id?: string; error?: string; node_errors?: unknown }
    if (!response.ok || !result.prompt_id) {
      await prisma.filmProductionJob.update({ where: { id: job.id }, data: { status: 'failed', failure: result.error || `ComfyUI rejected the lip-sync workflow (HTTP ${response.status}).`, finishedAt: new Date() } })
      return NextResponse.json({ error: result.error || 'ComfyUI rejected the lip-sync workflow.', details: result.node_errors }, { status: 502 })
    }
    await prisma.filmProductionJob.update({ where: { id: job.id }, data: { providerJobId: result.prompt_id, status: 'queued' } })
    return NextResponse.json({ jobId: job.id, prompt_id: result.prompt_id, speaker: body.speaker }, { status: 202 })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not bind lip-sync media.' }, { status: 502 }) }
}
