# SGS 文档导航

## 当前产品与架构

| 需要了解 | 入口 |
|---|---|
| 命令、运行要求、项目目录 | [项目 README](../README.md) |
| 项目事实与读取顺序 | [CONTEXT](../CONTEXT.md) |
| 模块、依赖方向、事实来源、写入边界 | [ARCHITECTURE](ARCHITECTURE.md) |
| 代码迁移、profile、宿主状态隔离 | [MIGRATION](MIGRATION.md) |
| 用户 Skill 的命令映射 | [入口模板](../product/skill-governance/SKILL.md) |
| 新宿主默认配置 | [配置模板](../config/sgs.example.json) |

当前状态使用 `doctor/status/changes` 获取；本页只索引证据，不复制统计或验收结论。

## 原工作区的实现与历史记录

以下文件属于原工作区，便携包不带入。按当前问题选择一个入口；历史阶段中的“当前”“未解锁”等文字只对应其记录时间。

| 记录 | 路径及用途 |
|---|---|
| 实现入口 | `docs/implementation-entry.md`：原计划、签收和最新验收来源的短索引 |
| 原计划与评审 | `docs/yy-dev-plan.md`、`docs/plan-review-report.md`：M0–M11 / C0–C5 保持原编号 |
| 契约及任务 | `docs/contracts/`、`docs/tasks/`：读取具体任务所需条目 |
| 方向调整 | `docs/changes/`：Owner 已批准的范围变化 |
| V0 pilot 收官 | `docs/V0-CLOSEOUT-20261004.md`：SG-001 能力验收及恢复阶段记录 |
| 当前批次收尾 | `outputs/runs/cleanup-acceptance-20261004.json`；实际状态仍核对 cold store `batches/` |
| 剩余范围 | `docs/cleanup-backlog-20261004.md`、`docs/P2-P3-backlog.md` |
| 首次可迁移化 | `docs/architecture-portability-20261004.md`：当时的交付与验证记录 |
| 原始证据 | `docs/evidence/` 与 `outputs/runs/`：保留时间、哈希和原宿主范围 |
| journey | `.tt-state/journey.json`：已有签收路径记录，不补造内容哈希 |

## 冷归档

项目洗澡的原件、哈希、可逆补丁和检查保存在 `.agent-archive/project-bath/<批次>/manifest.json`。常规搜索和便携导出排除该目录；原件需要时按指定批次回取。其他外部索引器和已载入会话上下文的行为没有据此获得验证。
