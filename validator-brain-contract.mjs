const SHA_PATTERN = '^[0-9a-f]{64}$'
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
const SHA = new RegExp(SHA_PATTERN)
const UUID = new RegExp(UUID_PATTERN)
const FIELDS = ['schemaVersion', 'planId', 'planSha256', 'reportId', 'reportSha256',
  'checksSha256', 'scopeContractSha256', 'snapshotSha256', 'adapterSha256']

export const brainRunnerContractSchema = {
  type: 'object', additionalProperties: false, required: FIELDS,
  properties: {
    schemaVersion: { const: 'brain.frozen-runner/1.0' },
    planId: { type: 'string', pattern: UUID_PATTERN }, reportId: { type: 'string', pattern: UUID_PATTERN },
    ...Object.fromEntries(FIELDS.filter((field) => field.endsWith('Sha256'))
      .map((field) => [field, { type: 'string', pattern: SHA_PATTERN }])),
  },
}

export function validBrainRunnerContract(value, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...FIELDS].sort().join('|')
    || value.schemaVersion !== 'brain.frozen-runner/1.0'
    || !UUID.test(value.planId) || !UUID.test(value.reportId)
    || value.planId !== subject.planId || subject.chainId !== 'chn-' + value.reportId
    || subject.validationRunId !== 'brain-' + value.reportId) return false
  return FIELDS.filter((field) => field.endsWith('Sha256')).every((field) => typeof value[field] === 'string' && SHA.test(value[field]))
}

export function validateBridgeContracts(value, entityRef, hardened, utilities) {
  const { isObj, text, idRegex, shaRegex, finding } = utilities
  const findings = []
  if (hardened && (!isObj(value.contracts) || (!isObj(value.contracts.aimlock)
    && !validBrainRunnerContract(value.contracts.brain, value)))) findings.push(finding("P0", "VALIDATION-SUBJECT-SNAPSHOT", `${entityRef}.contracts`, "Hardened validation requires an Aimlock snapshot or server frozen Brain contract binding"));
  if (value.contracts?.brain !== undefined && !validBrainRunnerContract(value.contracts.brain, value)) findings.push(finding("P0", "VALIDATION-SUBJECT-BRAIN", `${entityRef}.contracts.brain`, "Brain runner contract is invalid or bound to another execution"));
  if (value.contracts !== undefined && (!isObj(value.contracts)
    || (value.contracts.aimlock !== undefined && (!isObj(value.contracts.aimlock)
      || !idRegex.test(text(value.contracts.aimlock.goalId))
      || !shaRegex.test(text(value.contracts.aimlock.scopeContractSha256))
      || !shaRegex.test(text(value.contracts.aimlock.snapshotSha256))))
    || (value.contracts.blueprint !== undefined && (!isObj(value.contracts.blueprint)
      || !idRegex.test(text(value.contracts.blueprint.blueprintId))
      || !shaRegex.test(text(value.contracts.blueprint.acceptanceReportSha256))))
    || (value.contracts.archguard !== undefined && (!isObj(value.contracts.archguard)
      || !shaRegex.test(text(value.contracts.archguard.contractSha256))
      || !shaRegex.test(text(value.contracts.archguard.ledgerSha256))
      || !["green", "yellow", "red"].includes(value.contracts.archguard.driftStatus))))) findings.push(finding("P0", "VALIDATION-SUBJECT-CONTRACTS", `${entityRef}.contracts`, "Aimlock, Blueprint, and ArchGuard bridge contracts require stable ids, SHA-256 digests, and a valid drift status"));
  return findings
}
