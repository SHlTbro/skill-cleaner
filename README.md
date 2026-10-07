<h1 align="center">skill-cleaner</h1>

<p align="center">审计本机 Agent Skill 的安装与发现入口，为已确认的冗余包提供可回滚的冷存储变更。</p>

你提供用户 Skill 根目录和本机配置，得到带扫描范围的 inventory、整包冲突账本和只读方案。符合证据与授权条件的变更会保留完整包、原路径和事务记录，便于恢复。

项目内部使用 SGS 名称；可选的 Codex 薄入口仍叫 <code>skill-governance</code>。

## 核心亮点

| 你要做的事 | 项目提供的能力 |
|---|---|
| 了解当前安装情况 | 有界文件系统扫描；逻辑路径、真实目标和宿主观察分别计数 |
| 判断包是否相同 | 整包指纹覆盖脚本、引用、资产和链接关系；同名不自动判为冗余 |
| 先看方案 | bootstrap 和新用户 profile 默认只读，不自动清理 |
| 执行已确认变更 | 复用冷存储事务、精确 before state、锁及回滚比较 |
| 在 Codex 中使用 | 薄入口调用独立项目，可记录 Node/config pointer 并在搬家后 rebind |

## 系统架构

```text
  Codex 薄入口 ─────▶ SGS CLI ─────▶ 本机 profile
                         │                 │
                         ▼                 ▼
                  应用命令用例       扫描 / 账本 / 只读方案
                         │                 │
                         ▼                 ▼
                  授权与完整包事务      inventory JSON
                         │
                         ▼
                  cold store / receipt
```

扫描、准备方案和真实写入是不同操作。真实 apply 仍需宿主绑定、Desktop backend 证据、精确授权、before 比较和恢复条件。首次 bootstrap 不会自动补齐这些写入门。

手工移动 Skill 目录时，原路径、包内容和恢复信息需要自行维护。skill-cleaner 将这些信息纳入事务比较和 receipt；它没有依据“同名”或“零读取”直接删除包的默认行为。

## 快速安装

需要 **Windows、Node.js 24+ 和系统 Windows PowerShell**。运行依赖只有 Node 内置模块，无需 npm install。

下载版本固定的 [v0.2.0-rc1 部署 ZIP](https://github.com/qq2743759880/skill-cleaner/releases/download/v0.2.0-rc1/skill-cleaner-v0.2.0-rc1.zip)，解压，在解压后的项目目录打开终端。

源码开发可克隆仓库：

```powershell
git clone https://github.com/qq2743759880/skill-cleaner.git
cd skill-cleaner
git checkout v0.2.0-rc1
```

## 快速开始

在项目目录执行：

```powershell
node src/sgs.mjs doctor
node src/sgs.mjs init
node src/sgs.mjs bootstrap
node src/sgs.mjs status
```

`init` 创建默认只读 `.sgs.local.json`；`bootstrap` 调用已有 scanner、包级账本和保守 dry-run，并将本机结果接入 status。你会得到 inventory 和扫描范围；Desktop exposure 没有直接观察时保持未知。

目录缺失、断链或外部链接不在允许范围内时，bootstrap 返回 `PARTIAL` 并列出 errors。它不是完整 Desktop 全局发现证明。inventory 是带时间的快照，重新执行 bootstrap 才会更新文件系统记录。

### 在 Codex Desktop 中调用

```powershell
node src/sgs.mjs install-entry
```

此命令只安装 `skill-governance` 薄入口，不复制整个 SGS 源码；已有入口拒绝覆盖。安装后重启 Desktop 或新建会话，再发送：

```text
$skill-governance status
```

终端入口始终可用。其他平台的生产写入尚未验证；安装成功不会自动授予治理权限。

## 常用命令

| 命令 | 作用 |
|---|---|
| `node src/sgs.mjs --help` | 命令与副作用说明，不加载宿主 profile |
| `node src/sgs.mjs doctor` | 检查依赖、配置、artifact 和冷存储边界 |
| `node src/sgs.mjs bootstrap` | 更新本机只读 inventory；不移动 Skill |
| `node src/sgs.mjs status` / `audit` | 读取配置选择的证据与事务状态 |
| `node src/sgs.mjs plan` | 查看当前配置可提供的候选；没有候选时为空 |
| `node src/sgs.mjs changes` | 查看事务和批次，单条损坏记录单独报告 |
| `node src/sgs.mjs inspect <ID>` | 读取指定变更记录 |
| `node src/sgs.mjs rollback <ID>` | 通过当前恢复门回滚指定事务 |

首次部署没有生产候选、授权或已验证的 Desktop 写入能力；新用户 plan 为空是保守的初始状态。真实 apply 的步骤见 [架构与安全边界](docs/ARCHITECTURE.md)。

## 配置与迁移

- 默认用户根为 `${HOME}/.codex/skills` 和 `${HOME}/.agents/skills`。
- `--config "配置路径"` 和 `--config=路径` 选择同一 profile；显式路径不存在会失败。`init` 可以在新路径创建 profile。
- `install-entry` 保存当前 Node executable 和 config pointer。项目搬家后使用 `rebind-entry`，并重新 bootstrap 更新只读 inventory。
- cold store 必须与拟治理入口同卷，且位于 discovery root 外。项目在另一盘时，doctor 会提示跨卷问题；只读 bootstrap 仍可运行。
- 不要复制作者机器的授权、cold assets、receipt 或 Desktop session 到新宿主。

## 文档与验证

| 你需要了解 | 文档 |
|---|---|
| 配置、部署和搬家 | [迁移说明](docs/MIGRATION.md) |
| 模块职责与生产写入门 | [架构](docs/ARCHITECTURE.md) |
| 命令映射 | [Skill 入口模板](product/skill-governance/SKILL.md) |
| 已知限制 | [限制说明](release/KNOWN-LIMITATIONS.md) |
| 部署回归与 clean-room | [公开验收摘要](release/NEW-USER-ACCEPTANCE.json) |
| 真实 Desktop 调用与原入口恢复 | [Desktop 验收摘要](release/FINAL-DESKTOP-ACCEPTANCE.json) |

Windows 下的 portable 命令部署、clean-room bootstrap、薄入口安装/rebind 和真实 Codex Desktop runtime invocation 已验证。其他 Desktop 版本与宿主仍需独立证据；作者机器的 Skill 数量不适用于其他用户。

开发者可在隔离环境运行部署回归：

```powershell
node test/new-user-deployment.test.mjs
```

`tools/render-skill-entry.mjs` 供开发者生成待检查或打包的入口文件；普通用户使用 `install-entry`，不需要连续执行这两个步骤。

## 许可证

采用 [MIT](LICENSE) 许可证。
