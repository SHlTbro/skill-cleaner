# SGS 项目上下文

## 项目是什么

Skill Governance System 管理已安装 Skill 的发现入口。领域对象是 Asset（完整包内容）、Installation（安装及链接关系）、Exposure（某宿主实际观察到的入口）。逻辑路径、真实目标、包事务和 Desktop 会话入口分别计数。

运行要求：Node 24+，仅使用内置模块。完整文件事务目前验证于 Windows；Desktop 能力与授权属于具体宿主。

## 读取顺序

| 当前问题 | 读取 |
|---|---|
| 使用命令 | `README.md`、`product/skill-governance/SKILL.md` |
| 模块与依赖 | `docs/ARCHITECTURE.md`，再读命中的模块 |
| 配置与迁移 | `src/runtime/config.mjs`、`config/sgs.example.json`、`docs/MIGRATION.md` |
| 本机现在的状态 | `node src/sgs.mjs doctor` / `status` / `changes`；按返回路径读取 receipt |
| 当前实现与签收入口 | 原工作区的 `docs/implementation-entry.md` |
| 历史问题或剩余范围 | `docs/README.md` 中的本机记录索引 |

## 代码与状态边界

- 用户入口：`src/sgs.mjs → cli.mjs → app.mjs`。
- 批次：`src/cleanup.mjs`；移动、回滚、失败恢复均复用 `src/core/filesystem-exposure-backend.mjs`。
- 包身份与授权分别由 `src/core/package-fingerprint.mjs`、`production-authorization.mjs` 提供。
- 配置选择：`--config` → `SGS_CONFIG` → 项目 `.sgs.local.json` → 只读默认 profile。路径以 profile 所在目录解析。
- 证据由 profile 的 `artifacts` 指向；事务及批次以 cold store 中的 JSON receipt 为准。不在本文件复制计数或 PASS 状态。
- `outputs/`、`work/`、`.tt-state/` 和本机历史文档保留在原工作区；便携发布只带明确清单中的代码、模板和使用文档。

## 工作边界

沿用 M0–M11 / C0–C5 和原签收，不重新编号。只读命令、显式扫描/构建、真实 apply 是不同操作；扫描或旧 Desktop 证据不授予写入。生产变更继续经过既有宿主、精确授权、before/canonical、锁和恢复门。

常规源码搜索跳过生成物和冷归档。需要历史证据时按确切路径读取；不要将整份旧阶段记录重新载入活动上下文。便携目录没有原宿主证据、授权或 receipt 时保持未知和只读。
