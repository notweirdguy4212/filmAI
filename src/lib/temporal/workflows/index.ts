import type { TemporalWorkflowType } from '../workflow-registry'
import { operationExecutionWorkflow } from './operation-execution'
import { taskWorkflow } from './task'
import { userTaskSchedulerWorkflow } from './user-task-scheduler'
import { filmProductionWorkflow } from '../film-production/workflow'

type TemporalWorkflowImplementation = (...args: never[]) => Promise<unknown>

const workflowImplementations = {
  operationExecutionWorkflow,
  taskWorkflow,
  userTaskSchedulerWorkflow,
  filmProductionWorkflow,
} satisfies Record<TemporalWorkflowType, TemporalWorkflowImplementation>

void workflowImplementations

export { operationExecutionWorkflow, taskWorkflow, userTaskSchedulerWorkflow, filmProductionWorkflow }
