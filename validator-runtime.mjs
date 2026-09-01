import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

const REQ = "validator.skill.request/1.0";
const RES = "validator.skill.response/1.0";
const ERR = "validator.skill.error/1.0";
const NAME = "validator";
const COMPILER_VERSION = "v7.0.32";
const CATALOG_SCHEMA = "cli.tax.skill-catalog/1.0";
const RECEIPT_SCHEMA = "validator.execution-receipt/1.0";
const VALIDATION_SUBJECT_SCHEMA = "validator.validation-subject/1.0";
const GOLDEN_BASELINE_SCHEMA = "validator.golden-baseline/1.0";
const TEST_EVIDENCE_SCHEMA = "cli.tax.test-evidence/1.0";
const RECEIPT_PUBLIC_KEY_ENV = "CLITAX_VALIDATOR_RECEIPT_PUBLIC_KEY";
const MAX_RECEIPT_LIFETIME_MS = 10 * 60 * 1000;
const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const MEMBER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$";
const CHAIN_PATTERN = "^chn-[0-9a-f-]{36}$";
const SHA_PATTERN = "^[0-9a-f]{64}$";
const idRegex = new RegExp(ID_PATTERN);
const memberRegex = new RegExp(MEMBER_PATTERN);
const chainRegex = new RegExp(CHAIN_PATTERN);
const shaRegex = new RegExp(SHA_PATTERN);

const OPS = ["capabilities","help","intake","plan","validate-structure","security-scan","compliance-audit","functional-verify","sandbox-run","fuzz-input","perf-benchmark","intrusive-test","verdict"];
const PURE = new Set(["capabilities","help","intake","plan","validate-structure","security-scan","compliance-audit","functional-verify","verdict"]);
const LOCAL_ONLY = new Set(["sandbox-run","fuzz-input","perf-benchmark","intrusive-test"]);
const CATALOG = OPS.map((operation) => ({ operation, summary: operation }));

