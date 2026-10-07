---
name: skill-governance
description: 管理本机 Codex Skill 的发现入口。用户要求查看状态、审计、治理方案、清理高置信度冗余 Skill、应用已授权变更或回滚时使用。支持 status、audit、inspect、plan、apply、rollback、changes、cleanup --safe。
---

# Skill Governance

把自然语言请求映射到 SGS 命令，复用既有项目，不重新扫描分类或新建治理系统。

读取本 Skill 的 `references/runtime.json`，取得 `project_root`、`entry`、`node_command` 和可选 `config_path`。
入口：`<node_command> <project_root>/<entry> [--config <config_path>] <command> [ChangeSet ID]`。
必须使用 pointer 中的 Node executable 和 config；不要退回另一套默认 profile。路径含空格时，将 executable、entry 和 config 分别作为独立参数传递；PowerShell 用调用运算符 `&` 执行带引号的 executable。
没有 runtime pointer 时，使用已明确指定的 SGS 项目；无法定位则报告缺少配置，不猜测其他机器的路径。

- 状态/审计：`status` / `audit`；审计读取已冻结的有界索引，不能宣称全局 Desktop 覆盖。
- 查看变更：`changes`；具体证据：`inspect <ID>`；文件状态验证：`verify <ID>`。
- 准备配置中的候选：`plan <ID>`。读取返回的 blockers，不能把计划当作写入授权。默认迁移配置没有候选或授权。
- 应用：`apply <ID> --authorized`，必须有 exact ChangeSet 的 Owner 授权、当前安全门通过和对应宿主证据。
- 恢复：`rollback <ID>`。并发变化必须拒绝覆盖，保留证据并说明原因。
- 清理高置信度冗余 Skill：先运行 `audit` 和 `cleanup --safe`。只使用当前 baseline 中 AUTO_CLEAN、置信度至少 0.98 且完整 before/rollback 已就绪的安装包；保留 canonical，禁止根据零读取或名称直接清理。
- 受控批次：`cleanup --safe --batch <ID> --authorization <授权JSON>` 准备；`cleanup --apply --batch <ID> --authorized` 执行；`cleanup --verify --batch <ID> --evidence <Desktop证据JSON> --checks <smoke JSON>` 验收；`cleanup --rollback --batch <ID>` 恢复。复用现有 backend/receipts。Canary 最多 10 包，后续每批最多 25 包；前批 Desktop 真实路径验收 PASS 后才继续。
- 缺少 fresh Desktop catalog 时保持 `APPLIED_AWAITING_DESKTOP`，文件移出不能冒充 Desktop 验收。`status` 分开报告当前会话入口数、包移动数和 cold-store 数；`changes` 展示独立批次。

只移动用户所有的完整安装入口到冷存储，保留资产。禁止改 YY、system/plugin 或未知所有权对象。Desktop 可见性需同宿主观察；文件状态和 CLI 结果不能冒充 Desktop 证据。失败时报告真实退出码和 receipt；不宣称完成尚未通过的 gate。

迁移后的 `doctor` 展示当前 profile、宿主绑定、证据与写入开关。新机器默认只读，Desktop capability 为 UNKNOWN。已消费的授权不能复用；新 apply 需要精确授权。历史索引不能称为新机器当前发现数。
