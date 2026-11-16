import { describe, expect, it } from 'vitest'
import { buildFilmScenePrompt } from '@/features/film-studio/prompt-builder'

describe('buildFilmScenePrompt', () => {
  it('applies the same character and visual continuity instructions to every scene', () => {
    const result = buildFilmScenePrompt({
      title: 'Lighthouse — Night',
      description: 'Mara enters the lamp room.',
      characterBible: 'Mara has short dark hair and wears a red weather coat.',
      visualStyle: 'Cold moonlight, 35mm film texture.',
      continuityNotes: 'Continue from the previous wide shot; coat remains wet.',
      negativePrompt: 'identity drift, flicker',
    })
    expect(result.prompt).toContain('Mara has short dark hair')
    expect(result.prompt).toContain('Cold moonlight')
    expect(result.prompt).toContain('coat remains wet')
    expect(result.negativePrompt).toBe('identity drift, flicker')
  })

  it('omits empty optional context without adding placeholder text', () => {
    const result = buildFilmScenePrompt({ title: 'Scene 1', description: 'A train arrives.' })
    expect(result.prompt).toContain('A train arrives.')
    expect(result.prompt).not.toContain('undefined')
    expect(result.negativePrompt).toBe('')
  })
})

describe('dialogue and visual continuity locks', () => {
  it('keeps the named speaker, exact dialogue and background continuity explicit', () => {
    const result = buildFilmScenePrompt({ title: 'Lighthouse', description: 'Mara speaks to the radio.', locationBible: 'Same lighthouse interior, same rotating lamp and rain-streaked window.', dialogue: [{ speaker: 'MARA', text: 'Answer me.', direction: 'quietly' }], language: 'English' })
    expect(result.prompt).toContain('MARA (quietly): Answer me.')
    expect(result.prompt).toContain('only the character named')
    expect(result.prompt).toContain('background')
    expect(result.prompt).toContain('do not translate, paraphrase or invent dialogue')
  })
})
