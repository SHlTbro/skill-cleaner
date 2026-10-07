# SGS 迁移

## 两种迁移

| 场景 | 处理 |
|---|---|
| 复制代码到新目录/新电脑 | 使用便携包；创建该位置的本地 profile；只读启动，统计未知，Desktop UNKNOWN。 |
| 迁移运行中的 cold store 或未结束事务 | 属于资产和恢复状态迁移，必须独立处理；本次导出不包含，不自动执行。 |

本轮可迁移的是代码、接口、模板和文档。原机器的历史验收保留在原工作区，不能当作新电脑的验收。

## 1. 取得便携目录

```powershell
node tools/export-portable.mjs --out outputs/distributions/sgs-portable
```

复制该目录到你选择的项目位置，例如 `E:\Projects\SGS`。要求 Node 24+，无需 npm install。`PORTABLE-MANIFEST.json` 列出所有发布文件及 SHA256。

**不要整目录复制原工作区来部署**：其中包含本机历史输出、授权、诊断及工作资料。便携导出采用明确文件清单，排除了这些资料。

## 2. 在目标目录初始化

```powershell
cd E:\Projects\SGS
node src/sgs.mjs doctor
node src/sgs.mjs init
node src/sgs.mjs status
```

接着执行新用户的标准路径：

```powershell
node src/sgs.mjs bootstrap
node src/sgs.mjs status
node src/sgs.mjs audit
node src/sgs.mjs install-entry
```

bootstrap 复用已有 scanner、包级 ledger 和 conservative dry-run，在配置所在目录的 `.sgs/inventory/<run-id>` 保存结果，并原子更新该 profile 的 artifact mapping。它只接受 read-only profile；不改变真实安装、cold store、授权或宿主绑定。`PARTIAL` 明确表示扫描不完整，Desktop 数量仍未知。

可先执行 `node src/sgs.mjs --help`，该命令不要求本机 profile 或原宿主证据。`doctor.dependencies` 和 `doctor.capabilities` 分别说明依赖和平台能力；`limitations` 列出当前限制。Windows PowerShell 缺失、宿主绑定不匹配和 Desktop 未实测均不能被“代码已复制”消除。

`init` 生成 `.sgs.local.json`，已有配置则拒绝覆盖。当前启动不会扫描、移动或安装真实 Skill。

显式 `--config` 或 `SGS_CONFIG` 指向不存在文件时返回 `CONFIG_NOT_FOUND`；只有 `init` 允许在该确切路径创建新 profile，并创建所需父目录。支持 `--config path` 和 `--config=path`；重复 config 明确拒绝。所有带值选项不得吞掉下一枚 flag。

新环境预期：`configured=true`、`production_writes_enabled=false`、Desktop UNKNOWN、index null、changes 空列表。空列表仅表示该项目没有登记事务，不能推导宿主没有 Skill。

## 3. 配置本机路径与数据输入

| 配置 | 含义 |
|---|---|
| `discovery_roots` | 用户所有的直接安装根，不是自动授权范围 |
| `cold_store` | 本机冷存储，必须与实际拟变更入口同卷；不得与 discovery roots 重叠 |
| `authorization_directory` | 该项目的精确授权记录目录；默认空 |
| `artifacts` | index / ledger / actions / reconciliation / pilot / filesystem_capability / producer / cleanup_baseline 的文件映射；默认空 |
| `candidates` | 明确候选 ID 及 target/alternative/owner/reason/dependencies；默认空 |
| `host_binding` | `doctor` 展示当前 host_key；需要真实宿主证据后才绑定 |
| `production_writes_enabled` | 默认 false；打开也不能替代 backend/authorization/compare 等门 |

路径相对 **profile 所在目录** 解析。支持 `${HOME}`、`${PROJECT}` 和 `~`，不需要修改源码。配置优先级：`--config` → `SGS_CONFIG` → 项目 `.sgs.local.json` → 内置只读默认值。

若需要在新宿主建立扫描输入，显式执行：

```powershell
node tools/render-scan-scope.mjs --out .sgs/scan-scope.json
# 检查 roots；需要跟随的外部 link target 由你明确填入 allowlist。
node src/scan.mjs --scope .sgs/scan-scope.json --out .sgs/scan-result.json
node src/profile-dry-run.mjs --scan .sgs/scan-result.json --out .sgs/profile-dry-run.json
```

这个 scope 默认不跟随外部链接，system 子目录登记为 managed。缺失目录/断链会保留 PARTIAL 和退出码2，不会伪造成功。上述命令不自动重跑 M3/M4，也不会应用真实变更；原 SGS 工作区不需要重新扫描。

## 4. 生成用户入口

```powershell
node tools/render-skill-entry.mjs --project . --out outputs/skill-entry
```

生成的 `SKILL.md` 与 `references/runtime.json` 指向目标项目。确认入口内容后，另行安装该小入口。脚本本身不会写 Codex discovery root。

原机器当前安装的 skill-governance 未在本轮改动，继续使用原项目兼容入口；将来搬走原项目时，再按明确安装范围更新它的 pointer。不要将全部源码、历史文档或内嵌包作为一个 Skill 放进发现根。

`install-entry` 保存项目绝对路径、当前 Node executable 和实际选用的 config_path。搬家后执行新位置的 `rebind-entry --entry <已安装入口目录> --project <新项目目录>`；旧 pointer 原始字节与新值记录在 profile 目录 `.sgs/deployment-receipts`，并执行 compare-before-replace。重复 install 不覆盖；Desktop 发现仍需重启/新会话单独观察。

仅迁移 read-only 部署目录时，旧 bootstrap artifacts 可能保留原绝对路径；在新目录重跑 `bootstrap` 会重新接入新位置的只读 inventory。rebind 只更新入口 pointer，不搬运 cold assets、历史 receipt 或未结束事务；存在生产事务的状态迁移仍按本页独立边界处理。

## 5. 保持宿主状态隔离

- 新电脑不携带原机 capability PASS、已消费授权、receipt 或 session log。
- 同机移动代码也优先只读启动；保留旧工作区，确认新配置和外部 state 的关系。
- 原始证据中的绝对 path、hash、时间不进行批量替换。
- `package_content_hash` 描述整包字节与内部链接拓扑；`package_fingerprint` 还包含 logical/real path，`state_hash` 还包含 ACL 与时间等 metadata。因此不能把旧机器的 fingerprint/before state 通过字符串替换变成新机器基线。
- 新 apply 需要精确 Owner 授权、对应 Desktop 支持、before/canonical 比较和恢复路径。
- Windows 是当前完整事务验证平台。其他平台的代码可读取配置/数据，但生产写入由运行入口拒绝；没有声明跨平台 Desktop 验证。

## 回退本轮架构调整

原工作区 `work/architecture-before-20261004/` 保留本轮前的 src/product 及关键文件 hash。回退代码需要同时恢复 source 与对应 runtime profile 的兼容关系，不能覆盖 cold store 或改写历史 receipt。便携包不包含这个备份。

后续项目整理的局部备份位于 `.agent-archive/project-bath/<批次>/`。它与首次源码重组备份是不同基线；按该批 manifest 的 after hash 和可逆补丁恢复，保留整理后新增的用户修改，不把旧备份整目录覆盖到当前项目。
