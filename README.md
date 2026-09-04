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
