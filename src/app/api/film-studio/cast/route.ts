import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { getSignedUrl } from '@/lib/storage'
import { extractDialogueLines } from '@/features/film-studio/production-toolkit'
import { assignVoicesToDialogue, propagateSceneReferences, type CharacterVoiceAssignment, type SceneReferenceState } from '@/features/film-studio/production-pipeline'

export const dynamic = 'force-dynamic'

type CastMember = CharacterVoiceAssignment & { referenceAssetIds: string[] }
type FilmBible = { cast: CastMember[]; sceneReferences: SceneReferenceState[] }

function readBible(settings: unknown): FilmBible {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { cast: [], sceneReferences: [] }
  const value = (settings as Record<string, unknown>).filmBible
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { cast: [], sceneReferences: [] }
  const bible = value as Partial<FilmBible>
  return { cast: Array.isArray(bible.cast) ? bible.cast : [], sceneReferences: Array.isArray(bible.sceneReferences) ? bible.sceneReferences : [] }
}

export async function GET(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const productionId = request.nextUrl.searchParams.get('productionId')
  if (!productionId) return NextResponse.json({ error: 'productionId is required.' }, { status: 400 })
  const production = await prisma.filmProduction.findFirst({ where: { id: productionId, userId: auth.session.user.id }, select: { id: true, screenplay: true, settings: true, revision: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  const bible = readBible(production.settings)
  const assetIds = [...new Set(bible.cast.flatMap((member) => member.referenceAssetIds ?? []))]
  const assets = assetIds.length ? await prisma.filmAsset.findMany({ where: { id: { in: assetIds }, productionId, userId: auth.session.user.id, kind: 'image' }, select: { id: true, filename: true, storageKey: true } }) : []
  const assetMap = new Map<string, { id: string; filename: string; url: string }>(assets.map((asset) => [asset.id, { id: asset.id, filename: asset.filename, url: getSignedUrl(asset.storageKey, 3600) }] as const))
  const cast = bible.cast.map((member) => ({ ...member, references: (member.referenceAssetIds ?? []).map((id) => assetMap.get(id)).filter(Boolean) }))
  const dialogue = extractDialogueLines(production.screenplay)
  return NextResponse.json({ revision: production.revision, cast, dialogue: assignVoicesToDialogue(dialogue, bible.cast), sceneReferences: bible.sceneReferences })
}

export async function PUT(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const body = await request.json().catch(() => null) as { productionId?: string; expectedRevision?: number; cast?: CastMember[]; sceneReferences?: SceneReferenceState[] } | null
  if (!body?.productionId || !Number.isInteger(body.expectedRevision) || !Array.isArray(body.cast) || !Array.isArray(body.sceneReferences)) return NextResponse.json({ error: 'productionId, expectedRevision, cast and sceneReferences are required.' }, { status: 400 })
  if (body.cast.length > 100 || body.sceneReferences.length > 500) return NextResponse.json({ error: 'Cast or scene-reference collection exceeds its limit.' }, { status: 413 })
  const production = await prisma.filmProduction.findFirst({ where: { id: body.productionId, userId: auth.session.user.id }, select: { id: true, settings: true, revision: true } })
  if (!production) return NextResponse.json({ error: 'Production not found.' }, { status: 404 })
  if (production.revision !== body.expectedRevision) return NextResponse.json({ error: 'PRODUCTION_REVISION_CONFLICT', revision: production.revision }, { status: 409 })

  const cast: CastMember[] = []
  for (const member of body.cast) {
    if (!member || typeof member.character !== 'string' || !member.character.trim() || member.character.length > 100 || typeof member.voiceId !== 'string' || !member.voiceId.trim() || member.voiceId.length > 191 || !Array.isArray(member.referenceAssetIds) || member.referenceAssetIds.length > 20) return NextResponse.json({ error: 'Each cast member requires a character name, voice ID and up to 20 image references.' }, { status: 400 })
    cast.push({ character: member.character.trim(), voiceId: member.voiceId.trim(), language: typeof member.language === 'string' ? member.language.slice(0, 32) : undefined, notes: typeof member.notes === 'string' ? member.notes.slice(0, 1000) : undefined, referenceAssetIds: [...new Set(member.referenceAssetIds.filter((id): id is string => typeof id === 'string'))] })
  }
  const characterNames = cast.map((member) => member.character.toLocaleUpperCase())
  if (new Set(characterNames).size !== characterNames.length) return NextResponse.json({ error: 'Character names must be unique (case-insensitive).' }, { status: 400 })
  const sceneInputs: SceneReferenceState[] = []
  for (const scene of body.sceneReferences) {
    if (!scene || typeof scene.sceneId !== 'string' || !scene.sceneId || scene.sceneId.length > 191 ||
      !Array.isArray(scene.characterAssetIds) || !Array.isArray(scene.locationAssetIds) || !Array.isArray(scene.styleAssetIds) ||
      [...scene.characterAssetIds, ...scene.locationAssetIds, ...scene.styleAssetIds].some((id) => typeof id !== 'string' || id.length > 191) ||
      (scene.continuitySummary !== undefined && (typeof scene.continuitySummary !== 'string' || scene.continuitySummary.length > 4000))) {
      return NextResponse.json({ error: 'Each scene reference needs a scene ID and valid character, location and style image asset ID arrays.' }, { status: 400 })
    }
    sceneInputs.push({
      sceneId: scene.sceneId,
      characterAssetIds: [...new Set(scene.characterAssetIds)],
      locationAssetIds: [...new Set(scene.locationAssetIds)],
      styleAssetIds: [...new Set(scene.styleAssetIds)],
      ...(scene.continuitySummary ? { continuitySummary: scene.continuitySummary } : {}),
      ...(scene.previousSceneId ? { previousSceneId: scene.previousSceneId } : {}),
    })
  }
  const referenceIds = [...new Set([...cast.flatMap((member) => member.referenceAssetIds), ...sceneInputs.flatMap((scene) => [...scene.characterAssetIds, ...scene.locationAssetIds, ...scene.styleAssetIds])])]
  if (referenceIds.length > 2000 || referenceIds.some((id) => typeof id !== 'string' || id.length > 191)) return NextResponse.json({ error: 'Invalid or excessive reference asset IDs.' }, { status: 400 })
  if (referenceIds.length) {
    const owned = await prisma.filmAsset.count({ where: { id: { in: referenceIds }, productionId: production.id, userId: auth.session.user.id, kind: 'image' } })
    if (owned !== referenceIds.length) return NextResponse.json({ error: 'All character, location and style references must be image assets owned by this production.' }, { status: 409 })
  }
  let propagated: SceneReferenceState[]
  try { propagated = propagateSceneReferences(sceneInputs) }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid scene reference chain.' }, { status: 400 }) }
  const settings = production.settings && typeof production.settings === 'object' && !Array.isArray(production.settings) ? production.settings as Record<string, unknown> : {}
  const updated = await prisma.filmProduction.updateMany({
    where: { id: production.id, userId: auth.session.user.id, revision: body.expectedRevision },
    data: { settings: { ...settings, filmBible: { cast, sceneReferences: propagated } } as never, revision: { increment: 1 } },
  })
  if (!updated.count) return NextResponse.json({ error: 'PRODUCTION_REVISION_CONFLICT' }, { status: 409 })
  return NextResponse.json({ revision: body.expectedRevision + 1, cast, sceneReferences: propagated })
}
