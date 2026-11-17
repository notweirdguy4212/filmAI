export const FILM_PRODUCTION_STATE_QUERY = 'filmProductionState'

export type FilmProductionSceneInput = {
  sceneId: string
  title: string
  prompt: string
  workflow: Record<string, unknown>
}

export type FilmProductionRenderProfile = {
  fps: number
  width: number
  height: number
  audioJobId?: string
  subtitles?: string
  lutCube?: string
  grade?: { brightness?: number; contrast?: number; saturation?: number }
}

export type FilmProductionWorkflowInput = {
  workflowId: string
  productionId: string
  userId: string
  scenes: FilmProductionSceneInput[]
  render: FilmProductionRenderProfile | null
  pollIntervalMs: number
  generationTimeoutMs: number
}

export type FilmProductionSceneReceipt = {
  sceneId: string
  jobId: string
  providerJobId: string
}

export type FilmProductionSceneStatus = {
  status: 'queued' | 'running' | 'completed' | 'failed'
  outputs: unknown
  failure: string | null
}

export type FilmProductionWorkflowView = {
  workflowId: string
  productionId: string
  status: 'starting' | 'generating' | 'render_queued' | 'completed' | 'failed'
  completedScenes: number
  totalScenes: number
  renderJobId: string | null
  sceneJobs: FilmProductionSceneReceipt[]
}

export type FilmProductionWorkflowResult = FilmProductionWorkflowView

export interface FilmProductionActivities {
  submitFilmProductionScene(input: {
    productionId: string
    userId: string
    scene: FilmProductionSceneInput
    workflowId: string
  }): Promise<FilmProductionSceneReceipt>
  pollFilmProductionScene(input: {
    jobId: string
    providerJobId: string
    userId: string
  }): Promise<FilmProductionSceneStatus>
  archiveFilmProductionScene(input: {
    jobId: string
    productionId: string
    userId: string
  }): Promise<void>
  enqueueFilmProductionRender(input: {
    productionId: string
    userId: string
    workflowId: string
    sceneJobs: FilmProductionSceneReceipt[]
    profile: FilmProductionRenderProfile
  }): Promise<string>
}
