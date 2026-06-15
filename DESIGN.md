# CodeKeeper — 自动化 MR Reviewer & 学习体系实现计划

> **C**ode **O**rchestrator & **R**eview **N**ode

## Context

Boris Cherny 的核心理念是 "Automate yourself out of code review"：将重复的审查意见记录并模式化，出现 3-4 次后写成 lint rule 自动化拦截。我们希望在独立 Mac 机器上部署一套长期运行的自动化服务，实现：

1. **全量 MR AI 审查** — 自动发现 open MR，读取项目 CLAUDE.md 规则，进行深度代码审查
2. **Reviewer 意见自动订正** — 根据 reviewer 的评论自动生成修复分支
3. **学习循环** — 跟踪 reviewer 评论模式，自动更新 CLAUDE.md 和 ast-grep 规则
4. **多项目支持** — 通过配置文件管理多个项目，每个项目独立调度

## Architecture

### 部署模型

CodeKeeper 作为独立 TypeScript 项目，与目标项目分离部署：

```
/ai-framework/
├── codekeeper/                           # CodeKeeper 系统（本计划实现）
│   ├── src/
│   ├── config/
│   │   └── projects.yaml           # 指定目标项目本地路径
│   └── ...
│
└── your-project/                 # 目标项目（用户手动拷贝至此）
    ├── .git/
    ├── CLAUDE.md                   # CodeKeeper 读取的规则源
    ├── .claude/rules/              # ast-grep 规则
    └── ...
```

运行方式：
```bash
cd /ai-framework/codekeeper
# 方式1：前台单次运行
npm start -- --project /ai-framework/your-project

# 方式2：后台 cron 模式
npm run daemon
```

CodeKeeper 通过 `config/projects.yaml` 中的 `localPath` 定位项目，负责 `git fetch/pull` 同步，不管理项目 clone。

### 目录结构（独立仓库）

```
codekeeper/
├── README.md
├── package.json                    # Node.js >=22, TypeScript
├── tsconfig.json
├── config/
│   └── projects.example.yaml       # 多项目配置模板
├── src/
│   ├── index.ts                    # 入口：解析 CLI args，启动 scheduler
│   ├── scheduler.ts                # cron 调度 + worker 编排
│   ├── cli.ts                      # CLI 接口（单次运行、项目注册等）
│   ├── config-loader.ts            # projects.yaml 加载与验证（Zod schema）
│   ├── types.ts                    # 共享 TypeScript 类型
│   ├── core/
│   │   ├── project-sync.ts         # git clone/pull/fetch（simple-git）
│   │   ├── token-budget.ts         # 200k token 预算计算与分片策略
│   │   ├── logger.ts               # 结构化日志（pino）
│   │   └── rate-limiter.ts         # API 调用速率限制
│   ├── gitlab/
│   │   ├── client.ts               # GitLab API 封装（fetch-based）
│   │   ├── mr-service.ts           # MR 查询、diff 获取、评论发布
│   │   └── types.ts                # GitLab API 类型定义
│   ├── review/
│   │   ├── diff-analyzer.ts        # diff 解析、文件分组、风险评分
│   │   ├── prompt-builder.ts       # 构建 AI review prompt（CLAUDE.md + diff）
│   │   ├── reviewer.ts             # Claude API 调用 + 结果解析
│   │   ├── fixer.ts                # 自动修复：创建分支 → 应用修改 → push
│   │   └── validators.ts           # 修复后运行 lint/typecheck 验证
│   ├── learn/
│   │   ├── comment-fetcher.ts      # 获取 MR reviewer 人工评论
│   │   ├── pattern-tracker.ts      # 评论分类 + 频次计数（Boris 3-4 次规则）
│   │   ├── claude-md-updater.ts    # 自动更新项目 CLAUDE.md
│   │   └── ast-grep-generator.ts   # 从模式生成 ast-grep 规则骨架
│   └── ast-grep/
│       ├── runner.ts               # 调用本地 ast-grep CLI
│       └── types.ts                # ast-grep 输出类型
├── rules/                          # 共享 ast-grep 规则模板
│   └── common/
│       ├── no-raw-env.yml
│       ├── require-feature-gate.yml
│       └── no-unprotected-override.yml
└── scripts/
    ├── install.sh                  # Mac 安装脚本
    ├── setup-launchd.sh            # 配置 macOS launchd 服务
    └── com.codekeeper.review.plist       # launchd plist 模板
```

