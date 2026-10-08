# 系统边界

这是当前本地 CLI 的 C4 Context 视图。文件存储使用存储图形表达，不代表数据库服务。scanner、ledger 和 backend 都在同一 Node 进程内。

```mermaid
%%{init: {"c4": {"c4ShapeMargin": 150, "width": 300, "height": 150, "boxMargin": 40, "c4ShapeInRow": 3}}}%%
C4Context
title skill-cleaner — System Context
Person(user, "Skill user", "Audits and authorizes local changes")
System(cleaner, "skill-cleaner", "Local Skill inventory and reversible transactions")
System_Ext(desktop, "Codex Desktop", "Optional skill-governance invocation")
System_Ext(skills, "User Skill directories", "Complete packages and installation links")
Rel(user, cleaner, "Runs audit or authorized changes", "CLI / JSON")
Rel(desktop, cleaner, "Invokes through thin entry", "Node CLI")
Rel(cleaner, skills, "Reads; moves only after gates", "Local filesystem")
UpdateRelStyle(user, cleaner, $offsetX="0", $offsetY="-55")
UpdateRelStyle(desktop, cleaner, $offsetX="-100", $offsetY="0")
UpdateRelStyle(cleaner, skills, $offsetX="70", $offsetY="0")
```

[可编辑 Mermaid](c4-context.mmd) · [兼容渲染](c4-context.svg) · [Archify 静态预览](../../assets/diagrams/context.png) · [交互文件](../../assets/diagrams/context.html) · [可编辑 JSON](../../assets/diagrams/context.json)

取证范围：公开版本的 app、deployment、runtime/config、scan 和 filesystem-exposure-backend。交互图每个节点都带固定提交的源码来源。更细的进程内职责在首页技术栈表中说明；没有分布式部署，无需额外 Deployment 视图。



