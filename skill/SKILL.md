---
name: validator
description: '交付前质量门禁：三道防线（静态/动态/对抗）递进验证，黄金基准对抗大模型漂移，执行证据杜绝自报伪造，终审裁决分级放行。'
---

# Validator

Package version: v7.0.39

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
- broker 默认读取账号共享凭据文件；显式 `CLITAX_BRAIN_CLIENT_TOKEN_FILE` 使用绝对路径覆盖；macOS/Linux 文件必须为当前 broker 账户所有且权限 `0600`，Windows 文件必须位于受限 `%LOCALAPPDATA%\CLI.Tax\broker` 目录。
- broker 只需要 Brain Client HTTPS、受限身份文件和调用方显式传入的路径，本身不需要完整磁盘访问。若要保证 IDE 无法读取身份文件，必须把 broker 放进独立低权限系统账户或沙箱服务，并只暴露受限 IPC；broker 与 IDE 同账户运行时，`0600` 不能隔离二者，禁止声称令牌已隔离。
- broker 只用 `Authorization: BrainClient …` 发起一次 runtime 请求。HTTP 成功后必须保留响应顶层原始 `feedbackReceiptId`、`feedbackInvocationId` 和 `feedbackEvaluation.digest`，不得生成、猜测、复用或跨调用转移。
- Brain Client 服务端必须严格绑定请求/响应的 `requestId` 和 `schemaVersion`，再根据真实状态、验证结果、服务端耗时与 findings 生成并持久化权威评分、评语和摘要。broker 不得生成分数或评语。
- 同一次 runtime 请求在服务端事务内生成并持久化评价，再返回 `feedbackReceiptId`、`feedbackInvocationId` 和权威摘要；broker 只验证已提交回执，不发起第二次评价写入。`not-reported`、验证不完整、P0/P1 findings、`blocked` 或 `failed` 都不得生成好评。
- 缺少凭证或 ID、身份不匹配、摘要不匹配、响应非法以及任何 HTTP 失败都必须显式失败，不得静默、不重试成重复评价。
- 本地 CLI 不提供手工评分或评语提交命令，人类不得选择技能分数或填写技能评价；日常聊天不属于评价协议。

调用示例：`npx cli-validator@latest invoke <operation> '<JSON对象>'`。IDE 集成可向 `npx cli-validator@latest broker` 的 stdin 发送 `{"operation":"capabilities","input":{}}`。

## 本地受限执行器

先运行 `cli-validator local capabilities` 读取输入合同与限额，再以 JSON stdin 调用 `cli-validator local run-approved-plan`。输入必须完整包含 `repositoryRoot`（绝对目录）、`planPath`（工作区相对路径）、`approvalPath`（外部绝对路径）与 `signerConfigPath`（外部绝对路径或显式 null）。

冻结计划采用 `validator.execution-plan/1.0`：frozen=true，planId/validationRunId/memberId/chainId，排序且唯一的 files[{path,sha256}] 与 artifactSha256，tests[{testId,path}]，GoldenBaseline 与 Aimlock 合同。policy 明确 executable（绝对真实文件）及 executableSha256、args、environment 字符串字典、timeoutMs、maxOutputBytes、requiredExitCode=0。每个测试文件必须列入 manifest 并作为真实命令参数传入；组合测试可使用受审计的入口脚本，不能把未执行文件假报为测试。执行前后校验产物、计划、可执行文件与外部授权。

外部授权为 `validator.runner-approval/1.0`，包含 repositoryRoot、planSha256（冻结计划文件原始字节 SHA-256）、approvedBy、approvedAt、expiresAt，最长 24 小时。文件必须归执行账户所有、0600、非符号链接且位于被测工作区之外。它记录外部批准；智能体不得伪造批准或用测试 fixture 授权真实工作。

未配置 signer 时只返回 local TestEvidence，独立终审仍为 incomplete。可选 `validator.runner-signer/1.0` 配置包含外置 privateKeyPath、keyId（Ed25519 SPKI DER SHA-256）、receiptTtlMs（最长 10 分钟）；配置和私钥同样必须为外部 0600 文件。签名绑定 subject、退出结果与日志指纹，消费方使用已配置公钥核验。密钥配置不是进程隔离：同 UID 子进程可能读取同账户文件，生产可信服务仍须独立 UID/容器及权限隔离；本工具不自动部署隔离、不创建可信密钥，也不改变验证器的信任配置。

本地运行仅支持 POSIX；无 shell、显式子进程环境、受限输出与时限。信号终止保留 exitCode=null，不制造整数退出码或成功 receipt。超时、输出超限、非零退出或运行中完整性变化均失败；原始执行记录与日志摘要可审计。此进程执行器不是 OS 沙箱，不授予任意磁盘或网络访问。

## 网络中断与原回执恢复

仅在 TLS 握手前确定尚未发送 HTTP 请求时，broker 才允许最多 3 次连接尝试，并受总超时约束。请求发出后发生断线或响应中断，只用 GET 查询原 requestId 的服务端回执，禁止重发 POST；未取得有效回执时保留不确定状态，不得假定成功或继续依赖步骤。

`npx cli-validator@latest recover <operation> <requestId>` 可重新查询原调用，不会重做操作或重复计费。链恢复不会跳过人工确认，也不会自动重跑结果不确定的本地命令。代理连接需 Node.js 22.21+ 或 24.5+；不支持的运行时会明确报错。

## 执行完整性共同规则

