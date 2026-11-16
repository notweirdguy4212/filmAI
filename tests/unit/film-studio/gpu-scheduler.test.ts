import { describe, expect, it } from 'vitest'
import { normalizeComfyGpuStats } from '@/features/film-studio/gpu-scheduler'

describe('ComfyUI GPU scheduling', () => {
  it('uses a conservative single slot when telemetry is missing', () => {
    expect(normalizeComfyGpuStats(null)).toMatchObject({ available: false, recommendedConcurrentJobs: 1 })
  })
  it('scales recommended concurrency using free VRAM telemetry', () => {
    expect(normalizeComfyGpuStats({ devices: [{ name: 'GPU A', type: 'cuda', vram_total: 48 * 1024 ** 3, vram_free: 26 * 1024 ** 3 }] })).toMatchObject({ available: true, recommendedConcurrentJobs: 3 })
  })
})
