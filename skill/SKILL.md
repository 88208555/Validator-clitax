---
name: validator
description: '交付前质量门禁：三道防线（静态/动态/对抗）递进验证，黄金基准对抗大模型漂移，执行证据杜绝自报伪造，终审裁决分级放行。'
---

# Validator

Package version: v7.0.31

Validator 是技能链最后一站，只消费冻结目标和真实执行证据；模型解释没有裁判权。

## V1–V6 能力状态

| 编号 | 状态 | 当前边界 |
|---|---|---|
| V1 完整 JSON Schema | 已实现 | `capabilities.operationSchemas` 为 Draft 2020-12 兼容对象结构，不返回伪类型字符串 |
| V2 GoldenBaseline | 已实现 | 必须提供来源种类、定位符、来源 SHA-256、版本、冻结人、冻结时间和测试集 SHA-256 |
| V3 TestEvidence | 已实现 | 统一为 `cli.tax.test-evidence/1.0`；独立终审只信任 Ed25519 签名的 trusted-runner receipt |
| V4 技能桥协议 | 已实现（协议级） | 接收 Aimlock 合同摘要与 Blueprint 验收报告摘要；不主动访问其网络端点 |
| V5 本地/远端边界 | 已实现 | 静态扫描和签名验证可纯执行；沙箱、fuzz、性能、侵入测试仅返回 `pending-execution`，必须由本地 runner 执行 |
| V6 黄金路径 | 已实现 | 下方示例覆盖冻结、执行、TestEvidence、终审四步 |
| 确定性返工路由 | 已实现 | structure/schema→Blueprint、formula/calculation→Calctool、scope drift→Aimlock、execution/dispatch→Swarm；Validator 自身缺陷只生成补丁提议并要求人工确认 |
| mutation testing | 规划中 | 当前不得声称已执行或作为通过证据 |

## 强制调用顺序

1. 先调用 `capabilities` 并读取每个操作的真实 JSON Schema 与 `operationStatus`。
2. `intake → plan` 明确风险和验证模块。
3. 静态防线执行 `validate-structure / security-scan / compliance-audit`。
4. 动态防线先冻结 GoldenBaseline，再由可信 runner 执行并签署 receipt。
5. `functional-verify` 把 receipt 规范化为 TestEvidence，最后调用 `verdict`。

## 冻结目标合同

`validator.validation-subject/1.0` 必须绑定：

- 交付物 `artifactSha256`、`validationRunId`、`planId`；
- 非空 tests 与包含 `command + requiredExitCode` 的 policy；
- `validator.golden-baseline/1.0`，其中 `testsSha256` 必须等于 tests 的规范 JSON SHA-256；
- 可选 `contracts.aimlock`（goalId、scopeContractSha256、snapshotSha256）和
  `contracts.blueprint`（blueprintId、acceptanceReportSha256）、
  `contracts.archguard`（contractSha256、ledgerSha256、driftStatus）。桥字段一旦出现就必须完整且摘要合法；ArchGuard 红灯不得被 Validator 放行。

GoldenBaseline 只有 `frozen: true` 才有效。来源只允许 `repository-commit / artifact / approved-record`，且必须提供可追溯 locator 和 SHA-256。修改 tests 后必须生成新基线版本，不得沿用旧摘要。

## 统一 TestEvidence

基础字段固定为：`schemaVersion`、稳定 `evidenceId`、`kind`、`runner`、`command`、整数 `exitCode`、非负 `durationMs`、`summary`；可携带 `artifactSha256`、subject、subjectDigest、receipt。

- `runner: local` 只是执行记录，Validator 独立终审中最高只能 `incomplete`。
- `runner: trusted-runner` 仍不足以自证；receipt 必须通过配置公钥的 Ed25519 验签、有效期、subject digest 和结果字段交叉校验。
- pending、缺字段、签名错误、跨工件/跨测试/跨 policy/跨 run 重放均不可通过。
- 任何失败 receipt 或非预期 exit code 均 `blocked`。

## 裁决规则

| 结果 | 确定性条件 |
|---|---|
| `pass` | 无 P0/P1，且至少一份 TestEvidence 全部可信有效 |
| `pass-with-risk` | 无 P0，存在 P1，证据有效，且每个 P1 都有完整风险台账 |
| `blocked` | 存在 P0，或可信执行证据显示失败 |
| `incomplete` | 无证据、pending、local 自报、不可验签，或 P1 风险台账不完整 |

