import { NextResponse } from 'next/server'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

type EngineState = 'online' | 'offline' | 'unconfigured'

async function inspectComfy(url: string | undefined): Promise<{ state: EngineState; detail: string; nodes: string[] }> {
  if (!url) return { state: 'unconfigured', detail: 'Set FILMAI_COMFYUI_URL on the application host', nodes: [] }
  try {
    const response = await fetch(new URL('/system_stats', url), { signal: AbortSignal.timeout(3500), cache: 'no-store' })
    if (!response.ok) return { state: 'offline', detail: `ComfyUI returned HTTP ${response.status}`, nodes: [] }
    let nodes: string[] = []
    try {
      const info = await fetch(new URL('/object_info', url), { signal: AbortSignal.timeout(5000), cache: 'no-store' })
      if (info.ok) nodes = Object.keys(await info.json() as Record<string, unknown>)
    } catch { /* API is reachable even if the optional node catalogue is unavailable */ }
    return { state: 'online', detail: nodes.length ? `API online · ${nodes.length} node types discovered` : 'ComfyUI API reachable', nodes }
  } catch {
    return { state: 'offline', detail: 'Could not reach the configured ComfyUI server', nodes: [] }
  }
}

function capability(nodes: string[], patterns: RegExp[]): { state: EngineState; detail: string } {
  const matches = nodes.filter((node) => patterns.some((pattern) => pattern.test(node)))
  return matches.length
    ? { state: 'online', detail: `${matches.length} compatible node type${matches.length === 1 ? '' : 's'} detected` }
    : { state: 'unconfigured', detail: 'No matching ComfyUI nodes detected; install the relevant extension/model workflow' }
}

export async function GET() {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth
  const comfy = await inspectComfy(process.env.FILMAI_COMFYUI_URL)
  const nodes = comfy.nodes
  return NextResponse.json({ engines: [
    { id: 'comfyui', label: 'ComfyUI', state: comfy.state, detail: comfy.detail },
    { id: 'wan', label: 'Wan video', ...capability(nodes, [/WanVideo/i, /Wan.*Sampler/i]) },
    { id: 'ltx', label: 'LTX video', ...capability(nodes, [/LTX.*Video/i, /LTXV/i]) },
    { id: 'hunyuan', label: 'Hunyuan video / 3D', ...capability(nodes, [/Hunyuan/i]) },
    { id: 'audio', label: 'Audio & speech', ...capability(nodes, [/ACE.?Step/i, /Audio/i, /TTS/i, /Speech/i, /CosyVoice/i]) },
    { id: 'lip-sync', label: 'Lip sync', ...capability(nodes, [/LivePortrait/i, /Wav2Lip/i, /Lip.?Sync/i]) },
    { id: 'upscaling', label: 'Upscaling & detail', ...capability(nodes, [/Upscale/i, /ESRGAN/i, /Detailer/i]) },
  ] })
}
