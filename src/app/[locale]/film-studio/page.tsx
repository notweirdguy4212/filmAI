import type { Metadata } from 'next'
import FilmStudio from '@/features/film-studio/FilmStudio'

export const metadata: Metadata = {
  title: 'filmAI Studio — AI Film Production',
  description: 'A cinematic AI filmmaking workspace for screenplays, scene generation and production planning.',
}

export default function FilmStudioPage() {
  return <FilmStudio />
}
