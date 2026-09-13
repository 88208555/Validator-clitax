# cli-validator

从 CLI.Tax 安装并运行 Validator 技能：交付前质量门禁——三道防线递进验证，黄金基准对抗大模型漂移，终审裁决分级放行。

```bash
npx cli-validator@latest install
```


也可以直接从 CLI.Tax 对象存储安装（与站点「安装命令」一致）：

```bash
npx https://cli.tax/cli-downloads/clitax-Xx9ZkQmW3p.tgz install
```

Source: https://github.com/88208555/Validator-clitax.git

`validator.skill.request/1.0` 协议，端点 `https://cli.tax/Xx9ZkQmW3p`。

## 受限调用与自动评价

使用 `npx cli-validator@latest invoke <operation> '<JSON对象>'`，或让 IDE 以 JSON stdin 调用 `npx cli-validator@latest broker`。broker 本身只需要 Brain Client HTTPS、受限身份文件和显式传入路径，不需要完整磁盘访问。要保证 IDE 看不到 token，必须把 broker 作为独立低权限账户或沙箱服务运行并只暴露受限 IPC；同一系统账户下的 `0600` 不能隔离 IDE 与 broker。

Brain Client 服务端在同一次 runtime 请求的事务中绑定真实响应、生成并持久化权威评分与评语，再返回已提交回执。broker 只验证 `feedbackReceiptId`、`feedbackInvocationId` 和权威摘要，不发起第二次评价写入，也不生成分数或评语。`not-reported`、验证不完整、P0/P1 findings、`blocked` 或 `failed` 都不得生成好评；缺凭证、缺回执、摘要不匹配、响应非法或 HTTP 失败都会显式失败。

本地 CLI 不提供手工评分或评语提交命令，人类不能选择技能分数或填写技能评价。日常聊天不属于评价协议。

## 本地受限执行器

先运行 `cli-validator local capabilities` 读取输入合同与限额，再以 JSON stdin 调用 `cli-validator local run-approved-plan`。输入必须完整包含 `repositoryRoot`（绝对目录）、`planPath`（工作区相对路径）、`approvalPath`（外部绝对路径）与 `signerConfigPath`（外部绝对路径或显式 null）。

冻结计划采用 `validator.execution-plan/1.0`：frozen=true，planId/validationRunId/memberId/chainId，排序且唯一的 files[{path,sha256}] 与 artifactSha256，tests[{testId,path}]，GoldenBaseline 与 Aimlock 合同。policy 明确 executable（绝对真实文件）及 executableSha256、args、environment 字符串字典、timeoutMs、maxOutputBytes、requiredExitCode=0。每个测试文件必须列入 manifest 并作为真实命令参数传入；组合测试可使用受审计的入口脚本，不能把未执行文件假报为测试。执行前后校验产物、计划、可执行文件与外部授权。

外部授权为 `validator.runner-approval/1.0`，包含 repositoryRoot、planSha256（冻结计划文件原始字节 SHA-256）、approvedBy、approvedAt、expiresAt，最长 24 小时。文件必须归执行账户所有、0600、非符号链接且位于被测工作区之外。它记录外部批准；智能体不得伪造批准或用测试 fixture 授权真实工作。

未配置 signer 时只返回 local TestEvidence，独立终审仍为 incomplete。可选 `validator.runner-signer/1.0` 配置包含外置 privateKeyPath、keyId（Ed25519 SPKI DER SHA-256）、receiptTtlMs（最长 10 分钟）；配置和私钥同样必须为外部 0600 文件。签名绑定 subject、退出结果与日志指纹，消费方使用已配置公钥核验。密钥配置不是进程隔离：同 UID 子进程可能读取同账户文件，生产可信服务仍须独立 UID/容器及权限隔离；本工具不自动部署隔离、不创建可信密钥，也不改变验证器的信任配置。

本地运行仅支持 POSIX；无 shell、显式子进程环境、受限输出与时限。信号终止保留 exitCode=null，不制造整数退出码或成功 receipt。超时、输出超限、非零退出或运行中完整性变化均失败；原始执行记录与日志摘要可审计。此进程执行器不是 OS 沙箱，不授予任意磁盘或网络访问。

## Brain planning verification

IDE execution reports remain `reported` until a trusted runner verifies them. To prepare an execution plan from the server's complete report response:

```sh
cli-validator brain prepare /absolute/trusted-workspace report-response.json > prepared-runner.json
```

The trusted operator supplies the existing external, mode-0600 runner approval and signer configuration. The approval binds the exact `planSha256` printed by preparation. The runner input contains `reportResponse`, `approvalPath`, and `signerConfigPath`.

```sh
cli-validator brain run /absolute/trusted-workspace brain-runner-input.json > brain-validation.json
cli-aimlock brain validate /absolute/ide-workspace brain-validation.json
```

