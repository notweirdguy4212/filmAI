export interface FilmSceneDraft {
  id: string
  title: string
  text: string
  duration: number
  status: 'draft'
}

const SCENE_HEADING = /^(INT\.|EXT\.|INT\/EXT\.|SCENE\s+\d+)/i

/** Split a screenplay by scene-heading lines, retaining action, character cues and dialogue verbatim. */
export function splitScreenplayIntoScenes(script: string): FilmSceneDraft[] {
  const lines = script.replace(/\r\n?/g, '\n').split('\n')
  const headings: number[] = []
  for (let index = 0; index < lines.length; index += 1) if (SCENE_HEADING.test(lines[index].trim())) headings.push(index)
  if (headings.length) {
    return headings.map((lineIndex, index) => {
      const end = headings[index + 1] ?? lines.length
      const heading = lines[lineIndex].trim()
      const title = heading.replace(/^(INT\.|EXT\.|INT\/EXT\.|SCENE\s+\d+\s*[-—:]?)/i, '').trim()
      return { id: `scene-${index + 1}`, title: title || `Scene ${index + 1}`, text: lines.slice(lineIndex + 1, end).join('\n').trim(), duration: 8, status: 'draft' }
    })
  }
  const blocks = script.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)
  return blocks.filter((part) => !/^(FADE IN|FADE OUT|CUT TO|THE END)\s*:?$/i.test(part)).map((part, index) => ({ id: `scene-${index + 1}`, title: `Scene ${index + 1}`, text: part, duration: 8, status: 'draft' }))
}
