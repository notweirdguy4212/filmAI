export type GpuSnapshot = { available: boolean; devices: Array<{ name: string; type: string; totalBytes: number; freeBytes: number; usedBytes: number }>; recommendedConcurrentJobs: number; reason: string }
type ComfyDevice = { name?: string; type?: string; vram_total?: number; vram_free?: number; torch_vram_total?: number; torch_vram_free?: number }

export function normalizeComfyGpuStats(raw: unknown): GpuSnapshot {
  const stats = raw && typeof raw === 'object' ? raw as { devices?: ComfyDevice[] } : {}
  const devices = (stats.devices ?? []).filter((device) => typeof device.vram_total === 'number' && typeof device.vram_free === 'number').map((device) => ({ name: device.name ?? 'GPU', type: device.type ?? 'unknown', totalBytes: Math.max(0, device.vram_total ?? 0), freeBytes: Math.max(0, device.vram_free ?? 0), usedBytes: Math.max(0, (device.vram_total ?? 0) - (device.vram_free ?? 0)) }))
  if (!devices.length) return { available: false, devices: [], recommendedConcurrentJobs: 1, reason: 'ComfyUI did not expose usable VRAM telemetry; using conservative single-job scheduling.' }
  const largestFree = Math.max(...devices.map((device) => device.freeBytes))
  const gib = largestFree / (1024 ** 3)
  const recommendedConcurrentJobs = gib >= 40 ? 4 : gib >= 24 ? 3 : gib >= 16 ? 2 : 1
  return { available: true, devices, recommendedConcurrentJobs, reason: `Capacity estimated from the largest reported free VRAM pool (${gib.toFixed(1)} GiB). Actual model requirements and ComfyUI's own queue remain authoritative.` }
}