### 核心流程

#### 1. 单次 Review 工作流

```
cron 触发 / CLI 调用
    │
    ▼
┌─────────────────┐
│ 1. 加载配置      │ 读取 projects.yaml，验证 API token
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. 项目同步      │ git fetch origin，确保本地是最新代码
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3. 发现 MR       │ 调用 GitLab API 获取 open MR 列表
│    (按过滤条件)  │ 排除 draft、排除指定作者、按更新时间排序
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. 对每个 MR：   │
│   a. 获取 diff   │  git diff target...source
│   b. 读取规则    │  读取项目根目录 CLAUDE.md
│   c. 运行 ast-   │  执行项目 .claude/rules/ 规则
│      grep 预检查 │
│   d. 计算预算    │  根据 diff 大小计算 token 需求
│   e. 分片(如需)  │  超大 MR 按文件路径分组分批审查
│   f. AI 审查     │  调用 Claude API
│   g. 解析结果    │  JSON 格式 findings
│   h. 发布评论    │  汇总为 GitLab MR comment
│   i. 自动修复    │  如开启 autoFix，创建修复分支并 push
└─────────────────┘
         │
         ▼
┌─────────────────┐
│ 5. 记录日志      │ token 使用量、审查结果、错误
└─────────────────┘
```

#### 2. 学习循环工作流（独立 cron job，每日运行）

```
每日定时触发
    │
    ▼
┌──────────────────────────┐
│ 1. 扫描已合并 MR          │ 获取最近 N 天合并的 MR
│    (最近 7 天)            │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ 2. 获取 reviewer 评论     │ 提取人工 reviewer 的评论文本
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ 3. 分类与计数             │ 按规则类别分类（命名/安全/类型/      │
│                           │ 重复/冗余/性能等），维护频次计数器   │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ 4. 模式触发检查           │ 某类问题 count >= threshold(3) ?    │
└───────────┬──────────────┘
            │
     ┌──────┴──────┐
     │ 是           │ 否
     ▼              ▼
┌──────────┐   ┌──────────┐
│ 5a. 更新  │   │ 结束     │
│    CLAUDE │   │          │
│    .md    │   │          │
│    追加规则│   │          │
└─────┬─────┘   └──────────┘
      │
      ▼
┌──────────┐
│ 5b. 尝试 │
│    生成  │
│    ast-  │
│    grep  │
│    规则  │
└─────┬────┘
      │
      ▼
┌──────────┐
│ 5c. 提交 │
│    规则  │
│    更新  │
│    (MR)  │
└──────────┘
```

### Token 预算管理（200k 限制）

假设 200k 为**模型上下文窗口**（Claude 3.5 Sonnet/Opus）：

**预算分配：**
- 系统提示（角色定义 + 输出格式要求）：~1k tokens
- CLAUDE.md 规则：~3k-8k tokens（取决于项目规则长度）
- diff 内容：变量，按实际变更计算
- 输出预留：~20k tokens（给 AI 的审查结果）
- **可用审查预算**：200k - 1k - 8k - 20k = **~171k tokens**

**diff token 估算：**
- 每行变更（+/-）≈ 5-20 tokens（取决于代码长度）
- 一个典型文件 diff（30 行变更）≈ 300-600 tokens
- 171k / 500 ≈ **每批可审查 340 个文件的 diff**

**结论**：对于绝大多数 MR，200k 上下文足够单批完成审查。只有超大 MR（变更 500+ 文件）才需要分片。

**分片策略（超大 MR）：**
1. 按文件路径前缀分组（同目录文件放一起，保持上下文）
2. 每批不超过预算的 80%
3. 标记分片关系（"这是第 2/3 批审查"）
4. 优先审查高风险文件（核心模块、安全相关、配置文件）

### 多项目配置（projects.yaml）