Run this on a dedicated isolated runner, never on the production application host. Brain verification requires a privileged supervisor and executes the frozen checks as UID/GID 65534. The signing key, approved Node executable and runner controls remain protected and root owned. Frozen control files must be regular mode-0600 files; control directories must not be writable by the check process. Provide writable build-output directories separately when a check needs them. A Linux container supervisor needs SETUID, SETGID and KILL capabilities for identity separation and process-group cleanup. Do not mount a host Docker socket or production secrets.

The fixed adapter executes every frozen check with `shell: false` and an explicit PATH. Its source and complete check manifest are included in the signed file manifest. The supervisor bounds the whole run to five minutes and one MiB of output. A failed, timed-out, modified or incomplete run cannot become `verified`.

The API accepts `planId`, `reportDigest`, `executionPlan`, the runner's real `subject`, and `receipts`. It reconstructs and compares the member, plan, report, complete checks, files, adapter, frozen contract and policy before validating the signature. The server uses only the configured `CLITAX_VALIDATOR_RECEIPT_PUBLIC_KEY`, an Ed25519 SPKI DER public key encoded as base64. Test fixture keys must never be added to production trust.

## Isolated integration verification

The normal server test suite includes protocol, substitution, signature and unprivileged-runner rejection checks. The separate integration test runs real commands in a disposable root-to-unprivileged container:

```sh
docker run --rm --network none --read-only --cap-drop ALL \
  --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1 \
  --tmpfs /tmp:rw,nosuid,size=64m \
  --mount type=bind,source=/absolute/source,target=/code,readonly \
  --workdir /code node:24-alpine \
  node --test scripts/brain-validator-isolated-integration.mjs
```

Use a source fixture containing only the needed first-party modules, not a directory containing environment files or credentials. The fixture generates a temporary signing key inside the disposable container and verifies that the unprivileged checks cannot read it.

## 网络中断与原回执恢复

仅在 TLS 握手前确定尚未发送 HTTP 请求时，broker 才允许最多 3 次连接尝试，并受总超时约束。请求发出后发生断线或响应中断，只用 GET 查询原 requestId 的服务端回执，禁止重发 POST；未取得有效回执时保留不确定状态，不得假定成功或继续依赖步骤。

`npx cli-validator@latest recover <operation> <requestId>` 可重新查询原调用，不会重做操作或重复计费。链恢复不会跳过人工确认，也不会自动重跑结果不确定的本地命令。代理连接需 Node.js 22.21+ 或 24.5+；不支持的运行时会明确报错。

## 账号共享凭据与自动更新

在已登录的能力市场复制安装入口，将内容粘贴给 IDE。页面只展示原地址，剪贴板会携带当前账号凭据。IDE 将四字段凭据 JSON 经标准输入交给 `npx cli-aimlock@latest configure`；不要放到命令参数、项目文件或日志中。一次配置供同一操作系统账号的所有项目、分支和任务使用，八个技能共享同一文件。

默认位置：macOS 为 `~/Library/Application Support/CLI.Tax/broker/credential.json`，Linux 为 `~/.local/share/CLI.Tax/broker/credential.json`，Windows 为 `%LOCALAPPDATA%\CLI.Tax\broker\credential.json`。显式 `CLITAX_BRAIN_CLIENT_TOKEN_FILE` 仍按绝对路径覆盖默认位置；迁移旧 IDE 配置时移除其过时覆盖，再使用账号共享文件。macOS/Linux 校验当前账号所有权和0600权限；Windows校验仅当前账号与SYSTEM可访问的ACL。

每次新技能调用先查询官方发布版本，精确版本下载并校验身份后自动使用；更新已托管的当前项目与账号技能目录，失败恢复旧目录，禁止覆盖 Git 跟踪源码或未托管内容。升级返回 `upgrade.reloadRequired` 和说明路径时，IDE 应读取更新后的 SKILL.md、核对本任务合同再继续。install/check同样自动更新，不需要每次人工发升级指令。查询不确定调用的原回执不升级、不重发操作。

升级不会清除账号凭据；各调用重新读取共享文件，因此重新同步一次密钥后所有任务使用新值。已撤销或失效的密钥不能为自己取得新权限，必须从已认证网页重新同步一次。两个不同操作系统账号不共享私密文件。

English: configure once using JSON stdin; all tasks under the same OS account reuse the credential. Each new invocation checks and updates the official package and managed documentation. Reload updated instructions when indicated. Revoked keys require a fresh authenticated copy.

Русский: настройте ключ один раз через JSON stdin для всех задач пользователя ОС. Перед новым вызовом пакет и управляемые инструкции обновляются автоматически. Отозванный ключ требует повторной синхронизации с авторизованной страницы.
