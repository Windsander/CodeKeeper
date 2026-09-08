# CodeKeeper — 架构设计文档

> **定位**：本地优先的 **Agent 管线编排 + 项目智库**工作台。
> ComfyUI 式可视化编排为皮，持久化执行为骨，双正本智库为底。
>
> 本文档描述 repositioning 后的目标架构与当前实现状态。
> 旧版 cron 审查器设计已随 M1 移除，不再保留于此。

## 一、核心模型：分层管线图

### 画布层（粗粒度）

管线由类型化节点与边组成，正本是项目内的 `.codekeeper/pipeline.yaml`（人类可读、可入库）：

```yaml
version: 1
id: pipeline-demo
nodes:
  - id: trigger-reviewer
    type: trigger.cron
    params: { schedule: '*/10 * * * *' }
  - id: role-reviewer
    type: role.reviewer
edges:
  - from: { node: trigger-reviewer, port: tick }
    to: { node: role-reviewer, port: trigger }
    channel: memory
```

**节点命名空间**：`trigger.*`（cron/文件/事件）、`role.*`（reviewer/maintainer/archiver）、
`agent.*`（外部 Agent：a2a/subprocess/mcp，M5）、`knowledge.*`（召回/投影，M6）、`sink.*`（投递）。

**边 = 类型化端口引用 + channel 绑定**：

| channel             | 语义                      | 说明                       |
| ------------------- | ------------------------- | -------------------------- |
| `memory`            | 进程内直接传递（默认）    |                            |
| `queue`             | SQLite 队列异步传递       | 后续里程碑实体化           |
| `gitlab-discussion` | 经 GitLab discussion      | **人类参与点**，显式在图上 |
| `everos`            | 经 EverOS 记忆            |                            |
| `fs`                | 经文件系统                |                            |
| `a2a-task`          | 经 A2A 任务（外部 Agent） | M5                         |

### 钻取层（细粒度，M7）

`NodeDef.subgraph` 字段已在 schema 预留：Role 节点内部可展开为 stage 子图
（扫描→召回→审查→投递→记录），同样 YAML 化、可在画布中钻取编辑。

## 二、运行时架构

```
Electron 工作台
    │ IPC（unix socket / named pipe，换行分隔 JSON-RPC）
    ▼
daemon（Node.js）
    ├── PipelineScheduler        管线生命周期中枢
    │     ├── 加载/迁移 pipeline.yaml（ensurePipelineDefinition）
    │     ├── 按 trigger.cron 注册 node-cron 触发器
    │     └── start/stop/restartProject/getStatus（兼容旧 RoleServiceRegistry 表面）
    ├── PipelineExecutor         顺序执行器（pipeline/core/executor.ts）
    │     ├── 拓扑排序 + startFrom 下游子图裁剪
    │     ├── 节点边界落库（断点恢复）
    │     └── resume：失败点续跑，成功节点产物回灌
    ├── RoleNodeRuntime          role.* 节点执行载体
    │     └── 每 (项目, 角色) 一个长驻子进程（fork role-entry），IPC 派发 run 指令
    ├── PipelineRunStore         pipeline_runs / stage_runs（SQLite，WAL）
    ├── EverOS MCP bridge        项目级长期记忆
    └── CodeGraph Server         项目知识上下文
```

### 与旧模型的对应关系

| 旧模型（M1 前）                 | 新模型                                    |
| ------------------------------- | ----------------------------------------- |
| 全局角色进程 × 项目轮询（10s）  | (项目, 角色) 节点实例子进程，IPC 指令驱动 |
| Runner 内部 cron                | 管线 trigger.cron 节点（daemon 调度）     |
| startProjectLoop 立即执行       | start 角色后立即触发一轮                  |
| restartProject 重启整个角色进程 | 停止单节点实例并重建，启用时立即对账一轮  |
| 角色配置散落在 roles_config     | 自动迁移生成 pipeline.yaml 正本           |

### 配置变更感知路径

- **角色配置更新**（`project.role.config.update`）：落库后若管线正本仍带
  `# codekeeper:generated` 标记则按新配置重建该文件，随后
  `PipelineScheduler.reloadProject` 重排触发器并重启项目节点实例
  （子进程持有启动时项目快照，必须重建才能读到新配置）。
- **pipeline.yaml 手工/画布编辑**：人类删除 generated 标记后文件即成为正本，
  角色配置更新不再回写；调度以人类正本为准。
- **项目注册**：`project.register` 后 `reloadProject` 接入调度；
  **注销**：`unloadProject` 摘除触发器并终止节点实例。
- **角色服务启停**（`role.service.start/stop`）：激活/摘除该角色全部触发器，
  start 后立即对账执行一轮（对齐旧版 startProjectLoop 语义）。

### 角色行为不变量

Runner 内部逻辑（Reviewer/Maintainer/Archiver 的 Brain/Actor、记忆召回、
GitLab 投递等）在 M3 保持黑箱不变；`runProjectOnce` 是唯一入口，
行为对拍由既有测试套件保证。

## 三、智库（当前 → 目标）

**当前（M2 后）**：EverOS 承载经验记忆（episode/profile/agent_case/agent_skill），
Archiver 文件优先管线产出策展产物（context.md 等）。

**目标（M6 双正本）**：

```
策展知识层（唯一事实源，文件）
  ├── 共享正本：<project>/.codekeeper/knowledge/（入库，团队可见）
  └── 私有正本：~/.codekeeper/memory/knowledge/（本地）
        │ 投影管线
        ▼
索引层（可重建）：EverOS 向量索引 + CodeGraph
        ▲
经验记忆层（Agent 直写 EverOS）：评审会话、修复尝试、交互
        │ 蒸馏管线（有人工检查点，承接旧 learn 循环）
        └──→ 策展知识层
```

## 四、里程碑路线

| 里程碑 | 内容                                                                       | 状态   |
| ------ | -------------------------------------------------------------------------- | ------ |
| M1     | 旧线清除；幸存者迁移入 advance；入口统一                                   | ✅     |
| M2     | 管线核心：图 schema / YAML 加载 / 顺序执行器 / 运行落库                    | ✅     |
| M3     | Role 黑箱节点化；daemon 调度改造；配置自动迁移；本文档                     | 进行中 |
| M4     | 可视化画布（节点编辑、检查器吸收 Role 配置、运行状态叠加）                 |        |
| M5     | 外部 Agent 节点（A2A 词汇任务信封 + A2A/subprocess/MCP 适配器 + MCP 门面） |        |
| M6     | 双正本智库 + 投影管线 + 蒸馏管线                                           |        |
| M7     | 钻取层：Role 节点内 stage 子图拆解与编排                                   |        |

## 五、工程约束（RULES）

1. `build` + `test:vitest` + `lint` + `format` 四件套全绿才提交；
2. 测试零真实机器路径（临时目录 / `virtual-*` 相对路径），由脚本强制检查；
3. 凭据、用户目录、运行日志、EverOS 数据永不入库；管线 params 与产物明文落库，
   凭据只允许经 `RunContext.services` 注入；
4. 新依赖核验许可证并同步 `THIRD_PARTY_NOTICES.md`；
5. 跨平台路径处理（Windows 为主战场）；
6. prompt 一律外置 `src/assets/prompts/`；
7. README 中英双语同步；
8. `vendor/everos` 为独立 submodule（Apache 2.0），不改动、不主张权利。