const stringSchema = (extra = {}) => ({ type: "string", ...extra });
const arraySchema = (items, extra = {}) => ({ type: "array", items, ...extra });
const objectSchema = (properties, required = [], extra = {}) => ({
  type: "object", properties, required, additionalProperties: false, ...extra,
});
const anyObjectSchema = { type: "object" };
const findingSchema = objectSchema({
  severity: { enum: ["P0", "P1", "P2"] }, ruleId: stringSchema({ minLength: 1 }),
  entityRef: stringSchema({ minLength: 1 }), message: stringSchema({ minLength: 1 }),
  evidence: anyObjectSchema,
}, ["severity", "ruleId", "entityRef", "message", "evidence"]);
const receiptSchema = objectSchema({
  schemaVersion: { const: RECEIPT_SCHEMA }, keyId: stringSchema({ pattern: SHA_PATTERN }),
  nonce: stringSchema({ pattern: ID_PATTERN, minLength: 16, maxLength: 128 }), subjectDigest: stringSchema({ pattern: SHA_PATTERN }),
  issuedAt: stringSchema({ format: "date-time" }), expiresAt: stringSchema({ format: "date-time" }),
  result: objectSchema({ runner: { const: "trusted-runner" }, passed: { type: "boolean" },
    exitCode: { type: "integer" }, durationMs: { type: "number", minimum: 0 },
    summary: stringSchema({ minLength: 1 }) }, ["runner", "passed", "exitCode", "durationMs", "summary"]),
  signature: stringSchema({ minLength: 1 }),
}, ["schemaVersion", "keyId", "nonce", "subjectDigest", "issuedAt", "expiresAt", "result", "signature"]);
const baselineSchema = objectSchema({
  schemaVersion: { const: GOLDEN_BASELINE_SCHEMA }, baselineId: stringSchema({ pattern: ID_PATTERN }),
  source: objectSchema({ kind: { enum: ["repository-commit", "artifact", "approved-record"] },
    locator: stringSchema({ minLength: 1 }), digestSha256: stringSchema({ pattern: SHA_PATTERN }) },
  ["kind", "locator", "digestSha256"]),
  version: stringSchema({ pattern: ID_PATTERN }), frozen: { const: true },
  frozenAt: stringSchema({ format: "date-time" }), frozenBy: stringSchema({ pattern: ID_PATTERN }),
  testsSha256: stringSchema({ pattern: SHA_PATTERN }),
}, ["schemaVersion", "baselineId", "source", "version", "frozen", "frozenAt", "frozenBy", "testsSha256"]);
const contractsSchema = objectSchema({
  aimlock: objectSchema({ goalId: stringSchema({ pattern: ID_PATTERN }),
    scopeContractSha256: stringSchema({ pattern: SHA_PATTERN }), snapshotSha256: stringSchema({ pattern: SHA_PATTERN }) },
  ["goalId", "scopeContractSha256", "snapshotSha256"]),
  blueprint: objectSchema({ blueprintId: stringSchema({ pattern: ID_PATTERN }),
    acceptanceReportSha256: stringSchema({ pattern: SHA_PATTERN }) }, ["blueprintId", "acceptanceReportSha256"]),
  archguard: objectSchema({ contractSha256: stringSchema({ pattern: SHA_PATTERN }),
    ledgerSha256: stringSchema({ pattern: SHA_PATTERN }),
    driftStatus: { enum: ["green", "yellow", "red"] } },
  ["contractSha256", "ledgerSha256", "driftStatus"]),
});
const validationFileSchema = objectSchema({
  path: stringSchema({ minLength: 1, maxLength: 500 }),
  sha256: stringSchema({ pattern: SHA_PATTERN }),
}, ["path", "sha256"]);
const subjectSchema = objectSchema({
  schemaVersion: { const: VALIDATION_SUBJECT_SCHEMA }, artifactSha256: stringSchema({ pattern: SHA_PATTERN }),
  memberId: stringSchema({ pattern: MEMBER_PATTERN }), chainId: stringSchema({ pattern: CHAIN_PATTERN }),
  executedAt: stringSchema({ format: "date-time" }), files: arraySchema(validationFileSchema, { minItems: 1 }),
  validationRunId: stringSchema({ pattern: ID_PATTERN }), planId: stringSchema({ pattern: ID_PATTERN }),
  tests: arraySchema(anyObjectSchema, { minItems: 1 }), policy: anyObjectSchema,
  goldenBaseline: baselineSchema, contracts: contractsSchema,
}, ["schemaVersion", "artifactSha256", "validationRunId", "planId", "tests", "policy", "goldenBaseline"]);
const testEvidenceProperties = {
  schemaVersion: { const: TEST_EVIDENCE_SCHEMA }, evidenceId: stringSchema({ pattern: ID_PATTERN }),
  kind: { enum: ["test", "build", "lint", "security", "benchmark"] }, command: stringSchema({ minLength: 1 }),
  exitCode: { type: "integer" }, durationMs: { type: "number", minimum: 0 },
  summary: stringSchema({ minLength: 1 }), artifactSha256: stringSchema({ pattern: SHA_PATTERN }),
  subject: subjectSchema, subjectDigest: stringSchema({ pattern: SHA_PATTERN }), receipt: receiptSchema,
};
const testEvidenceRequired = ["schemaVersion", "evidenceId", "kind", "runner", "command", "exitCode", "durationMs", "summary"];
const testEvidenceSchema = {
  oneOf: [
    objectSchema({ ...testEvidenceProperties, runner: { const: "local" } }, testEvidenceRequired),
    objectSchema({ ...testEvidenceProperties, runner: { const: "trusted-runner" } },
      [...testEvidenceRequired, "artifactSha256", "subject", "subjectDigest", "receipt"]),
  ],
};
const riskEntrySchema = objectSchema({
  riskId: stringSchema({ pattern: ID_PATTERN }), findingRuleId: stringSchema({ minLength: 1 }),
  findingEntityRef: stringSchema({ minLength: 1 }), owner: stringSchema({ pattern: ID_PATTERN }),
  mitigation: stringSchema({ minLength: 1 }), acceptedBy: stringSchema({ pattern: ID_PATTERN }),
  acceptedAt: stringSchema({ format: "date-time" }),
}, ["riskId", "findingRuleId", "findingEntityRef", "owner", "mitigation", "acceptedBy", "acceptedAt"]);
const repairCategorySchema = {
  enum: ["structure-schema", "formula-calculation", "scope-drift", "execution-dispatch", "validator-self"],
};
const fileSchema = objectSchema({ path: stringSchema({ minLength: 1 }), content: stringSchema(), schema: anyObjectSchema }, ["path", "content"]);
const nextSchema = objectSchema({ operation: { type: ["string", "null"] }, instruction: stringSchema() }, ["operation", "instruction"]);
const responseSchema = (properties, required) => objectSchema({
  schemaVersion: { const: RES }, requestId: stringSchema({ minLength: 1 }), status: { enum: ["succeeded", "blocked", "failed"] }, ...properties,
}, ["schemaVersion", "requestId", "status", ...required]);
const operationSchema = (input, inputRequired, output, outputRequired) => ({
  input: objectSchema(input, inputRequired), output: responseSchema(output, outputRequired),
});
const SCHEMAS = Object.freeze({
  capabilities: operationSchema({}, [], { capabilities: anyObjectSchema, skill: anyObjectSchema, operationSchemas: anyObjectSchema, nextStep: nextSchema }, ["capabilities", "skill", "operationSchemas", "nextStep"]),
  help: operationSchema({}, [], { help: anyObjectSchema, operationSchemas: anyObjectSchema, nextStep: nextSchema }, ["help", "operationSchemas", "nextStep"]),
  intake: operationSchema({ goal: stringSchema({ minLength: 1 }), riskLevel: { enum: ["low", "medium", "high"] }, complianceReqs: arraySchema(stringSchema()), targetFiles: arraySchema(stringSchema()) }, ["goal", "riskLevel"], { intake: anyObjectSchema, nextStep: nextSchema }, ["intake", "nextStep"]),
  plan: operationSchema({ findings: arraySchema(findingSchema), findingCategories: arraySchema(repairCategorySchema), intakeResult: anyObjectSchema, availableSkills: arraySchema(stringSchema()) }, ["intakeResult"], { plan: anyObjectSchema, nextStep: nextSchema }, ["plan", "nextStep"]),
  "validate-structure": operationSchema({ files: arraySchema(fileSchema, { minItems: 1 }), rules: arraySchema(anyObjectSchema) }, ["files"], { findings: arraySchema(findingSchema), summary: anyObjectSchema, nextStep: nextSchema }, ["findings", "summary", "nextStep"]),
  "security-scan": operationSchema({ files: arraySchema(fileSchema, { minItems: 1 }), rules: arraySchema(anyObjectSchema) }, ["files"], { findings: arraySchema(findingSchema), summary: anyObjectSchema, nextStep: nextSchema }, ["findings", "summary", "nextStep"]),
  "compliance-audit": operationSchema({ files: arraySchema(fileSchema, { minItems: 1 }), template: stringSchema({ minLength: 1 }), requirements: arraySchema(stringSchema()) }, ["files", "template"], { findings: arraySchema(findingSchema), template: stringSchema(), nextStep: nextSchema }, ["findings", "template", "nextStep"]),
  "functional-verify": operationSchema({ validationContext: subjectSchema, receipts: arraySchema(receiptSchema, { minItems: 1 }) }, ["validationContext", "receipts"], { subject: subjectSchema, subjectDigest: stringSchema({ pattern: SHA_PATTERN }), results: arraySchema(anyObjectSchema), summary: anyObjectSchema, findings: arraySchema(findingSchema), evidence: arraySchema(testEvidenceSchema), nextStep: nextSchema }, ["subject", "subjectDigest", "results", "summary", "findings", "evidence", "nextStep"]),
  "sandbox-run": operationSchema({ command: stringSchema({ minLength: 1 }), files: arraySchema(fileSchema), timeout: { type: "number", minimum: 0 }, networkPolicy: { enum: ["block", "allow"] } }, ["command", "networkPolicy"], { sandbox: anyObjectSchema, runner: { const: "local-only" }, evidence: arraySchema(testEvidenceSchema), nextStep: nextSchema }, ["sandbox", "runner", "evidence", "nextStep"]),
  "fuzz-input": operationSchema({ targetFile: stringSchema({ minLength: 1 }), cases: arraySchema(anyObjectSchema), maxCases: { type: "integer", minimum: 1 } }, ["targetFile", "maxCases"], { fuzz: anyObjectSchema, runner: { const: "local-only" }, evidence: arraySchema(testEvidenceSchema), nextStep: nextSchema }, ["fuzz", "runner", "evidence", "nextStep"]),
  "perf-benchmark": operationSchema({ command: stringSchema({ minLength: 1 }), baseline: baselineSchema, threshold: { type: "number", minimum: 0 } }, ["command", "baseline", "threshold"], { benchmark: anyObjectSchema, runner: { const: "local-only" }, evidence: arraySchema(testEvidenceSchema), nextStep: nextSchema }, ["benchmark", "runner", "evidence", "nextStep"]),
  "intrusive-test": operationSchema({ authorization: { type: "boolean" }, tests: arraySchema(anyObjectSchema, { minItems: 1 }), sandbox: { const: true } }, ["authorization", "tests", "sandbox"], { intrusive: anyObjectSchema, runner: { const: "local-only" }, evidence: arraySchema(testEvidenceSchema), nextStep: nextSchema }, ["intrusive", "runner", "evidence", "nextStep"]),
  verdict: operationSchema({ expectedSubject: subjectSchema, validationContext: subjectSchema, findings: arraySchema(findingSchema), evidence: arraySchema(testEvidenceSchema), riskLedger: arraySchema(riskEntrySchema) }, [], { report: anyObjectSchema, findings: arraySchema(findingSchema), evidence: arraySchema(testEvidenceSchema), nextStep: nextSchema }, ["report", "findings", "evidence", "nextStep"]),
});

