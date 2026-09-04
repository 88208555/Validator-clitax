import { stdin, stdout } from 'node:process'
import { runApprovedValidatorPlan } from './validator-local-runner.mjs'
import { RUNNER_LIMITS, RUNNER_PLAN_SCHEMA, RUNNER_APPROVAL_SCHEMA, RUNNER_SIGNER_SCHEMA } from './validator-runner-plan.mjs'

const CAPABILITIES = Object.freeze({
  schemaVersion: 'validator.local-runner/1.0',
  operations: ['capabilities', 'run-approved-plan'],
  operationSchemas: {
    capabilities: { type: 'object', additionalProperties: false, properties: {} },
    'run-approved-plan': {
      type: 'object', additionalProperties: false,
      required: ['repositoryRoot', 'planPath', 'approvalPath', 'signerConfigPath'],
      properties: {
        repositoryRoot: { type: 'string', minLength: 1 }, planPath: { type: 'string', minLength: 1 },
        approvalPath: { type: 'string', minLength: 1 }, signerConfigPath: { type: ['string', 'null'] },
      },
    },
  },
  planSchema: RUNNER_PLAN_SCHEMA, approvalSchema: RUNNER_APPROVAL_SCHEMA, signerSchema: RUNNER_SIGNER_SCHEMA,
  limits: RUNNER_LIMITS,
  boundary: 'POSIX subprocess runner; external preapproval required. Signed receipts require separately configured trust and isolation.',
})

async function readInput() {
  const chunks = []
  let bytes = 0
  for await (const chunk of stdin) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > RUNNER_LIMITS.maxControlBytes) throw new Error('Validator runner input exceeds its limit')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function runValidatorLocalCli(args) {
  try {
    if (args.length !== 1 || !CAPABILITIES.operations.includes(args[0])) {
      throw new Error('Usage: cli-validator local capabilities | local run-approved-plan < runner-input.json')
    }
    const output = args[0] === 'capabilities' ? CAPABILITIES : await runApprovedValidatorPlan(await readInput())
    stdout.write(JSON.stringify(output) + '\n')
    if (output.status === 'failed') process.exitCode = 1
  } catch (error) {
    const failure = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    if (error instanceof Error && error.execution) failure.execution = error.execution
    stdout.write(JSON.stringify(failure) + '\n')
    process.exitCode = 1
  }
}
