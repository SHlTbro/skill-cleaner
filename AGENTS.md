# SGS 项目入口

- 项目事实和按需读取顺序见 `CONTEXT.md`；模块职责见 `docs/ARCHITECTURE.md`。
- 宿主配置以选中的 runtime profile 为准；事务状态以该 profile 的 cold store receipt 为准。旧报告不能替代当前状态。
- 文档导航见 `docs/README.md`。历史任务、签收和脚本只在对应问题需要时读取，不作为新的阶段入口。
- `.agent-archive/` 是冷归档。恢复只读取指定批次的 `manifest.json`，先比较后状态，保留后续改动。
