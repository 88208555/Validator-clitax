import { createHash } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { validatorArtifactSubject, validatorReceiptSubject } from './validator-runtime.mjs'

export const BRAIN_RUNNER_CONTEXT_SCHEMA = 'brain.runner-context/1.0'
export const BRAIN_RUNNER_CONTRACT_SCHEMA = 'brain.frozen-runner/1.0'
export const BRAIN_RUNNER_ADAPTER_PATH = '.aimlock/brain-validation/check-runner.mjs'
export const BRAIN_RUNNER_MAX_TIMEOUT_MS = 300_000
export const BRAIN_RUNNER_MAX_OUTPUT_BYTES = 1_048_576
const BRAIN_RUNNER_OVERHEAD_MS = 5_000
const SHA256 = /^[0-9a-f]{64}$/

export const BRAIN_RUNNER_ADAPTER_SOURCE = String.raw`import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

if (typeof process.getuid !== 'function' || process.getuid() !== 0) throw new Error('Trusted Brain checks require an isolated root runner with a separate unprivileged UID')
const path = process.argv[2]
if (process.argv.length !== 3 || typeof path !== 'string') throw new Error('A frozen checks manifest is required')
const manifest = JSON.parse(await readFile(resolve(path), 'utf8'))
if (manifest.schemaVersion !== 'brain.trusted-checks/1.0' || !Array.isArray(manifest.checks)
  || manifest.checks.length === 0 || manifest.checks.length > 16) throw new Error('Invalid frozen checks manifest')
if (typeof process.env.PATH !== 'string') throw new Error('An explicit executable search path is required')

function executeCheck(check) {
  if (typeof check.id !== 'string' || typeof check.executable !== 'string'
    || !Array.isArray(check.args) || check.args.some((arg) => typeof arg !== 'string')
    || !Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1) throw new Error('Invalid frozen check')
  return new Promise((resolveCheck, reject) => {
    const child = spawn(check.executable, check.args, {
      cwd: process.cwd(), shell: false, detached: false, uid: 65534, gid: 65534,
      env: { PATH: process.env.PATH }, stdio: ['ignore', 'inherit', 'inherit'],
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      process.kill(-process.pid, 'SIGKILL')
    }, check.timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      resolveCheck({ checkId: check.id, exitCode, signal, timedOut })
    })
  })
}

const results = []
for (const check of manifest.checks) results.push(await executeCheck(check))
const complete = new Set(results.map((result) => result.checkId)).size === manifest.checks.length
const passed = complete && results.every((result) => result.exitCode === 0 && result.signal === null && !result.timedOut)
process.stdout.write(JSON.stringify({ schemaVersion: 'brain.trusted-check-results/1.0', results, passed }) + '\n')
process.exitCode = passed ? 0 : 1
`

export function canonicalBrainRunnerJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalBrainRunnerJson).join(',') + ']'
  if (!value || typeof value !== 'object') throw new Error('Brain runner value must be JSON')
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalBrainRunnerJson(value[key])).join(',') + '}'
}

export function brainRunnerBytesSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function brainRunnerContext(userId, plan, report, frozenAt, reportDigest, reportedAt) {
  const files = [...report.files].sort((left, right) => left.path < right.path ? -1 : 1)
  if (files.some((file) => file.path.startsWith('.aimlock/brain-validation/'))) throw new Error('Brain runner control paths are reserved')
  return {
    schemaVersion: BRAIN_RUNNER_CONTEXT_SCHEMA, memberId: brainRunnerBytesSha256(userId).slice(0, 32),
    chainId: 'chn-' + report.reportId, validationRunId: 'brain-' + report.reportId,
    planId: plan.planId, reportId: report.reportId, planDigest: validatorReceiptSubject(plan), reportDigest,
    checks: plan.checks, files, frozenAt, reportedAt,
    scopeContractSha256: validatorReceiptSubject(plan.contract), snapshotSha256: validatorReceiptSubject(plan.targets),
  }
}

export function brainRunnerManifest(context) {
  return {
    schemaVersion: 'brain.trusted-checks/1.0', planId: context.planId, reportId: context.reportId,
    planDigest: context.planDigest, reportDigest: context.reportDigest, checks: context.checks,
  }
}

export function brainRunnerControlFiles(context) {
  return [
    { path: BRAIN_RUNNER_ADAPTER_PATH, content: BRAIN_RUNNER_ADAPTER_SOURCE },
    { path: '.aimlock/brain-validation/' + context.reportId + '/checks.json', content: canonicalBrainRunnerJson(brainRunnerManifest(context)) },
  ]
}

