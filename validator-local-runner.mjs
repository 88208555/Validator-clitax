import { spawn } from 'node:child_process'
import { createHash, randomUUID, sign } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  bytesSha256, loadApprovedExecutionPlan, loadApprovedSigner, validationSubjectForPlan, verifyPlanFiles,
} from './validator-runner-plan.mjs'
import { validatorReceiptPayload, validatorReceiptSubject } from './validator-runtime.mjs'

const TERMINATION_GRACE_MS = 250
const REAP_DEADLINE_MS = 1_000
const EXECUTION_SCHEMA = 'validator.runner-execution/1.0'
const EVIDENCE_SCHEMA = 'cli.tax.test-evidence/1.0'
const RECEIPT_SCHEMA = 'validator.execution-receipt/1.0'

function signalProcessGroup(child, signal) {
  if (!Number.isInteger(child.pid)) throw new Error('Runner child has no process identifier')
  try {
    process.kill(-child.pid, signal)
    return { signal, status: 'delivered' }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
    return { signal, status: 'already-exited' }
  }
}

function executeBoundedCommand(authority) {
  const { policy } = authority.plan
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(policy.executable, policy.args, {
      cwd: authority.root, env: { ...policy.environment },
      shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const termination = []
    const stdout = []
    const stderr = []
    const stdoutHash = createHash('sha256')
    const stderrHash = createHash('sha256')
    let capturedBytes = 0
    let droppedBytes = 0
    let timedOut = false
    let outputLimitExceeded = false
    let terminating = false
    let escalation = null
    let failure = null
    const terminate = () => {
      if (terminating) return
      terminating = true
      try {
        termination.push(signalProcessGroup(child, 'SIGTERM'))
        escalation = setTimeout(() => {
          try { termination.push(signalProcessGroup(child, 'SIGKILL')) } catch (error) { failure = error }
        }, TERMINATION_GRACE_MS)
      } catch (error) {
        failure = error
      }
    }
    const timer = setTimeout(() => { timedOut = true; terminate() }, policy.timeoutMs)
    const hardLimit = setTimeout(() => {
      clearTimeout(timer)
      if (escalation !== null) clearTimeout(escalation)
      try { if (Number.isInteger(child.pid)) termination.push(signalProcessGroup(child, 'SIGKILL')) } catch (error) { failure = error }
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      reject(new Error('Validator process could not be reaped within its hard deadline', { cause: failure }))
    }, policy.timeoutMs + TERMINATION_GRACE_MS + REAP_DEADLINE_MS)
    const consume = (target, hash, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(bytes)
      const remaining = policy.maxOutputBytes - capturedBytes
      const retained = Math.min(bytes.length, remaining)
      if (retained > 0) target.push(Buffer.from(bytes.subarray(0, retained)))
      capturedBytes += retained
      droppedBytes += bytes.length - retained
      if (droppedBytes > 0) { outputLimitExceeded = true; terminate() }
    }
    child.stdout.on('data', (chunk) => consume(stdout, stdoutHash, chunk))
    child.stderr.on('data', (chunk) => consume(stderr, stderrHash, chunk))
    child.once('error', (error) => { failure = error })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      clearTimeout(hardLimit)
      if (escalation !== null) clearTimeout(escalation)
      try { if (Number.isInteger(child.pid)) termination.push(signalProcessGroup(child, 'SIGKILL')) } catch (error) { failure = error }
      if (failure !== null) return reject(new Error('Validator subprocess lifecycle failed', { cause: failure }))
      resolve({
        exitCode, signal, timedOut, outputLimitExceeded,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        stdoutSha256: stdoutHash.digest('hex'), stderrSha256: stderrHash.digest('hex'),
        capturedBytes, droppedBytes, termination,
      })
    })
  })
}

function executionSummary(result) {
  if (result.timedOut) return 'Approved validation command exceeded its deadline'
  if (result.outputLimitExceeded) return 'Approved validation command exceeded its output limit'
  if (result.signal !== null) return `Approved validation command ended on signal ${result.signal}`
  return `Approved validation command exited with code ${result.exitCode}`
}

export function validatorExecutionLogsDigest(result) {
  return bytesSha256(JSON.stringify({
    stdout: result.stdout, stderr: result.stderr, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256,
    capturedBytes: result.capturedBytes, droppedBytes: result.droppedBytes,
  }))
}

function receiptSummary(result) {
  return JSON.stringify({
    message: executionSummary(result), logsSha256: validatorExecutionLogsDigest(result),
    stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256,
    capturedBytes: result.capturedBytes, droppedBytes: result.droppedBytes,
  })
}

function localEvidence(subject, result, summary) {
  if (!Number.isInteger(result.exitCode)) return null
  return {
    schemaVersion: EVIDENCE_SCHEMA, evidenceId: `${subject.validationRunId}:process`,
    kind: 'test', runner: 'local', command: subject.policy.command,
    exitCode: result.exitCode, durationMs: result.durationMs, summary,
    artifactSha256: subject.artifactSha256, subject, subjectDigest: validatorReceiptSubject(subject),
  }
}

function signedEvidence(subject, result, summary, signer, passed) {
  const issuedAt = new Date()
  const unsigned = {
    schemaVersion: RECEIPT_SCHEMA, keyId: signer.keyId, nonce: `receipt-${randomUUID()}`,
    subjectDigest: validatorReceiptSubject(subject), issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + signer.receiptTtlMs).toISOString(),
    result: { runner: 'trusted-runner', passed, exitCode: result.exitCode,
      durationMs: result.durationMs, summary },
  }
  const receipt = { ...unsigned,
    signature: sign(null, Buffer.from(validatorReceiptPayload(unsigned)), signer.key).toString('base64url') }
  return { ...localEvidence(subject, result, summary), runner: 'trusted-runner', receipt }
}

export async function runApprovedValidatorPlan(input) {
  const authority = await loadApprovedExecutionPlan(input)
  const subject = validationSubjectForPlan(authority.plan, authority.planSha256, new Date().toISOString())
  const result = await executeBoundedCommand(authority)
  try {
    await verifyPlanFiles(authority)
  } catch (error) {
    const failure = new Error('Validator integrity changed during execution', { cause: error })
    failure.execution = { schemaVersion: EXECUTION_SCHEMA, status: 'failed', subject, process: result, evidence: [] }
    throw failure
  }
  const passed = result.exitCode === authority.plan.policy.requiredExitCode
    && result.signal === null && !result.timedOut && !result.outputLimitExceeded
  const summary = receiptSummary(result)
  const signer = Number.isInteger(result.exitCode) ? await loadApprovedSigner(authority) : null
  const evidence = signer === null ? localEvidence(subject, result, summary)
    : signedEvidence(subject, result, summary, signer, passed)
  return {
    schemaVersion: EXECUTION_SCHEMA, status: passed ? 'succeeded' : 'failed',
    planSha256: authority.planSha256,
    approvalSha256: authority.approval.sha256, approvedBy: authority.approval.approval.approvedBy,
    subject, process: result, evidence: evidence === null ? [] : [evidence],
    receipt: evidence !== null && signer !== null ? evidence.receipt : null,
    signingBoundary: signer === null ? 'local-evidence-only'
      : 'configured-signature-only; independent-uid-or-container-isolation-required-for-production-trust',
  }
}