```yaml
# CodeKeeper 多项目配置
projects:
  - id: my-project
    name: My Project
    localPath: /Users/codekeeper/workspace/your-project
    git:
      remote: git@git.example.com:group/your-project.git
      defaultBranch: main
    gitlab:
      baseUrl: https://git.example.com
      projectPath: group/your-project
      token: env:GITLAB_TOKEN
    review:
      enabled: true
      schedule: "*/30 * * * *"       # 每30分钟检查一次
      timezone: "Asia/Shanghai"
      tokenBudget: 200000
      autoFix: true
      autoFixBranchPrefix: "codekeeper/fix-"
      rulesFile: CLAUDE.md            # 相对于项目根目录
      astGrepConfig: .claude/rules/sgconfig.yml
      filter:
        excludeAuthors: [bot, ci]
        excludeDrafts: true
        minChanges: 1
        maxChanges: 300               # 超过则跳过，避免超大 MR 耗尽预算
        excludePaths:                 # 不审查的路径模式
          - "**/*.md"
          - "docs/**"
    learning:
      enabled: true
      schedule: "0 2 * * *"          # 每天凌晨2点运行学习循环
      patternThreshold: 3             # Boris 的 3 次规则
      updateClaudeMd: true
      createAstGrepRules: true
      lookbackDays: 7                 # 扫描最近7天的已合并 MR

  - id: another-project
    name: Another Project
    localPath: /Users/codekeeper/workspace/another
    # ... 类似配置
```

### 审查 Prompt 模板

```
你是一个严格的代码审查员，请审查以下代码变更。

## 项目规则
{project_rules}

## ast-grep 预检结果
{ast_grep_findings}

## 变更内容（git diff）
```diff
{diff_content}
```

## 审查要求
1. 检查是否违反上述项目规则
2. 检查安全性问题（注入、泄露、越权等）
3. 检查代码质量问题（命名、类型、重复、冗余）
4. 检查可维护性问题（复杂度、测试、文档）

对每个问题，按以下 JSON 格式输出：
{
  "findings": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "file": "文件路径",
      "line": 行号,
      "ruleId": "规则ID（如存在）",
      "message": "问题描述",
      "suggestion": "具体的修复建议或代码片段"
    }
  ],
  "summary": "审查总结",
  "autoFixable": ["可自动修复的问题索引"]
}
```

### 自动修复流程

```
1. reviewer.ts 返回 findings
2. fixer.ts 筛选 autoFixable 的问题
3. 对每个可修复问题：
   a. 切出修复分支：codekeeper/fix-{mr-iid}-{timestamp}
   b. 读取原文件内容
   c. 构建修复 prompt（文件内容 + 修改要求）
   d. 调用 Claude API 生成修改后的文件内容
   e. 写回文件
4. 运行项目验证：
   a. npm run lint（如果存在）
   b. npm run typecheck（如果存在）
   c. 失败则丢弃修复，记录日志
5. git commit + push
6. 在 MR 评论中回复："已创建修复分支 {branch}，包含自动修复"
```

### 与现有基础设施的衔接

| 现有基础设施 | CodeKeeper 如何复用 |
|-------------|--------------|
| `.claude/rules/sgconfig.yml` + security rules | 直接读取并执行 ast-grep 预检 |
| `.claude/ci/mr-review.sh` | 提取 diff 获取、评论格式化逻辑 |
| `.claude/ci/lib/gitlab-api.sh` | 复用 API 调用模式和安全检查 |
| `CLAUDE.md` | 作为审查规则源，学习循环更新目标 |
| GitLab CI `mr-review` job | **互补**：CI 做快速反馈（秒级），CodeKeeper 做深度审查（分钟级）+ 自动修复 |
| ast-grep 规则格式 | 学习循环生成的新规则可直接被 CI 使用 |

### Mac 部署方案

```bash
# 1. 安装 CodeKeeper
$ git clone <codekeeper-repo> ~/codekeeper
$ cd ~/codekeeper && npm install

# 2. 配置项目
$ cp config/projects.example.yaml config/projects.yaml
$ # 编辑 config/projects.yaml，填入项目信息

# 3. 配置环境变量
$ cat ~/.codekeeper/env
ANTHROPIC_API_KEY=sk-ant-xxxxx
GITLAB_TOKEN=glpat-xxxxx

# 4. 配置 launchd（长期运行）
$ npm run setup:mac
# 这会安装 ~/Library/LaunchAgents/com.codekeeper.review.plist

# 5. 启动
$ launchctl load ~/Library/LaunchAgents/com.codekeeper.review.plist
# 或前台运行：npm start

# 6. 查看日志
$ tail -f ~/Logs/codekeeper/codekeeper.log
```

