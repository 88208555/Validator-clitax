export const BRAIN_RUNNER_ADAPTER_SOURCE: string
export const BRAIN_RUNNER_ADAPTER_PATH: string
export function brainRunnerContext(userId: string, plan: unknown, report: unknown,
  frozenAt: string, reportDigest: string, reportedAt: string): Record<string, unknown>
export function assertBrainRunnerSubmission(context: unknown, executionPlan: unknown,
  subject: unknown): Record<string, unknown>
export function buildBrainRunnerPlan(context: unknown, engine: unknown): Record<string, unknown>
export function canonicalBrainRunnerJson(value: unknown): string
export function brainRunnerBytesSha256(bytes: string | Buffer): string
