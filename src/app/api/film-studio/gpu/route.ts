import { NextResponse } from 'next/server'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { normalizeComfyGpuStats } from '@/features/film-studio/gpu-scheduler'
export const dynamic = 'force-dynamic'
export async function GET() {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const baseUrl = process.env.FILMAI_COMFYUI_URL
  if (!baseUrl) return NextResponse.json({ gpu: normalizeComfyGpuStats(null), configured: false })
  try {
    const response = await fetch(new URL('/system_stats', baseUrl), { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`ComfyUI system stats returned HTTP ${response.status}`)
    return NextResponse.json({ gpu: normalizeComfyGpuStats(await response.json()), configured: true })
  } catch (error) { return NextResponse.json({ gpu: normalizeComfyGpuStats(null), configured: true, warning: error instanceof Error ? error.message : 'GPU telemetry unavailable.' }) }
}