export function buildBrainRunnerPlan(context, engine) {
  if (context.schemaVersion !== BRAIN_RUNNER_CONTEXT_SCHEMA) throw new Error('A server frozen Brain runner context is required')
  if (typeof engine.executable !== 'string' || !isAbsolute(engine.executable) || basename(engine.executable) !== 'node'
    || !SHA256.test(engine.executableSha256) || typeof engine.path !== 'string' || engine.path.length === 0) {
    throw new Error('An approved Node executable, hash, and explicit PATH are required')
  }
  const controls = brainRunnerControlFiles(context)
  const manifestPath = controls[1].path
  const files = [...context.files, ...controls.map((file) => ({ path: file.path, sha256: brainRunnerBytesSha256(file.content) }))]
    .sort((left, right) => left.path < right.path ? -1 : 1)
  const tests = [{ testId: 'brain-all-checks', path: manifestPath }]
  return {
    schemaVersion: 'validator.execution-plan/1.0', frozen: true, planId: context.planId,
    validationRunId: context.validationRunId, memberId: context.memberId, chainId: context.chainId,
    artifactSha256: validatorArtifactSubject(files), files, tests,
    policy: { executable: engine.executable, executableSha256: engine.executableSha256,
      args: [BRAIN_RUNNER_ADAPTER_PATH, manifestPath], environment: { PATH: engine.path },
      timeoutMs: Math.min(BRAIN_RUNNER_MAX_TIMEOUT_MS,
        context.checks.reduce((total, check) => total + check.timeoutMs, BRAIN_RUNNER_OVERHEAD_MS)),
      maxOutputBytes: BRAIN_RUNNER_MAX_OUTPUT_BYTES, requiredExitCode: 0 },
    goldenBaseline: { schemaVersion: 'validator.golden-baseline/1.0', baselineId: 'brain-' + context.planId,
      source: { kind: 'approved-record', locator: 'brain-plan:' + context.planId, digestSha256: context.planDigest },
      version: '1.0', frozen: true, frozenAt: context.frozenAt, frozenBy: 'brain-planning-server',
      testsSha256: validatorReceiptSubject(tests) },
    contracts: { brain: { schemaVersion: BRAIN_RUNNER_CONTRACT_SCHEMA,
      planId: context.planId, planSha256: context.planDigest, reportId: context.reportId, reportSha256: context.reportDigest,
      checksSha256: validatorReceiptSubject(context.checks), scopeContractSha256: context.scopeContractSha256,
      snapshotSha256: context.snapshotSha256, adapterSha256: brainRunnerBytesSha256(BRAIN_RUNNER_ADAPTER_SOURCE) } },
  }
}

export function assertBrainRunnerSubmission(context, executionPlan, subject) {
  if (!executionPlan || typeof executionPlan !== 'object' || !executionPlan.policy || typeof executionPlan.policy !== 'object') {
    throw new Error('A frozen runner execution plan is required')
  }
  const policy = executionPlan.policy
  const expected = buildBrainRunnerPlan(context, {
    executable: policy.executable, executableSha256: policy.executableSha256, path: policy.environment?.PATH,
  })
  if (canonicalBrainRunnerJson(expected) !== canonicalBrainRunnerJson(executionPlan)) {
    throw new Error('Runner plan does not execute the complete frozen Brain checks')
  }
  if (!subject || typeof subject !== 'object' || typeof subject.executedAt !== 'string'
    || !Number.isFinite(Date.parse(subject.executedAt)) || Date.parse(subject.executedAt) < Date.parse(context.reportedAt)) {
    throw new Error('Runner execution must follow the frozen Brain report')
  }
  const expectedSubject = {
    schemaVersion: 'validator.validation-subject/1.0', artifactSha256: expected.artifactSha256,
    memberId: expected.memberId, chainId: expected.chainId, executedAt: subject.executedAt, files: expected.files,
    validationRunId: expected.validationRunId, planId: expected.planId, tests: expected.tests,
    policy: { command: [policy.executable, ...policy.args].map((part) => JSON.stringify(part)).join(' '),
      requiredExitCode: 0, executionPlanSha256: brainRunnerBytesSha256(canonicalBrainRunnerJson(expected)) },
    goldenBaseline: expected.goldenBaseline, contracts: expected.contracts,
  }
  if (canonicalBrainRunnerJson(expectedSubject) !== canonicalBrainRunnerJson(subject)) {
    throw new Error('Signed runner subject does not match the member, plan, report, artifact, and checks')
  }
  return expectedSubject
}