风险台账每项至少包含稳定 riskId、对应 findingRuleId 与 findingEntityRef、owner、mitigation、acceptedBy、acceptedAt。每个 P1 finding 都必须按 ruleId + entityRef 独立覆盖；缺任一项不得 `pass-with-risk`。

## 黄金路径示例

```json
{
  "schemaVersion": "validator.validation-subject/1.0",
  "artifactSha256": "<64 lowercase hex>",
  "validationRunId": "release-20260823",
  "planId": "blueprint-release-20260823",
  "tests": [{ "name": "pnpm-test", "expectedExitCode": 0 }],
  "policy": { "command": "pnpm test", "requiredExitCode": 0 },
  "goldenBaseline": {
    "schemaVersion": "validator.golden-baseline/1.0",
    "baselineId": "release-golden-1",
    "source": { "kind": "repository-commit", "locator": "git:<commit>", "digestSha256": "<64 lowercase hex>" },
    "version": "v1.0.0",
    "frozen": true,
    "frozenAt": "2026-08-23T00:00:00.000Z",
    "frozenBy": "release-owner",
    "testsSha256": "<canonical tests SHA-256>"
  }
}
```

可信 runner 对完整 subject digest 签署 execution receipt；`functional-verify` 验签后输出 `cli.tax.test-evidence/1.0`；`verdict` 再按上述规则裁决。没有 runner 时应停在 `pending-execution → incomplete`，不得生成假 evidence。

## 技能边界

- Aimlock 管改前范围和快照，Validator 只校验摘要与交付物，不替代 mutate-gate。
- Blueprint 产出 acceptance report；Validator 将其摘要绑定到 subject 并独立执行验收。
- Swarm 只转运 TestEvidence 和返工任务，不能把 worker 自报提升为终审证据。
- Calctool final-gate 是生成方自检，Validator 仍要求独立可信 receipt。

## 受限调用与自动评价闭环

- IDE / 智能体必须通过本包 `invoke` 或 JSON-stdin `broker` 调用，不得直接拼装技能 HTTP 请求，也不得读取 BrainClient token。
- broker 从 `CLITAX_BRAIN_CLIENT_TOKEN_FILE` 读取身份；macOS/Linux 文件必须为当前 broker 账户所有且权限 `0600`，Windows 文件必须位于受限 `%LOCALAPPDATA%\CLI.Tax\broker` 目录。
- broker 只需要 Brain Client HTTPS、受限身份文件和调用方显式传入的路径，本身不需要完整磁盘访问。若要保证 IDE 无法读取身份文件，必须把 broker 放进独立低权限系统账户或沙箱服务，并只暴露受限 IPC；broker 与 IDE 同账户运行时，`0600` 不能隔离二者，禁止声称令牌已隔离。
- broker 只用 `Authorization: BrainClient …` 发起一次 runtime 请求。HTTP 成功后必须保留响应顶层原始 `feedbackReceiptId`、`feedbackInvocationId` 和 `feedbackEvaluation.digest`，不得生成、猜测、复用或跨调用转移。
- Brain Client 服务端必须严格绑定请求/响应的 `requestId` 和 `schemaVersion`，再根据真实状态、验证结果、服务端耗时与 findings 生成并持久化权威评分、评语和摘要。broker 不得生成分数或评语。
- 同一次 runtime 请求在服务端事务内生成并持久化评价，再返回 `feedbackReceiptId`、`feedbackInvocationId` 和权威摘要；broker 只验证已提交回执，不发起第二次评价写入。`not-reported`、验证不完整、P0/P1 findings、`blocked` 或 `failed` 都不得生成好评。
- 缺少凭证或 ID、身份不匹配、摘要不匹配、响应非法以及任何 HTTP 失败都必须显式失败，不得静默、不重试成重复评价。
- 本地 CLI 不提供手工评分或评语提交命令，人类不得选择技能分数或填写技能评价；日常聊天不属于评价协议。

调用示例：`npx cli-validator@latest invoke <operation> '<JSON对象>'`。IDE 集成可向 `npx cli-validator@latest broker` 的 stdin 发送 `{"operation":"capabilities","input":{}}`。
