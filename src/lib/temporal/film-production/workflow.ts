import { defineQuery, proxyActivities, setHandler, setWorkflowOptions, sleep, workflowInfo } from '@temporalio/workflow'
import { TEMPORAL_WORKFLOW } from '../workflow-registry'
import {
  FILM_PRODUCTION_STATE_QUERY,
  type FilmProductionActivities,
  type FilmProductionWorkflowInput,
  type FilmProductionWorkflowResult,
  type FilmProductionWorkflowView,
} from './contracts'

const activities = proxyActivities<FilmProductionActivities>({
  startToCloseTimeout: '2 minutes',
  heartbeatTimeout: '45 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
  },
})

const stateQuery = defineQuery<FilmProductionWorkflowView>(FILM_PRODUCTION_STATE_QUERY)

export async function filmProductionWorkflow(
  input: FilmProductionWorkflowInput,
): Promise<FilmProductionWorkflowResult> {
  if (!input || workflowInfo().workflowId !== input.workflowId) {
    throw new Error('FILM_PRODUCTION_WORKFLOW_ID_MISMATCH')
  }
  const view: FilmProductionWorkflowView = {
    workflowId: input.workflowId,
    productionId: input.productionId,
    status: 'starting',
    completedScenes: 0,
    totalScenes: input.scenes.length,
    renderJobId: null,
    sceneJobs: [],
  }
  setHandler(stateQuery, () => ({ ...view, sceneJobs: view.sceneJobs.map((job) => ({ ...job })) }))

  try {
    view.status = 'generating'
    // Run one scene at a time to respect the existing single-slot GPU fallback.
    // Each provider handoff, poll and archive is a durable Activity/timer boundary.
    for (const scene of input.scenes) {
      const receipt = await activities.submitFilmProductionScene({
        productionId: input.productionId,
        userId: input.userId,
        scene,
        workflowId: input.workflowId,
      })
      view.sceneJobs.push(receipt)

      const deadline = Date.now() + input.generationTimeoutMs
      while (true) {
        const result = await activities.pollFilmProductionScene({
          jobId: receipt.jobId,
          providerJobId: receipt.providerJobId,
          userId: input.userId,
        })
        if (result.status === 'failed') {
          throw new Error(`FILM_PRODUCTION_SCENE_FAILED:${receipt.sceneId}:${result.failure ?? 'ComfyUI generation failed'}`)
        }
        if (result.status === 'completed') {
          await activities.archiveFilmProductionScene({
            jobId: receipt.jobId,
            productionId: input.productionId,
            userId: input.userId,
          })
          view.completedScenes += 1
          break
        }
        if (Date.now() >= deadline) {
          throw new Error(`FILM_PRODUCTION_SCENE_TIMEOUT:${receipt.sceneId}`)
        }
        await sleep(input.pollIntervalMs)
      }
    }

    if (input.render) {
      view.renderJobId = await activities.enqueueFilmProductionRender({
        productionId: input.productionId,
        userId: input.userId,
        workflowId: input.workflowId,
        sceneJobs: view.sceneJobs,
        profile: input.render,
      })
      view.status = 'render_queued'
    } else {
      view.status = 'completed'
    }
    return { ...view, sceneJobs: view.sceneJobs.map((job) => ({ ...job })) }
  } catch (error) {
    view.status = 'failed'
    throw error
  }
}

setWorkflowOptions(
  { versioningBehavior: TEMPORAL_WORKFLOW.FILM_PRODUCTION.versioningBehavior },
  filmProductionWorkflow,
)
