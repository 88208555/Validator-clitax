import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readRegularFile } from './validator-runner-plan.mjs'
import { runApprovedValidatorPlan } from './validator-local-runner.mjs'
import {
  assertBrainRunnerSubmission, brainRunnerBytesSha256, brainRunnerControlFiles,
  buildBrainRunnerPlan, canonicalBrainRunnerJson,
} from './brain-validator-contract.mjs'

async function checkedProjectPath(root, relativePath, createParents) {
  if (typeof relativePath !== 'string' || relativePath.startsWith('/') || relativePath.includes('\\')
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid runner project path')
  let directory = root
  const parts = relativePath.split('/')
  for (const part of parts.slice(0, -1)) {
    directory = resolve(directory, part)
    if (createParents) {
      try { await mkdir(directory, { mode: 0o700 }) }
      catch (error) { if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error }
    }
    const status = await lstat(directory)
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Runner paths cannot traverse symlinks')
  }
  return resolve(directory, parts[parts.length - 1])
}

async function writeFrozenControl(root, relativePath, content) {
  const path = await checkedProjectPath(root, relativePath, true)
  let handle
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
  catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error
    const existing = await readRegularFile(path, 1_048_576, true)
    if (existing.sha256 !== brainRunnerBytesSha256(content)) throw new Error('A frozen runner control file already has different content')
    return path
  }
  try { await handle.writeFile(content) } finally { await handle.close() }
  return path
}

export async function prepareBrainValidation(repositoryRoot, reportResponse, environment = process.env) {
  if (reportResponse.status !== 'reported' || !reportResponse.report || reportResponse.report.checksPassed !== true
    || !reportResponse.report.validationContext) throw new Error('A complete successful Brain report is required')
  if (typeof environment.PATH !== 'string' || !environment.PATH) throw new Error('An explicit PATH is required')
  const rootStatus = await lstat(repositoryRoot)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) throw new Error('Runner workspace must be a real directory')
  const root = await realpath(repositoryRoot)
  const context = reportResponse.report.validationContext
  if (context.planId !== reportResponse.planId || context.reportDigest !== reportResponse.reportDigest) {
    throw new Error('Brain report identity does not match its runner context')
  }
  for (const file of context.files) {
    const actual = await readRegularFile(await checkedProjectPath(root, file.path, false), 16_777_216, false)
    if (actual.sha256 !== file.sha256) throw new Error('Reported project file changed before validation: ' + file.path)
  }
  for (const file of brainRunnerControlFiles(context)) await writeFrozenControl(root, file.path, file.content)
  const executable = await realpath(process.execPath)
  const executionPlan = buildBrainRunnerPlan(context, {
    executable, executableSha256: brainRunnerBytesSha256(await readFile(executable)), path: environment.PATH,
  })
  const planPath = '.aimlock/brain-validation/' + context.reportId + '/execution-plan.json'
  const planContent = canonicalBrainRunnerJson(executionPlan)
  await writeFrozenControl(root, planPath, planContent)
  return { repositoryRoot: root, planPath, executionPlan, planSha256: brainRunnerBytesSha256(planContent), context }
}

export async function runBrainApprovedValidation(repositoryRoot, input, environment = process.env) {
  if (typeof input.approvalPath !== 'string' || typeof input.signerConfigPath !== 'string') {
    throw new Error('An external approved runner authority and signer configuration are required')
  }
  const prepared = await prepareBrainValidation(repositoryRoot, input.reportResponse, environment)
  const execution = await runApprovedValidatorPlan({
    repositoryRoot: prepared.repositoryRoot, planPath: prepared.planPath,
    approvalPath: input.approvalPath, signerConfigPath: input.signerConfigPath,
  })
  if (execution.status !== 'succeeded' || !execution.receipt) throw new Error('All Brain checks require a successful trusted runner receipt')
  const subject = assertBrainRunnerSubmission(prepared.context, prepared.executionPlan, execution.subject)
  return { planId: prepared.context.planId, reportDigest: prepared.context.reportDigest,
    executionPlan: prepared.executionPlan, subject, receipts: [execution.receipt] }
}

export async function runBrainValidatorCli(args) {
  if (args.length !== 3 || !['prepare', 'run'].includes(args[0])) {
    throw new Error('Usage: cli-validator brain <prepare|run> <repositoryRoot> <inputJsonFile>')
  }
  const inputFile = await readRegularFile(resolve(args[2]), 256_000, false)
  const input = JSON.parse(inputFile.bytes.toString('utf8'))
  const output = args[0] === 'prepare' ? await prepareBrainValidation(resolve(args[1]), input)
    : await runBrainApprovedValidation(resolve(args[1]), input)
  process.stdout.write(JSON.stringify(output, null, 2) + '\n')
}
