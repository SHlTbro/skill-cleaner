# 运行单元

这是当前本地 CLI 的 C4 Container 视图。文件存储使用存储图形表达，不代表数据库服务。scanner、ledger 和 backend 都在同一 Node 进程内。

```mermaid
%%{init: {"c4": {"c4ShapeMargin": 150, "width": 300, "height": 150, "boxMargin": 40, "c4ShapeInRow": 3}}}%%
C4Container
title skill-cleaner — Container structure
System_Boundary(sgs, "skill-cleaner on the local host") {
Container(cli, "CLI process", "Node.js 24 / ESM", "Commands, scanner, ledger and transactions")
ContainerDb(profile, "Profile and inventory", "JSON files", "Configuration and timestamped filesystem snapshots")
ContainerDb(cold, "Cold store and receipts", "Local filesystem / JSON", "Whole packages and authoritative transaction records")
}
System_Ext(roots, "Skill roots", "User-owned installation directories")
Container_Ext(ps, "Metadata helper", "Windows PowerShell", "Reads ACL and file attributes")
Rel(cli, profile, "Reads configuration; publishes inventory", "node:fs")
Rel(cli, roots, "Scans and compares packages", "node:fs / SHA-256")
Rel(cli, cold, "Moves authorized packages; records state", "Same-volume rename / JSON")
Rel(cli, ps, "Requests exact metadata", "child_process / JSON")
UpdateRelStyle(cli, profile, $offsetY="-50")
UpdateRelStyle(cli, cold, $offsetY="-55")
UpdateRelStyle(cli, roots, $offsetX="-100", $offsetY="-20")
UpdateRelStyle(cli, ps, $offsetX="120", $offsetY="30")
```

[可编辑 Mermaid](c4-containers.mmd) · [兼容渲染](c4-containers.svg) · [Archify 静态预览](../../assets/diagrams/containers.png) · [交互文件](../../assets/diagrams/containers.html) · [可编辑 JSON](../../assets/diagrams/containers.json)

取证范围：公开版本的 app、deployment、runtime/config、scan 和 filesystem-exposure-backend。交互图每个节点都带固定提交的源码来源。更细的进程内职责在首页技术栈表中说明；没有分布式部署，无需额外 Deployment 视图。



