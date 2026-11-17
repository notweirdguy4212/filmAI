import { NextRequest, NextResponse } from 'next/server'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { prisma } from '@/lib/prisma'
import { executeLlmCompletion } from '@/lib/ai-exec/engine'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120

const MAX_TEXT_BYTES = 128 * 1024
const MODES = new Set(['screenplay', 'story-director', 'shot-breakdown', 'production-plan'])

function parseJsonOutput(value: string): unknown | null {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(trimmed) as unknown } catch { return null }
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth

  const body = await request.json().catch(() => null) as {
    productionId?: string
    model?: string
    mode?: string
    brief?: string
    screenplay?: string
    title?: string
    genre?: string
    format?: string
    visualStyle?: string
    characterBible?: string
    locationBible?: string
  } | null

  if (!body || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 240 || !body.mode || !MODES.has(body.mode)) {
    return NextResponse.json({ error: 'Choose a configured text model and a supported director mode.' }, { status: 400 })
  }
  const optionalText = [body.brief, body.screenplay, body.title, body.genre, body.format, body.visualStyle, body.characterBible, body.locationBible]
  if (optionalText.some((value) => value !== undefined && typeof value !== 'string')) {
    return NextResponse.json({ error: 'Director context fields must be text.' }, { status: 400 })
  }
  const combinedText = [body.brief, body.screenplay, body.visualStyle, body.characterBible, body.locationBible].filter(Boolean).join('\n')
  if (Buffer.byteLength(combinedText, 'utf8') > MAX_TEXT_BYTES) return NextResponse.json({ error: 'Director input exceeds the 128 KB limit.' }, { status: 413 })

  let productionProjectId: string | undefined
  if (body.productionId) {
    const production = await prisma.filmProduction.findFirst({
      where: { id: body.productionId, userId: auth.session.user.id },
      select: { id: true, projectId: true },
    })
    if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
    productionProjectId = production.projectId
  }

  const modeInstructions: Record<string, string> = {
    screenplay: 'Write a polished, production-ready screenplay. Use standard screenplay formatting, clear INT./EXT. scene headings, visual action, playable dialogue, economical description, and a satisfying dramatic arc. Return screenplay text only; do not wrap it in markdown fences.',
    'story-director': 'Act as an experienced film story director and development executive. Return valid JSON only with keys: title, logline, synopsis, directorVision, tone, visualMotifs (array), characters (array of {name, description, arc}), locations (array of {name, description, continuityRules}), storyBeats (array of {beat, purpose}), screenplay. Keep all details coherent and preserve supplied constraints.',
    'shot-breakdown': 'Break the screenplay into a production-ready shot plan. Return valid JSON only with keys: scenes (array of {sceneNumber, heading, purpose, continuityNotes, shots}). Each shot must contain {shotNumber, shotType, framing, cameraMovement, lens, durationSeconds, visualDescription, generationPrompt, soundNotes}. Cover every scene, vary shot sizes purposefully, maintain screen direction and avoid impossible coverage. Include establishing, performance, inserts and transitions only where motivated.',
    'production-plan': 'Create a practical end-to-end production plan. Return valid JSON only with keys: phases (array of {name, objective, tasks}), sceneSchedule (array of {sceneHeading, priority, estimatedComplexity, requiredAssets, generationNotes}), continuityRisks (array), audioPlan (array), finishingChecklist (array), deliveryProfiles (array). Include dependencies and review gates; do not claim external jobs have been submitted.',
  }
  const context = [
    `PROJECT: ${body.title?.slice(0, 191) || 'Untitled production'}`,
    `FORMAT: ${body.format?.slice(0, 64) || 'Short film'}`,
    `GENRE: ${body.genre?.slice(0, 191) || 'Unspecified'}`,
    body.brief ? `CREATIVE BRIEF:\n${body.brief}` : '',
    body.screenplay ? `EXISTING SCREENPLAY:\n${body.screenplay}` : '',
    body.visualStyle ? `VISUAL STYLE BIBLE:\n${body.visualStyle}` : '',
    body.characterBible ? `CHARACTER BIBLE:\n${body.characterBible}` : '',
    body.locationBible ? `LOCATION BIBLE:\n${body.locationBible}` : '',
  ].filter(Boolean).join('\n\n')

  try {
    const result = await executeLlmCompletion({
      userId: auth.session.user.id,
      model: body.model.trim(),
      messages: [
        { role: 'system', content: `You are filmAI Studio's senior screenwriter, story director and production planner. Be specific, cinematic and practical. Respect user-provided story facts and continuity constraints. Never claim to have generated media or executed production tasks. ${modeInstructions[body.mode]}` },
        { role: 'user', content: context || 'Develop an original short-film concept with a clear emotional arc.' },
      ],
      options: { ...(productionProjectId ? { projectId: productionProjectId } : {}), action: `film_studio_${body.mode}`, reasoning: false },
    })
    const text = result.text?.trim()
    if (!text) return NextResponse.json({ error: 'The selected model returned an empty response. Try another configured model.' }, { status: 502 })
    return NextResponse.json({ mode: body.mode, text, structured: body.mode === 'screenplay' ? null : parseJsonOutput(text), provider: result.provider, model: result.modelId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Film director generation failed.'
    const status = /MODEL_NOT_CONFIGURED|not configured|未配置/i.test(message) ? 409 : 502
    return NextResponse.json({ error: status === 409 ? 'No matching configured text model was found. Enter a model key available in your account model settings.' : message.slice(0, 700) }, { status })
  }
}
