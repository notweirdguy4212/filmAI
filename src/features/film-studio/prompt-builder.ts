export interface FilmPromptContext {
  readonly title: string
  readonly description: string
  readonly characterBible?: string
  readonly visualStyle?: string
  readonly continuityNotes?: string
  readonly negativePrompt?: string
  readonly shotType?: string
  readonly cameraMovement?: string
  readonly aspectRatio?: string
  readonly locationBible?: string
  readonly voiceBible?: string
  readonly dialogue?: readonly { speaker: string; text: string; direction?: string }[]
  readonly language?: string
  readonly characterReferenceAssetIds?: readonly string[]
  readonly locationReferenceAssetIds?: readonly string[]
  readonly styleReferenceAssetIds?: readonly string[]
  readonly previousSceneSummary?: string
}

/** Build a repeatable scene prompt with a stable continuity block shared by every shot. */
export function buildFilmScenePrompt(context: FilmPromptContext): { prompt: string; negativePrompt: string } {
  const sections = [
    context.title.trim(),
    context.description.trim(),
    context.characterBible?.trim() ? `CHARACTER CONTINUITY (preserve identity, wardrobe, age, proportions and distinguishing features): ${context.characterBible.trim()}` : '',
    context.visualStyle?.trim() ? `FILM VISUAL BIBLE (must remain unchanged between scenes): ${context.visualStyle.trim()}` : '',
    context.characterReferenceAssetIds?.length ? `APPROVED CHARACTER REFERENCE ASSETS (use these exact visual identities for the named cast): ${[...new Set(context.characterReferenceAssetIds)].join(', ')}` : '',
    context.locationReferenceAssetIds?.length ? `APPROVED LOCATION REFERENCE ASSETS (preserve these set layouts and spatial details): ${[...new Set(context.locationReferenceAssetIds)].join(', ')}` : '',
    context.styleReferenceAssetIds?.length ? `APPROVED STYLE REFERENCE ASSETS (match palette, lighting, lens language and material treatment): ${[...new Set(context.styleReferenceAssetIds)].join(', ')}` : '',
    context.locationBible?.trim() ? `LOCATION / BACKGROUND CONTINUITY BIBLE (preserve geography, architecture, set dressing, weather, time of day, lighting direction, props and background extras): ${context.locationBible.trim()}` : '',
    context.voiceBible?.trim() ? `CHARACTER VOICE BIBLE (keep each named character's voice identity, accent, pitch range, timbre, cadence and delivery consistent; never transfer a voice to another role): ${context.voiceBible.trim()}` : '',
    context.dialogue?.length ? `CAST AND PERFORMANCE LOCK (each line must be spoken by the named character only; never swap, merge, rename or reassign speakers; preserve each character’s established voice, accent, age impression and emotional state):\n${context.dialogue.map((line) => `${line.speaker}${line.direction ? ` (${line.direction})` : ''}: ${line.text}`).join('\n')}` : '',
    context.language?.trim() ? `DIALOGUE LANGUAGE: Speak naturally and clearly in ${context.language.trim()}; do not translate, paraphrase or invent dialogue.` : '',
    context.previousSceneSummary?.trim() ? `PREVIOUS SCENE HANDOFF (maintain narrative and visual continuity): ${context.previousSceneSummary.trim()}` : '',
    context.continuityNotes?.trim() ? `SHOT CONTINUITY: ${context.continuityNotes.trim()}` : '',
    context.shotType?.trim() ? `SHOT TYPE: ${context.shotType.trim()}` : '',
    context.cameraMovement?.trim() ? `CAMERA: ${context.cameraMovement.trim()}` : '',
    context.aspectRatio?.trim() ? `FRAME: ${context.aspectRatio.trim()}` : '',
    'Cinematic composition, coherent screen direction, physically plausible motion, consistent lighting and production-quality detail.',
    'CONTINUITY HARD LOCK: same cast identity, facial features, hair, costume, body proportions, location layout, set dressing, background, weather and time-of-day continuity as the approved reference assets. No unrequested changes.',
    'DIALOGUE HARD LOCK: only the character named in each screenplay cue may speak that line. Background characters remain silent unless explicitly scripted. No off-screen narrator unless explicitly scripted. Accurate lip movement must match the exact supplied words and speaker.',
  ].filter(Boolean)
  return { prompt: sections.join('\n\n'), negativePrompt: context.negativePrompt?.trim() ?? '' }
}
