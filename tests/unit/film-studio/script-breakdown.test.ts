import { describe, expect, it } from 'vitest'
import { splitScreenplayIntoScenes } from '@/features/film-studio/script-breakdown'

describe('splitScreenplayIntoScenes', () => {
  it('creates one scene per conventional INT/EXT heading and keeps its action', () => {
    const scenes = splitScreenplayIntoScenes('FADE IN:\n\nEXT. PIER — DAWN\nMara arrives.\n\nINT. LIGHTHOUSE — NIGHT\nA radio crackles.')
    expect(scenes).toHaveLength(2)
    expect(scenes[0]).toMatchObject({ title: 'PIER — DAWN', text: 'Mara arrives.', duration: 8, status: 'draft' })
    expect(scenes[1].title).toBe('LIGHTHOUSE — NIGHT')
  })

  it('uses separated screenplay blocks when scene headings are absent', () => {
    const scenes = splitScreenplayIntoScenes('Opening image.\n\nA new beat begins.')
    expect(scenes.map((scene) => scene.title)).toEqual(['Scene 1', 'Scene 2'])
  })

  it('returns no scenes for an empty script', () => {
    expect(splitScreenplayIntoScenes('  \n  ')).toEqual([])
  })
})

it('preserves speaker cues, parentheticals and dialogue inside scene boundaries', () => {
  const scenes = splitScreenplayIntoScenes('EXT. COASTAL ROAD — DAWN\n\nMara arrives.\n\nMARA (into the receiver)\nAnswer me.\n\nVOICE (V.O.)\nYou should not have come back.\n\nINT. LIGHTHOUSE — NIGHT\n\nThe lamp turns.')
  expect(scenes).toHaveLength(2)
  expect(scenes[0].text).toContain('MARA (into the receiver)\nAnswer me.')
  expect(scenes[0].text).toContain('VOICE (V.O.)\nYou should not have come back.')
})