1. 工程目标、已接受范围和验收项必须持久化；新增需求先路由与合并，不能覆盖原目标。子任务有明确服务目标的理由，执行仅用本链已匹配技能。每次恢复读取 task-resume，核对剩余项、pending请求和continuationNotifications。
2. 默认由主代理完成工作，禁止为了省事创建子代理、把简单查找/改名/少量修改/单条命令/例行检查/汇总交接给多智能体，禁止为达到门槛拆分或夸大任务。启用Aimlock或Swarm模式不是创建授权，管理/运维/安全/协调是主代理职责，不额外创建常驻智能体。只有业务确需独立且实质性的交付、主代理同时有可推进的独立工作、预期收益严格高于上下文传递/协调/验收成本时才派单；复用已有合适负责人，用户禁止委派时不得创建。每次创建前记录业务理由、交付物、验收项、主代理工作、成本收益、精确路径和原负责人；只创建当前需要的最少数量，不预建空闲角色，不递归扩编或重复扫描。规模门槛200行/3文件/跨模块仅为必要条件，不能单独证明值得委派。主代理负责整合和完整验收，不把半成品当完成；预算抱怨不是停止指令。
3. 自报、回复送达和动作完成不等于工程交付验证。reported始终待验收；Swarm接受工程任务时复用Validator校验签名、有效期、计划/产物/任务绑定。无证据、伪造runner或失败检查不得成为绿色完成。
4. 原任务交接前保存检查点并释放旧锁；回程只发持久通知，宿主消费后重新核验基线、快照与写入权限。历史恢复结果不是新授权。技能不能自行唤醒未接入的IDE。
5. 心跳停止仅允许自动回收尚未开工的assigned任务；claimed/running进入执行结果待核对状态，禁止盲目重复执行。已回传、已验收、失败和取消任务不会被自动重派。服务器停滞回收同时保存会员通知，对话界面定期读取展示。
6. 预计长任务在预算初始化后、深读前提出一次精确自动续时策略；只有真实授权才自动续时。时间、文件数、token和写入权限分别计量；额度/次数耗尽、撤销和完成必须明确停止并说明下一步。读取预算不是付费充值，计时器由宿主运行。
7. 云端沙箱开关按调用会员读取；关闭时仅允许当前受审官方源码摘要在受控worker中直接执行，并记录executionIsolation。未知或修改过的源码明确要求sandbox，不伪造隔离结果；worker直接执行不是OS沙箱。
8. 使用技能前检查官方发布版本并自动升级可管理的安装副本与客户端；配置失败或升级失败停止并报告。通过configure的JSON标准输入导入一次账号凭据，后续项目/分支/任务共享；密钥不进入源码、URL或命令参数。显式环境覆盖必须是绝对路径。网页复制在点击时获取当前凭据，页面仅展示无密钥地址；已撤销密钥没有权限自动获取新密钥，需已认证网页重新同步一次。

English: keep simple work with the main agent. Delegate only substantial independent business deliverables when benefits exceed coordination costs; use the fewest needed agents, never create idle management agents. Enabling Aimlock does not authorize delegation. Finish all authorized work; a cost complaint is not a stop request. Preserve the original goal; verify execution evidence; resume from durable checkpoints; never replay uncertain side effects. Read-time renewal requires bounded approval. Reuse account credentials and check managed skill updates before use; revoked credentials require an authenticated refresh.

Русский: сохраняйте исходную цель, проверяйте доказательства выполнения и возобновляйте работу из сохранённой точки. Не повторяйте операции с неизвестным результатом. Продление чтения требует ограниченного разрешения; ключи учётной записи используются повторно, обновления навыков проверяются перед вызовом.

## 账号共享凭据与自动更新

在已登录的能力市场复制安装入口，将内容粘贴给 IDE。页面只展示原地址，剪贴板会携带当前账号凭据。IDE 将四字段凭据 JSON 经标准输入交给 `npx cli-aimlock@latest configure`；不要放到命令参数、项目文件或日志中。一次配置供同一操作系统账号的所有项目、分支和任务使用，八个技能共享同一文件。

默认位置：macOS 为 `~/Library/Application Support/CLI.Tax/broker/credential.json`，Linux 为 `~/.local/share/CLI.Tax/broker/credential.json`，Windows 为 `%LOCALAPPDATA%\CLI.Tax\broker\credential.json`。显式 `CLITAX_BRAIN_CLIENT_TOKEN_FILE` 仍按绝对路径覆盖默认位置；迁移旧 IDE 配置时移除其过时覆盖，再使用账号共享文件。macOS/Linux 校验当前账号所有权和0600权限；Windows校验仅当前账号与SYSTEM可访问的ACL。

每次新技能调用先查询官方发布版本，精确版本下载并校验身份后自动使用；更新已托管的当前项目与账号技能目录，失败恢复旧目录，禁止覆盖 Git 跟踪源码或未托管内容。升级返回 `upgrade.reloadRequired` 和说明路径时，IDE 应读取更新后的 SKILL.md、核对本任务合同再继续。install/check同样自动更新，不需要每次人工发升级指令。查询不确定调用的原回执不升级、不重发操作。

升级不会清除账号凭据；各调用重新读取共享文件，因此重新同步一次密钥后所有任务使用新值。已撤销或失效的密钥不能为自己取得新权限，必须从已认证网页重新同步一次。两个不同操作系统账号不共享私密文件。

English: configure once using JSON stdin; all tasks under the same OS account reuse the credential. Each new invocation checks and updates the official package and managed documentation. Reload updated instructions when indicated. Revoked keys require a fresh authenticated copy.

Русский: настройте ключ один раз через JSON stdin для всех задач пользователя ОС. Перед новым вызовом пакет и управляемые инструкции обновляются автоматически. Отозванный ключ требует повторной синхронизации с авторизованной страницы.
