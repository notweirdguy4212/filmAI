export interface ShotListScene {
  readonly id: string
  readonly title: string
  readonly text: string
  readonly duration: number
  readonly status: string
}

function spreadsheetSafe(value: string): string {
  // Prevent spreadsheet formula execution while preserving ordinary screenplay text.
  return /^[\s]*[=+@]/.test(value) || /^[\s]*-/.test(value) ? `'${value}` : value
}

function csvCell(value: string | number): string {
  const safe = spreadsheetSafe(String(value))
  return `"${safe.replace(/"/g, '""')}"`
}

/** Export the current scene breakdown as a UTF-8 CSV suitable for production handoff. */
export function buildShotListCsv(scenes: readonly ShotListScene[]): string {
  const rows: (string | number)[][] = [
    ['Scene ID', 'Scene / Shot', 'Planned Duration (seconds)', 'Status', 'Description / Action'],
    ...scenes.map((scene, index) => [
      scene.id || `scene-${index + 1}`,
      scene.title,
      Number.isFinite(scene.duration) ? Math.max(0, scene.duration) : 0,
      scene.status,
      scene.text,
    ]),
  ]
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

/** Export a validated AI director scene/shot breakdown as spreadsheet-safe CSV. */
export function buildDirectorShotBreakdownCsv(value: unknown): string {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { scenes?: unknown }).scenes)) throw new Error('INVALID_DIRECTOR_SHOT_BREAKDOWN')
  const scenes = (value as { scenes: unknown[] }).scenes
  const rows: (string | number)[][] = [[
    'Scene Number', 'Scene Heading', 'Shot Number', 'Shot Type', 'Framing', 'Camera Movement',
    'Lens', 'Duration (seconds)', 'Visual Description', 'Generation Prompt', 'Sound Notes',
  ]]
  for (const [sceneIndex, rawScene] of scenes.entries()) {
    if (!rawScene || typeof rawScene !== 'object') continue
    const scene = rawScene as Record<string, unknown>
    if (!Array.isArray(scene.shots)) continue
    for (const [shotIndex, rawShot] of scene.shots.entries()) {
      if (!rawShot || typeof rawShot !== 'object') continue
      const shot = rawShot as Record<string, unknown>
      const cell = (key: string) => typeof shot[key] === 'string' || typeof shot[key] === 'number' ? shot[key] as string | number : ''
      rows.push([
        typeof scene.sceneNumber === 'string' || typeof scene.sceneNumber === 'number' ? scene.sceneNumber : sceneIndex + 1,
        typeof scene.heading === 'string' ? scene.heading : `Scene ${sceneIndex + 1}`,
        typeof shot.shotNumber === 'string' || typeof shot.shotNumber === 'number' ? shot.shotNumber : shotIndex + 1,
        cell('shotType'), cell('framing'), cell('cameraMovement'), cell('lens'), cell('durationSeconds'),
        cell('visualDescription'), cell('generationPrompt'), cell('soundNotes'),
      ])
    }
  }
  if (rows.length === 1) throw new Error('DIRECTOR_SHOT_BREAKDOWN_HAS_NO_SHOTS')
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}
