import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  run as validateProtocol, validatorArtifactSubject,
} from './validator-runtime.mjs'

export const RUNNER_PLAN_SCHEMA = 'validator.execution-plan/1.0'
export const RUNNER_APPROVAL_SCHEMA = 'validator.runner-approval/1.0'
export const RUNNER_SIGNER_SCHEMA = 'validator.runner-signer/1.0'
export const RUNNER_LIMITS = Object.freeze({
  maxFiles: 512, maxFileBytes: 16 * 1024 * 1024, maxManifestBytes: 64 * 1024 * 1024,
  maxControlBytes: 1024 * 1024, maxExecutableBytes: 256 * 1024 * 1024, maxTimeoutMs: 300_000, maxOutputBytes: 1024 * 1024,
  maxApprovalLifetimeMs: 24 * 60 * 60 * 1000, maxReceiptLifetimeMs: 600_000,
})
const SHA = /^[0-9a-f]{64}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export function bytesSha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) {
    throw new Error(`${label} has invalid fields`)
  }
  return value
}

function positiveInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive bounded integer`)
  }
}

function relativeFile(value) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC')
    || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Manifest paths must be normalized relative files')
  }
  return value
}

function inside(root, target) {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

export async function readRegularFile(path, maximum, privateFile) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximum) throw new Error('File is not regular or exceeds its limit')
    if (privateFile && (before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600
      || before.nlink !== 1)) throw new Error('Runner control files must be owned by the runner and mode 0600')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size) throw new Error('File changed while being read')
    return { bytes, byteLength: bytes.length, sha256: bytesSha256(bytes), device: before.dev, inode: before.ino }
  } finally {
    await handle.close()
  }
}

async function hashRegularFile(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximum) throw new Error('Hash target is not a bounded regular file')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let byteLength = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      byteLength += bytesRead
      if (byteLength > maximum) throw new Error('Hash target grew beyond its limit')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || byteLength !== after.size) throw new Error('Hash target changed while being read')
    return { byteLength, sha256: hash.digest('hex'), device: before.dev, inode: before.ino }
  } finally {
    await handle.close()
  }
}

async function externalFile(root, path, maximum) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('External runner control path must be absolute')
  const status = await lstat(path)
  if (status.isSymbolicLink()) throw new Error('External runner control cannot be a symlink')
  const canonical = await realpath(path)
  if (inside(root, canonical)) throw new Error('Runner controls and keys must be outside the tested workspace')
  return { path: canonical, ...(await readRegularFile(canonical, maximum, true)) }
}

async function projectFile(root, path, contents) {
  const name = relativeFile(path)
  let target = root
  for (const [index, part] of name.split('/').entries()) {
    target = resolve(target, part)
    const status = await lstat(target)
    if (status.isSymbolicLink() || (index < name.split('/').length - 1 && !status.isDirectory())) {
      throw new Error('Workspace files cannot traverse symlinks or non-directory parents')
    }
  }
  if (!inside(root, await realpath(target))) throw new Error('Workspace file escapes its root')
  const data = contents ? await readRegularFile(target, RUNNER_LIMITS.maxFileBytes, false)
    : await hashRegularFile(target, RUNNER_LIMITS.maxFileBytes)
  return { path: target, ...data }
}

function validateExecutionPolicy(policy, tests, files) {
  exactObject(policy, ['executable', 'executableSha256', 'args', 'environment',
    'timeoutMs', 'maxOutputBytes', 'requiredExitCode'], 'Execution policy')
  if (typeof policy.executable !== 'string' || !isAbsolute(policy.executable)
    || !SHA.test(policy.executableSha256)) throw new Error('Executable requires an absolute path and SHA-256')
  if (!Array.isArray(policy.args) || policy.args.length > 128
    || policy.args.some((value) => typeof value !== 'string' || value.includes('\0') || value.length > 4096)) {
    throw new Error('Executable args must be a bounded string array')
  }
  if (!policy.environment || typeof policy.environment !== 'object' || Array.isArray(policy.environment)
    || Object.keys(policy.environment).length > 64
    || Object.entries(policy.environment).some(([key, value]) => !ENVIRONMENT_KEY.test(key)
      || typeof value !== 'string' || value.includes('\0') || value.length > 16_384)) {
    throw new Error('Child environment must be explicit and bounded')
  }
  positiveInteger(policy.timeoutMs, RUNNER_LIMITS.maxTimeoutMs, 'timeoutMs')
  positiveInteger(policy.maxOutputBytes, RUNNER_LIMITS.maxOutputBytes, 'maxOutputBytes')
  if (policy.requiredExitCode !== 0) throw new Error('Validation requires exit code zero')
  if (!Array.isArray(tests) || !tests.length || tests.length > RUNNER_LIMITS.maxFiles) {
    throw new Error('Frozen tests must be non-empty and bounded')
  }
  for (const item of tests) {
    exactObject(item, ['testId', 'path'], 'Frozen test')
    if (!IDENTIFIER.test(item.testId) || !files.some((file) => file.path === item.path)
      || !policy.args.includes(relativeFile(item.path))) {
      throw new Error('Each test must be in the manifest and passed explicitly as a command argument')
    }
  }
}

function validateFrozenPlan(plan) {
  exactObject(plan, ['schemaVersion', 'frozen', 'planId', 'validationRunId', 'memberId', 'chainId',
    'artifactSha256', 'files', 'tests', 'policy', 'goldenBaseline', 'contracts'], 'Frozen execution plan')
  if (plan.schemaVersion !== RUNNER_PLAN_SCHEMA || plan.frozen !== true
    || !SHA.test(plan.artifactSha256) || !Array.isArray(plan.files)
    || !plan.files.length || plan.files.length > RUNNER_LIMITS.maxFiles) {
    throw new Error('Frozen execution plan is invalid')
  }
  for (const [index, file] of plan.files.entries()) {
    exactObject(file, ['path', 'sha256'], 'Manifest entry')
    relativeFile(file.path)
    if (!SHA.test(file.sha256) || (index > 0 && plan.files[index - 1].path >= file.path)) {
      throw new Error('Manifest paths must be unique, sorted and SHA-bound')
    }
  }
  if (validatorArtifactSubject(plan.files) !== plan.artifactSha256) throw new Error('Artifact manifest digest mismatch')
  validateExecutionPolicy(plan.policy, plan.tests, plan.files)
  if (plan.contracts?.archguard?.driftStatus === 'red') throw new Error('ArchGuard red blocks execution')
  return plan
}

export function validationSubjectForPlan(plan, planSha256, executedAt) {
  return {
    schemaVersion: 'validator.validation-subject/1.0',
    artifactSha256: plan.artifactSha256, memberId: plan.memberId, chainId: plan.chainId,
    executedAt, files: plan.files, validationRunId: plan.validationRunId, planId: plan.planId,
    tests: plan.tests,
    policy: { command: [plan.policy.executable, ...plan.policy.args].map((value) => JSON.stringify(value)).join(' '),
      requiredExitCode: plan.policy.requiredExitCode, executionPlanSha256: planSha256 },
    goldenBaseline: plan.goldenBaseline, contracts: plan.contracts,
  }
}

async function validateApproval(root, approvalPath, planSha256) {
  const file = await externalFile(root, approvalPath, RUNNER_LIMITS.maxControlBytes)
  const approval = exactObject(JSON.parse(file.bytes.toString('utf8')),
    ['schemaVersion', 'repositoryRoot', 'planSha256', 'approvedBy', 'approvedAt', 'expiresAt'],
    'Runner approval')
  const approvedAt = Date.parse(approval.approvedAt)
  const expiresAt = Date.parse(approval.expiresAt)
  if (approval.schemaVersion !== RUNNER_APPROVAL_SCHEMA || approval.repositoryRoot !== root
    || approval.planSha256 !== planSha256 || !IDENTIFIER.test(approval.approvedBy)
    || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)
    || approvedAt > Date.now() || expiresAt <= Date.now() || expiresAt <= approvedAt
    || expiresAt - approvedAt > RUNNER_LIMITS.maxApprovalLifetimeMs) {
    throw new Error('External approval is expired or does not match the frozen plan')
  }
  return { ...file, approval }
}

async function signerAuthority(root, signerConfigPath, policy) {
  if (signerConfigPath === null) return null
  const file = await externalFile(root, signerConfigPath, RUNNER_LIMITS.maxControlBytes)
  const config = exactObject(JSON.parse(file.bytes.toString('utf8')),
    ['schemaVersion', 'privateKeyPath', 'keyId', 'receiptTtlMs'], 'Runner signer')
  if (config.schemaVersion !== RUNNER_SIGNER_SCHEMA || !SHA.test(config.keyId)) {
    throw new Error('External runner signer configuration is invalid')
  }
  positiveInteger(config.receiptTtlMs, RUNNER_LIMITS.maxReceiptLifetimeMs, 'receiptTtlMs')
  const privatePath = await realpath(config.privateKeyPath)
  if (!isAbsolute(config.privateKeyPath) || inside(root, privatePath)
    || JSON.stringify([policy.args, policy.environment]).includes(config.privateKeyPath)
    || JSON.stringify([policy.args, policy.environment]).includes(privatePath)
    || JSON.stringify([policy.args, policy.environment]).includes(file.path)) {
    throw new Error('Signer paths cannot be inside the workspace or passed to the child')
  }
  const keyStatus = await lstat(config.privateKeyPath)
  if (keyStatus.isSymbolicLink() || !keyStatus.isFile() || keyStatus.uid !== process.getuid()
    || (keyStatus.mode & 0o777) !== 0o600 || keyStatus.nlink !== 1) {
    throw new Error('Runner private key must be a regular owned mode-0600 external file')
  }
  return { ...file, config: { ...config, privateKeyPath: privatePath } }
}

export async function verifyPlanFiles(authority) {
  let bytes = 0
  for (const file of authority.plan.files) {
    const actual = await projectFile(authority.root, file.path, false)
    bytes += actual.byteLength
    if (bytes > RUNNER_LIMITS.maxManifestBytes || actual.sha256 !== file.sha256) {
      throw new Error(`Artifact changed or exceeds its bound: ${file.path}`)
    }
  }
  const executable = await hashRegularFile(authority.plan.policy.executable, RUNNER_LIMITS.maxExecutableBytes)
  if (executable.sha256 !== authority.plan.policy.executableSha256) throw new Error('Executable SHA-256 mismatch')
  const plan = await projectFile(authority.root, authority.planPath, true)
  if (plan.sha256 !== authority.planSha256) throw new Error('Frozen plan changed')
  const approval = await validateApproval(authority.root, authority.approval.path, authority.planSha256)
  if (approval.sha256 !== authority.approval.sha256) throw new Error('External approval changed')
  if (authority.signer !== null) {
    const signer = await externalFile(authority.root, authority.signer.path, RUNNER_LIMITS.maxControlBytes)
    if (signer.sha256 !== authority.signer.sha256) throw new Error('External signer configuration changed')
  }
}

export async function loadApprovedExecutionPlan(input) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new Error('This bounded subprocess runner requires a POSIX host')
  }
  exactObject(input, ['repositoryRoot', 'planPath', 'approvalPath', 'signerConfigPath'], 'Runner input')
  if (typeof input.repositoryRoot !== 'string' || !isAbsolute(input.repositoryRoot)) {
    throw new Error('repositoryRoot must be absolute')
  }
  const rootStatus = await lstat(input.repositoryRoot)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) throw new Error('Workspace root must be a real directory')
  const root = await realpath(input.repositoryRoot)
  const planFile = await projectFile(root, input.planPath, true)
  if (planFile.bytes.length > RUNNER_LIMITS.maxControlBytes) throw new Error('Frozen plan is too large')
  const plan = validateFrozenPlan(JSON.parse(planFile.bytes.toString('utf8')))
  const approval = await validateApproval(root, input.approvalPath, planFile.sha256)
  const signer = await signerAuthority(root, input.signerConfigPath, plan.policy)
  const authority = { root, plan, planPath: input.planPath, planSha256: planFile.sha256, approval, signer }
  await verifyPlanFiles(authority)
  const subject = validationSubjectForPlan(plan, planFile.sha256, new Date().toISOString())
  const validation = await validateProtocol({ schemaVersion: 'validator.skill.request/1.0',
    requestId: 'runner-subject-validation', operation: 'verdict',
    input: { expectedSubject: subject, evidence: [], findings: [] } })
  if (validation.status !== 'succeeded') throw new Error('Frozen validation subject fails the Validator protocol')
  return authority
}

export async function loadApprovedSigner(authority) {
  if (authority.signer === null) return null
  const { config } = authority.signer
  const file = await externalFile(authority.root, config.privateKeyPath, 16_384)
  try {
    const key = createPrivateKey(file.bytes)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Runner signer requires Ed25519')
    const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' })
    if (bytesSha256(publicDer) !== config.keyId) throw new Error('Runner signer public key fingerprint mismatch')
    return { key, keyId: config.keyId, receiptTtlMs: config.receiptTtlMs }
  } finally {
    file.bytes.fill(0)
  }
}