## Implementation Tasks

### Task 1: 项目脚手架
- 初始化 npm 项目（TypeScript + Node.js >=22）
- 配置 tsconfig、eslint、prettier
- 安装依赖：simple-git, node-cron, pino, zod, dotenv
- 目录结构创建

### Task 2: 配置系统
- Zod schema 定义 projects.yaml 结构
- 配置加载器（支持环境变量插值如 `env:GITLAB_TOKEN`）
- 配置验证（本地路径存在性、token 有效性检查）
- CLI 命令：`codekeeper register <path>` 自动扫描项目生成配置

### Task 3: GitLab API 客户端
- 封装 GitLab REST API（fetch-based）
- MR 查询（列表、详情、diff、changes）
- 评论发布（创建 MR note/discussion）
- 分支创建、push（通过本地 git）
- 错误处理和重试

### Task 4: 项目同步
- simple-git 封装：clone、fetch、checkout
- SSH key 管理（支持 per-project SSH key）
- 工作目录隔离（每个项目在独立目录）
- 并发控制（避免同时操作同一仓库）

### Task 5: Diff 分析器 + Token 预算
- git diff 解析（提取变更文件、行号、内容）
- Token 估算（基于字符数 × 经验系数）
- 分片算法（按路径前缀分组，预算内最大化文件数）
- 风险评分（核心文件权重更高）

### Task 6: Prompt 构建器 + AI 审查引擎
- CLAUDE.md 读取与格式化
- ast-grep 预检结果集成
- Prompt 组装（规则 + diff + 格式要求）
- Claude API 调用（Anthropic SDK）
- 结果解析（JSON 提取与验证）
- 错误处理（API 失败、解析失败回退）

### Task 7: 自动修复
- 修复分支创建（基于 source branch）
- 文件修改 prompt（原文 + 修改要求 → 新内容）
- 本地验证（lint / typecheck 运行）
- git commit + push
- MR 评论回复

### Task 8: 学习循环
- 已合并 MR 评论获取
- 评论分类（关键词匹配 + 简单 NLP）
- 频次计数器（SQLite 或 JSON 文件持久化）
- CLAUDE.md 更新（追加规则段落）
- ast-grep 规则骨架生成（基于模式匹配）
- 规则更新 MR 创建

### Task 9: Scheduler + CLI
- node-cron 调度（per-project schedule）
- CLI 接口：`codekeeper run`（单次）、`codekeeper daemon`（后台）、`codekeeper status`
- 优雅退出（SIGTERM 处理）
- 运行状态报告

### Task 10: Mac 部署
- install.sh 安装脚本
- launchd plist 模板
- 日志轮转配置
- 健康检查端点（可选 HTTP）

### Task 11: 与 your-project 集成
- 复用现有 `.claude/rules/security/*.yml`
- 复用 `mr-review.sh` 的 diff 获取逻辑
- 适配 your-project 的 CLAUDE.md 格式
- 验证：对 fix/memory-sync 分支的 MR 进行审查测试

## Verification

1. **单元测试**：每个模块独立测试（mock GitLab API、mock Claude API）
2. **集成测试**：对测试项目创建测试 MR，验证完整流程
3. **Token 预算测试**：超大 diff 验证分片逻辑正确性
4. **端到端测试**：
   - 配置一个测试项目
   - 创建包含已知问题的测试 MR
   - 运行 CodeKeeper，验证发现所有问题
   - 验证自动修复分支被正确创建
5. **学习循环测试**：
   - 模拟 3 个同类 reviewer 评论
   - 验证 CLAUDE.md 被正确更新
   - 验证 ast-grep 规则骨架生成

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Token 预算耗尽导致审查不完整 | 分片策略 + 预算预警日志 + maxChanges 过滤 |
| 自动修复引入新 bug | 修复后强制运行 lint/typecheck，失败则丢弃 |
| GitLab API 速率限制 | 请求队列 + 指数退避重试 + 速率限制跟踪 |
| CLAUDE.md 规则冲突 | 学习循环只追加不覆盖，人工审核规则更新 MR |
| 多项目并发导致资源争抢 | per-project 队列，全局并发限制 |
| 敏感信息泄露（API key） | 环境变量管理，不提交到 git，日志脱敏 |
