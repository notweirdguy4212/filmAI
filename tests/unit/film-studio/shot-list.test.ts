import { describe, expect, it } from 'vitest'
import { buildShotListCsv } from '@/features/film-studio/shot-list'

describe('buildShotListCsv', () => {
  it('exports a UTF-8 CSV with headers, quoted fields, and CRLF rows', () => {
    const csv = buildShotListCsv([{ id: 'scene-1', title: 'Pier, dawn', text: 'Mara says "hello".', duration: 8, status: 'draft' }])
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
    expect(csv).toContain('"Scene ID","Scene / Shot","Planned Duration (seconds)","Status","Description / Action"\r\n')
    expect(csv).toContain('"scene-1","Pier, dawn","8","draft","Mara says ""hello""."')
  })

  it('protects spreadsheet cells from formula injection', () => {
    const csv = buildShotListCsv([{ id: 'scene-1', title: '=HYPERLINK("https://bad")', text: '  +SUM(A1:A2)', duration: 4, status: 'draft' }])
    expect(csv).toContain("\"'=HYPERLINK(\"\"https://bad\"\")\"")
    expect(csv).toContain("\"'  +SUM(A1:A2)\"")
  })

  it('handles an empty scene list and invalid durations safely', () => {
    const csv = buildShotListCsv([])
    expect(csv.split('\r\n')).toHaveLength(2)
    expect(buildShotListCsv([{ id: '', title: 'Untitled', text: '', duration: Number.NaN, status: 'draft' }])).toContain('"scene-1","Untitled","0"')
  })
})

describe('buildDirectorShotBreakdownCsv', () => {
  it('exports structured director shots with camera and generation details', async () => {
    const { buildDirectorShotBreakdownCsv } = await import('@/features/film-studio/shot-list')
    const csv = buildDirectorShotBreakdownCsv({ scenes: [{ sceneNumber: 1, heading: 'EXT. PIER — DAWN', shots: [{ shotNumber: 1, shotType: 'Establishing', framing: 'Wide', cameraMovement: 'Slow dolly', lens: '24mm', durationSeconds: 5, visualDescription: 'A foggy pier', generationPrompt: 'Cinematic foggy pier', soundNotes: 'Distant gulls' }] }] })
    expect(csv).toContain('"Scene Number","Scene Heading","Shot Number"')
    expect(csv).toContain('"1","EXT. PIER — DAWN","1","Establishing","Wide","Slow dolly","24mm","5"')
    expect(csv).toContain('"Cinematic foggy pier","Distant gulls"')
  })

  it('rejects malformed or empty shot plans', async () => {
    const { buildDirectorShotBreakdownCsv } = await import('@/features/film-studio/shot-list')
    expect(() => buildDirectorShotBreakdownCsv({})).toThrow('INVALID_DIRECTOR_SHOT_BREAKDOWN')
    expect(() => buildDirectorShotBreakdownCsv({ scenes: [] })).toThrow('DIRECTOR_SHOT_BREAKDOWN_HAS_NO_SHOTS')
  })
})