function text(value) { return String(value ?? ""); }
function isObj(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function finding(severity, ruleId, entityRef, message, evidence) {
  return { severity, ruleId, entityRef, message, evidence: evidence === undefined ? {} : { example: evidence } };
}
function ok(requestId, payload) { return { schemaVersion: RES, requestId, status: "succeeded", ...payload }; }
function blocked(requestId, findings) { return { schemaVersion: RES, requestId, status: "blocked", validation: { valid: false, guarantee: "blocked", findings } }; }
function failed(requestId, code, message) { return { schemaVersion: RES, requestId, status: "failed", errorSchema: ERR, error: { code, message } }; }
function requiredText(input, key) {
  const value = text(input[key]).trim();
  return value ? { value } : { error: finding("P0", "REQUIRED", `input.${key}`, `${key} is required`) };
}
function requiredArray(input, key, minimum = 0) {
  if (!Array.isArray(input[key]) || input[key].length < minimum) return { error: finding("P0", "REQUIRED", `input.${key}`, `${key} must contain at least ${minimum} item(s)`) };
  return { value: input[key] };
}
function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Evidence must contain finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isObj(value)) throw new TypeError("Evidence must be JSON serializable");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
export function validatorReceiptSubject(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export function validatorArtifactSubject(files) {
  const manifest = files.map((file) => `${file.path}\0${file.sha256}`).join("\n");
  return createHash("sha256").update(`validator.file-manifest/1.0\n${manifest}`).digest("hex");
}
export function validatorReceiptPayload(receipt) {
  if (!isObj(receipt)) throw new TypeError("Execution receipt must be an object");
  const { signature: _signature, ...payload } = receipt;
  return canonicalJson(payload);
}

function validateGoldenBaseline(value, entityRef, tests) {
  const findings = [];
  if (!isObj(value)) return [finding("P0", "GOLDEN-BASELINE-REQUIRED", entityRef, "A frozen golden baseline is required")];
  if (value.schemaVersion !== GOLDEN_BASELINE_SCHEMA) findings.push(finding("P0", "GOLDEN-BASELINE-SCHEMA", `${entityRef}.schemaVersion`, `Expected ${GOLDEN_BASELINE_SCHEMA}`));
  if (!idRegex.test(text(value.baselineId)) || !idRegex.test(text(value.version)) || !idRegex.test(text(value.frozenBy))) findings.push(finding("P0", "GOLDEN-BASELINE-ID", entityRef, "baselineId, version, and frozenBy must be stable identifiers"));
  if (value.frozen !== true || !Number.isFinite(Date.parse(text(value.frozenAt)))) findings.push(finding("P0", "GOLDEN-BASELINE-FROZEN", entityRef, "Baseline must be frozen with a valid timestamp"));
  if (!isObj(value.source) || !["repository-commit", "artifact", "approved-record"].includes(value.source.kind)
    || !text(value.source.locator).trim() || !shaRegex.test(text(value.source.digestSha256))) findings.push(finding("P0", "GOLDEN-BASELINE-SOURCE", `${entityRef}.source`, "Baseline requires traceable source, locator, and SHA-256"));
  if (!shaRegex.test(text(value.testsSha256)) || value.testsSha256 !== validatorReceiptSubject(tests)) findings.push(finding("P0", "GOLDEN-BASELINE-TESTS", `${entityRef}.testsSha256`, "Frozen tests digest does not match subject tests"));
  return findings;
}
function readValidationSubject(value, entityRef) {
  if (!isObj(value)) return { findings: [finding("P0", "VALIDATION-SUBJECT-REQUIRED", entityRef, "A validation subject is required")] };
  const findings = [];
  const allowed = new Set(["schemaVersion", "memberId", "chainId", "executedAt", "files", "artifactSha256", "validationRunId", "planId", "tests", "policy", "goldenBaseline", "contracts"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) findings.push(finding("P0", "VALIDATION-SUBJECT-FIELDS", entityRef, `Unknown fields: ${unknown.join(", ")}`));
  if (value.schemaVersion !== VALIDATION_SUBJECT_SCHEMA) findings.push(finding("P0", "VALIDATION-SUBJECT-SCHEMA", `${entityRef}.schemaVersion`, `Expected ${VALIDATION_SUBJECT_SCHEMA}`));
  if (!shaRegex.test(text(value.artifactSha256))) findings.push(finding("P0", "VALIDATION-SUBJECT-ARTIFACT", `${entityRef}.artifactSha256`, "artifactSha256 must be lowercase SHA-256"));
  for (const key of ["validationRunId", "planId"]) if (!idRegex.test(text(value[key]))) findings.push(finding("P0", "VALIDATION-SUBJECT-ID", `${entityRef}.${key}`, `${key} must be stable`));
  if (!Array.isArray(value.tests) || value.tests.length === 0) findings.push(finding("P0", "VALIDATION-SUBJECT-TESTS", `${entityRef}.tests`, "tests must be non-empty"));
  if (!isObj(value.policy) || !text(value.policy.command).trim() || !Number.isInteger(value.policy.requiredExitCode)) findings.push(finding("P0", "VALIDATION-SUBJECT-POLICY", `${entityRef}.policy`, "policy requires command and requiredExitCode"));
  const hardenedFields = ["memberId", "chainId", "executedAt", "files"];
  const hardened = hardenedFields.some((key) => value[key] !== undefined);
  if (hardened) {
    if (!memberRegex.test(text(value.memberId))) findings.push(finding("P0", "VALIDATION-SUBJECT-MEMBER", `${entityRef}.memberId`, "memberId must be a stable member identifier"));
    if (!chainRegex.test(text(value.chainId))) findings.push(finding("P0", "VALIDATION-SUBJECT-CHAIN", `${entityRef}.chainId`, "chainId must be a valid member chain identifier"));
    if (!Number.isFinite(Date.parse(text(value.executedAt)))) findings.push(finding("P0", "VALIDATION-SUBJECT-EXECUTED-AT", `${entityRef}.executedAt`, "executedAt must be a valid timestamp"));
    if (!Array.isArray(value.files) || value.files.length === 0) findings.push(finding("P0", "VALIDATION-SUBJECT-FILES", `${entityRef}.files`, "files must be a non-empty normalized manifest"));
    else {
      for (const [index, file] of value.files.entries()) {
        const path = text(file?.path);
        const normalized = path === path.normalize("NFC") && !/[\u0000-\u001f\u007f]/.test(path)
          && !path.startsWith("/") && !path.includes("\\")
          && path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
        if (!isObj(file) || !normalized || !shaRegex.test(text(file.sha256))) findings.push(finding("P0", "VALIDATION-SUBJECT-FILE", `${entityRef}.files[${index}]`, "Each file needs a normalized relative path and SHA-256"));
        if (index > 0 && text(value.files[index - 1]?.path) >= path) findings.push(finding("P0", "VALIDATION-SUBJECT-FILE-ORDER", `${entityRef}.files[${index}].path`, "File paths must be unique and sorted"));
      }
      if (!findings.some((item) => item.ruleId.startsWith("VALIDATION-SUBJECT-FILE"))
        && value.artifactSha256 !== validatorArtifactSubject(value.files)) findings.push(finding("P0", "VALIDATION-SUBJECT-ARTIFACT-MANIFEST", `${entityRef}.artifactSha256`, "Artifact digest does not match the file manifest"));
    }
  }
  if (hardened && (!isObj(value.contracts) || !isObj(value.contracts.aimlock))) findings.push(finding("P0", "VALIDATION-SUBJECT-SNAPSHOT", `${entityRef}.contracts.aimlock`, "Hardened validation requires an Aimlock snapshot binding"));
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
  if (Array.isArray(value.tests)) findings.push(...validateGoldenBaseline(value.goldenBaseline, `${entityRef}.goldenBaseline`, value.tests));
  try { canonicalJson(value); } catch (error) { findings.push(finding("P0", "VALIDATION-SUBJECT-JSON", entityRef, error instanceof Error ? error.message : "Invalid JSON")); }
  return findings.length ? { findings } : { value };
}
function expectedValidationSubject(input) {
  if (input.expectedSubject === undefined && input.validationContext === undefined) return readValidationSubject(undefined, "input.expectedSubject");
  const expected = input.expectedSubject === undefined ? null : readValidationSubject(input.expectedSubject, "input.expectedSubject");
  const context = input.validationContext === undefined ? null : readValidationSubject(input.validationContext, "input.validationContext");
  const findings = [...(expected?.findings ?? []), ...(context?.findings ?? [])];
  if (findings.length) return { findings };
  const value = expected?.value ?? context.value;
  const digest = validatorReceiptSubject(value);
  if (expected?.value && context?.value && digest !== validatorReceiptSubject(context.value)) return { findings: [finding("P0", "VALIDATION-SUBJECT-CONFLICT", "input.validationContext", "Targets differ")] };
  return { value, digest };
}

function configuredReceiptKey() {
  const encoded = text(process.env[RECEIPT_PUBLIC_KEY_ENV]).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const der = Buffer.from(encoded, "base64");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? { key, keyId: createHash("sha256").update(der).digest("hex") } : null;
  } catch { return null; }
}
function verifiedReceipt(receipt, subjectDigest, subject) {
  const configured = configuredReceiptKey();
  if (!configured || !isObj(receipt) || receipt.schemaVersion !== RECEIPT_SCHEMA) return null;
  const result = receipt.result;
  const issuedAt = Date.parse(text(receipt.issuedAt));
  const expiresAt = Date.parse(text(receipt.expiresAt));
  const executedAt = subject.executedAt === undefined ? null : Date.parse(text(subject.executedAt));
  const now = Date.now();
  if (receipt.keyId !== configured.keyId || receipt.subjectDigest !== subjectDigest || !idRegex.test(text(receipt.nonce))
    || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + 60_000 || expiresAt <= now
    || (executedAt !== null && (!Number.isFinite(executedAt) || executedAt > issuedAt
      || issuedAt - executedAt > MAX_RECEIPT_LIFETIME_MS))
    || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_RECEIPT_LIFETIME_MS || !isObj(result)
    || result.runner !== "trusted-runner" || typeof result.passed !== "boolean" || !Number.isInteger(result.exitCode)
    || typeof result.durationMs !== "number" || result.durationMs < 0 || !text(result.summary).trim()) return null;
  try {
    const signature = Buffer.from(text(receipt.signature), "base64url");
    return verifySignature(null, Buffer.from(validatorReceiptPayload(receipt)), configured.key, signature) ? receipt : null;
  } catch { return null; }
}
function createTestEvidence(receipt, subject, subjectDigest, index) {
  return { schemaVersion: TEST_EVIDENCE_SCHEMA, evidenceId: `${subject.validationRunId}:${index}`, kind: "test",
    runner: "trusted-runner", command: subject.policy.command, exitCode: receipt.result.exitCode,
    durationMs: receipt.result.durationMs, summary: receipt.result.summary, artifactSha256: subject.artifactSha256,
    subject, subjectDigest, receipt };
}
function evidenceState(evidence, subject, subjectDigest) {
  if (!isObj(evidence) || evidence.schemaVersion !== TEST_EVIDENCE_SCHEMA || evidence.runner === "local") return "unverifiable";
  let evidenceDigest;
  try { evidenceDigest = validatorReceiptSubject(evidence.subject); } catch { return "unverifiable"; }
  if (!idRegex.test(text(evidence.evidenceId)) || !["test", "build", "lint", "security", "benchmark"].includes(evidence.kind)
    || evidence.runner !== "trusted-runner" || evidence.command !== subject.policy.command
    || evidence.artifactSha256 !== subject.artifactSha256 || evidence.subjectDigest !== subjectDigest
    || !isObj(evidence.subject) || evidenceDigest !== subjectDigest) return "unverifiable";
  const receipt = verifiedReceipt(evidence.receipt, subjectDigest, subject);
  if (!receipt || evidence.exitCode !== receipt.result.exitCode || evidence.durationMs !== receipt.result.durationMs
    || evidence.summary !== receipt.result.summary) return "unverifiable";
  return receipt.result.passed && receipt.result.exitCode === subject.policy.requiredExitCode ? "valid" : "failed";
}

const DEFAULT_SECURITY_RULES = [
  { id: "SEC-EVAL", pattern: /\beval\s*\(|new\s+Function\b|\bFunction\s*\(/g, severity: "P0", fix: "Use controlled AST evaluation", executableOnly: true },
  { id: "SEC-SECRETS", pattern: /(?:api[_-]?key|token|password|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{8,}/gi, severity: "P0", fix: "Remove hardcoded credentials" },
  { id: "SEC-SQLI", pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s+.*\+\s*(?:req\.|input\.|params\.)/gi, severity: "P0", fix: "Use parameterized queries" },
  { id: "SEC-XSS", pattern: /innerHTML\s*=\s*(?!\s*['"`]\s*['"`])/g, severity: "P1", fix: "Use sanitized output" },
];
const DEFAULT_STRUCTURE_RULES = ["references-closed", "required-fields", "type-correct", "no-cycle"];
function executableJavaScript(path) { return /\.(?:[cm]?[jt]sx?)$/i.test(path); }
function stripJavaScriptInertText(source) {
  let output = "";
  let state = "code";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (character === "\n") { state = "code"; output += "\n"; }
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") { state = "code"; index += 1; }
      else if (character === "\n") output += "\n";
      continue;
    }
    if (state === "string") {
      if (character === "\\") { index += 1; continue; }
      if (character === quote) { state = "code"; quote = ""; }
      else if (character === "\n") output += "\n";
      continue;
    }
    if (character === "/" && next === "/") { state = "line"; index += 1; continue; }
    if (character === "/" && next === "*") { state = "block"; index += 1; continue; }
    if (["'", '"', "`"].includes(character)) { state = "string"; quote = character; continue; }
    output += character;
  }
  return output;
}
function runSecurityScan(files, rules = DEFAULT_SECURITY_RULES) {
  const findings = [];
  for (const file of files) for (const rule of rules) {
    const path = text(file.path);
    const content = rule.executableOnly
      ? executableJavaScript(path) ? stripJavaScriptInertText(text(file.content)) : ""
      : text(file.content);
    const matches = content.match(rule.pattern instanceof RegExp ? rule.pattern : new RegExp(rule.pattern, "g"));
    if (matches) findings.push(finding(rule.severity, rule.id, text(file.path), `${matches.length} match(es): ${rule.fix}`, { sample: matches[0] }));
  }
  return findings;
}
function runStructureValidation(files) {
  const findings = [];
  for (const file of files) {
    const path = text(file.path);
    if (path.endsWith(".json")) try { JSON.parse(text(file.content)); } catch (error) { findings.push(finding("P0", "STR-JSON", path, error.message)); }
    if (file.schema && path.endsWith(".json")) try {
      const data = JSON.parse(text(file.content));
      for (const field of file.schema.required ?? []) if (data[field] === undefined) findings.push(finding("P0", "STR-REQ", `${path}.${field}`, "Required field is missing"));
    } catch { /* invalid JSON is reported above */ }
  }
  return findings;
}
function validateReq(request) {
  const findings = [];
  if (!isObj(request)) return [finding("P0", "REQ_OBJECT", "request", "request must be an object")];
  if (request.schemaVersion !== REQ) findings.push(finding("P0", "REQ_SCHEMA", "request.schemaVersion", `Expected ${REQ}`));
  if (!text(request.requestId).trim()) findings.push(finding("P0", "REQ_FIELD", "request.requestId", "requestId is required"));
  if (!OPS.includes(request.operation)) findings.push(finding("P0", "REQ_OPERATION", "request.operation", "operation is unsupported"));
  if (!isObj(request.input)) findings.push(finding("P0", "REQ_INPUT", "request.input", "input must be an object"));
  return findings;
}
function severitySummary(findings) {
  return { total: findings.length, p0: findings.filter((item) => item.severity === "P0").length,
    p1: findings.filter((item) => item.severity === "P1").length,
    p2: findings.filter((item) => item.severity === "P2").length };
}
const REPAIR_ROUTES = Object.freeze([
  { category: "structure-schema", skill: "blueprint", action: "recompile-contract", trigger: "structure or schema mismatch", requiresHumanConfirmation: false },
  { category: "formula-calculation", skill: "calctool", action: "repair-formula-engine", trigger: "formula or calculation mismatch", requiresHumanConfirmation: false },
  { category: "scope-drift", skill: "aimlock", action: "relock-scope", trigger: "scope contract violation", requiresHumanConfirmation: false },
  { category: "execution-dispatch", skill: "swarm", action: "repair-dispatch", trigger: "execution or dispatch failure", requiresHumanConfirmation: false },
  { category: "validator-self", skill: "validator", action: "propose-validator-patch", trigger: "Validator rule or engine defect", requiresHumanConfirmation: true },
]);

function runMeta(requestId, operation) {
  const operationStatus = { implementedPure: [...PURE], localRunnerRequired: [...LOCAL_ONLY], planned: ["mutation-testing"] };
  const goldenPathExample = { operation: "functional-verify", input: { validationContext: "frozen ValidationSubject", receipts: "signed trusted-runner receipt[]" }, next: "verdict with cli.tax.test-evidence/1.0" };
  if (operation === "capabilities") return ok(requestId, { capabilities: { pure: false, stateless: true, operationStatus,
    verdictLevels: ["pass", "pass-with-risk", "blocked", "incomplete"], testEvidenceSchema: TEST_EVIDENCE_SCHEMA,
    goldenBaselineSchema: GOLDEN_BASELINE_SCHEMA, catalogSchema: CATALOG_SCHEMA }, operationSchemas: SCHEMAS,
    goldenPathExample, skill: { name: NAME, version: COMPILER_VERSION }, nextStep: { operation: "intake", instruction: "Collect validation requirements." } });
  return ok(requestId, { help: { name: NAME, version: COMPILER_VERSION, operations: CATALOG, operationStatus, goldenPathExample },
    operationSchemas: SCHEMAS, nextStep: { operation: "intake", instruction: "Collect validation requirements." } });
}
function runPlanning(requestId, operation, input) {
  if (operation === "intake") {
    const goal = requiredText(input, "goal");
    const risk = requiredText(input, "riskLevel");
    if (goal.error || risk.error) return blocked(requestId, [goal.error, risk.error].filter(Boolean));
    if (!["low", "medium", "high"].includes(risk.value)) return blocked(requestId, [finding("P0", "RISK-LEVEL", "input.riskLevel", "riskLevel must be low, medium, or high")]);
    return ok(requestId, { intake: { goal: goal.value, riskLevel: risk.value, complianceReqs: input.complianceReqs, targetFiles: input.targetFiles }, nextStep: { operation: "plan", instruction: "Generate validation plan." } });
  }
  const risk = text(input.intakeResult?.riskLevel);
  if (!["low", "medium", "high"].includes(risk)) return blocked(requestId, [finding("P0", "INTAKE-RESULT", "input.intakeResult", "A valid intakeResult is required")]);
  const modules = ["validate-structure", "security-scan", "functional-verify"];
  if (risk === "high") modules.push("compliance-audit", "sandbox-run", "intrusive-test");
  else modules.push("fuzz-input");
  modules.push("perf-benchmark", "verdict");
  const available = Array.isArray(input.availableSkills) ? input.availableSkills : [];
  const requestedCategories = Array.isArray(input.findingCategories) ? input.findingCategories : [];
  const invalidCategory = requestedCategories.find((category) => !REPAIR_ROUTES.some((route) => route.category === category));
  if (invalidCategory) return blocked(requestId, [finding("P0", "REPAIR-CATEGORY", "input.findingCategories", `Unsupported repair category: ${invalidCategory}`)]);
  const selectedRoutes = requestedCategories.length
    ? REPAIR_ROUTES.filter((route) => requestedCategories.includes(route.category)) : REPAIR_ROUTES;
  const routing = selectedRoutes.map((route) => ({
    ...route,
    available: route.skill === "validator" || available.includes(route.skill),
    invoke: route.skill !== "validator" && available.includes(route.skill),
  }));
  return ok(requestId, { plan: { modules, routing, routingPolicy: "deterministic-category-map",
    riskLevel: risk, totalSteps: modules.length }, nextStep: { operation: modules[0], instruction: `Execute ${modules[0]}.` } });
}
function runStatic(requestId, operation, input) {
  const files = requiredArray(input, "files", 1);
  if (files.error) return blocked(requestId, [files.error]);
  if (operation === "validate-structure") {
    const findings = runStructureValidation(files.value);
    return ok(requestId, { findings, summary: severitySummary(findings), line: "static", nextStep: { operation: "security-scan", instruction: "Run security scan." } });
  }
  if (operation === "security-scan") {
    const findings = runSecurityScan(files.value, input.rules);
    return ok(requestId, { findings, summary: severitySummary(findings), line: "static", nextStep: { operation: "functional-verify", instruction: "Run frozen golden baseline." } });
  }
  const template = requiredText(input, "template");
  if (template.error) return blocked(requestId, [template.error]);
  const findings = files.value.flatMap((file) => text(file.content).includes("0.0.0.0") ? [finding("P1", "COMP-PORT", text(file.path), "Public bind requires review")] : []);
  return ok(requestId, { findings, template: template.value, nextStep: { operation: "functional-verify", instruction: "Run frozen golden baseline." } });
}
function runFunctional(requestId, input) {
  const subject = readValidationSubject(input.validationContext, "input.validationContext");
  if (subject.findings) return blocked(requestId, subject.findings);
  const receipts = requiredArray(input, "receipts", 1);
  if (receipts.error) return blocked(requestId, [finding("P0", "TRUSTED-RECEIPT-REQUIRED", "input.receipts", "Signed trusted-runner receipts are required")]);
  const subjectDigest = validatorReceiptSubject(subject.value);
  const verified = receipts.value.map((receipt) => verifiedReceipt(receipt, subjectDigest, subject.value));
  if (verified.some((receipt) => receipt === null)) return blocked(requestId, [finding("P0", "INVALID-EXECUTION-RECEIPT", "input.receipts", "Receipt signature, lifetime, result, or subject is invalid")]);
  const results = verified.map((receipt) => receipt.result);
  const findings = results.flatMap((result, index) => result.passed && result.exitCode === subject.value.policy.requiredExitCode ? [] : [finding("P1", "GOLDEN-FAIL", `receipt:${index}`, "Frozen golden baseline failed", result)]);
  const evidence = verified.map((receipt, index) => createTestEvidence(receipt, subject.value, subjectDigest, index));
  return ok(requestId, { subject: subject.value, subjectDigest, results,
    summary: { total: results.length, passed: results.length - findings.length, failed: findings.length },
    runner: "trusted-runner", findings, evidence, nextStep: { operation: "verdict", instruction: "Render verdict from TestEvidence." } });
}

function runLocalProtocol(requestId, operation, input) {
  if (operation === "intrusive-test" && input.authorization !== true) return blocked(requestId, [finding("P0", "INTRUSIVE-NO-AUTH", "input.authorization", "Explicit authorization is required")]);
  const descriptor = operation === "fuzz-input" ? requiredText(input, "targetFile") : requiredText(input, "command");
  if (descriptor.error && operation !== "intrusive-test") return blocked(requestId, [descriptor.error]);
  const pending = { operation, status: "pending-execution", requestedTarget: descriptor.value };
  const key = operation === "sandbox-run" ? "sandbox" : operation === "fuzz-input" ? "fuzz"
    : operation === "perf-benchmark" ? "benchmark" : "intrusive";
  return ok(requestId, { [key]: pending, runner: "local-only", evidence: [],
    pendingEvidenceRequirements: { schemaVersion: TEST_EVIDENCE_SCHEMA, trustedReceiptRequiredForFinalPass: true },
    nextStep: { operation: "verdict", instruction: "Local runner must return signed TestEvidence; pending is incomplete." } });
}
function validRiskLedger(findings, ledger) {
  if (!Array.isArray(ledger)) return false;
  return findings.filter((item) => item.severity === "P1").every((item) => ledger.some((entry) => isObj(entry)
    && idRegex.test(text(entry.riskId)) && entry.findingRuleId === item.ruleId
    && entry.findingEntityRef === item.entityRef
    && idRegex.test(text(entry.owner)) && text(entry.mitigation).trim()
    && idRegex.test(text(entry.acceptedBy)) && Number.isFinite(Date.parse(text(entry.acceptedAt)))));
}
function runVerdict(requestId, input) {
  const expected = expectedValidationSubject(input);
  if (expected.findings) return blocked(requestId, expected.findings);
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const states = evidence.map((item) => evidenceState(item, expected.value, expected.digest));
  const failedCount = states.filter((state) => state === "failed").length;
  const p0 = findings.filter((item) => item.severity === "P0").length;
  const p1 = findings.filter((item) => item.severity === "P1").length;
  const allValid = states.length > 0 && states.every((state) => state === "valid");
  const riskLedgerValid = p1 === 0 || validRiskLedger(findings, input.riskLedger);
  const level = p0 > 0 || failedCount > 0 ? "blocked"
    : !allValid || !riskLedgerValid ? "incomplete" : p1 > 0 ? "pass-with-risk" : "pass";
  const report = { verdict: level, subjectDigest: expected.digest, findings: severitySummary(findings),
    evidenceCount: evidence.length, evidenceValid: allValid,
    evidenceSummary: { valid: states.filter((state) => state === "valid").length, failed: failedCount,
      pending: 0, unverifiable: states.filter((state) => state === "unverifiable").length },
    riskLedgerValid, riskLedger: input.riskLedger };
  return ok(requestId, { report, findings, evidence,
    nextStep: level === "blocked" ? { operation: "plan", instruction: "Repair blocking failures." }
      : level === "incomplete" ? { operation: "verdict", instruction: "Provide trusted evidence and complete P1 risk ledger." }
        : { operation: null, instruction: `Verdict: ${level}.` } });
}

export async function run(request) {
  const validationFindings = validateReq(request);
  if (validationFindings.length) return { ...blocked(request?.requestId ?? "unknown", validationFindings), errorSchema: ERR };
  const { requestId, operation, input } = request;
  if (operation === "capabilities" || operation === "help") return runMeta(requestId, operation);
  if (operation === "intake" || operation === "plan") return runPlanning(requestId, operation, input);
  if (["validate-structure", "security-scan", "compliance-audit"].includes(operation)) return runStatic(requestId, operation, input);
  if (operation === "functional-verify") return runFunctional(requestId, input);
  if (LOCAL_ONLY.has(operation)) return runLocalProtocol(requestId, operation, input);
  if (operation === "verdict") return runVerdict(requestId, input);
  return failed(requestId, "UNSUPPORTED_OPERATION", `Unsupported operation: ${operation}`);
}

export { COMPILER_VERSION, NAME, OPS, PURE, CATALOG, SCHEMAS, GOLDEN_BASELINE_SCHEMA,
  TEST_EVIDENCE_SCHEMA, DEFAULT_SECURITY_RULES, DEFAULT_STRUCTURE_RULES,
  runSecurityScan, runStructureValidation };
