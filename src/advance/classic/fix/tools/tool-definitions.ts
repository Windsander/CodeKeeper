/**
 * 修复 Agent 暴露给 LLM 的工具 schema 定义
 */

import type { ToolDefinition } from '../../../llm/tool-types.js';

export const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description:
    '读取 worktree 中相对路径文件的内容。可指定 startLine/endLine 或 targetLine/windowLines。若传入 basename，会自动解析为唯一相对路径。',
  input_schema: {
    type: 'object',
    properties: {
      relPath: { type: 'string', description: '文件相对路径或 basename' },
      startLine: { type: 'number', description: '起始行号（1-based，可选）' },
      endLine: { type: 'number', description: '结束行号（1-based，可选）' },
      targetLine: { type: 'number', description: '窗口中心行号（可选）' },
      windowLines: { type: 'number', description: '窗口最大行数（可选，默认 80）' },
    },
    required: ['relPath'],
    additionalProperties: false,
  },
};

export const WRITE_FILE_TOOL: ToolDefinition = {
  name: 'write_file',
  description: '将内容写入 worktree 中的相对路径文件，会自动创建父目录。',
  input_schema: {
    type: 'object',
    properties: {
      relPath: { type: 'string', description: '文件相对路径' },
      content: { type: 'string', description: '要写入的完整文件内容' },
    },
    required: ['relPath', 'content'],
    additionalProperties: false,
  },
};

export const DELETE_FILE_TOOL: ToolDefinition = {
  name: 'delete_file',
  description: '从 worktree 中删除相对路径文件。仅删除明确需要移除的文件。',
  input_schema: {
    type: 'object',
    properties: {
      relPath: { type: 'string', description: '文件相对路径或 basename' },
    },
    required: ['relPath'],
    additionalProperties: false,
  },
};

export const APPLY_PATCH_TOOL: ToolDefinition = {
  name: 'apply_patch',
  description:
    '将标准 unified diff 应用到 worktree。若 git apply 失败会尝试自研 patch 应用器。',
  input_schema: {
    type: 'object',
    properties: {
      patchText: { type: 'string', description: '标准 unified diff 文本' },
    },
    required: ['patchText'],
    additionalProperties: false,
  },
};

export const RUN_SCRIPT_TOOL: ToolDefinition = {
  name: 'run_script',
  description:
    '在 worktree 中运行 package.json 里定义的 npm script。只允许白名单脚本（如 lint、typecheck、build、test、compile:packages）。',
  input_schema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: 'npm script 名称，如 lint / typecheck / build / test',
      },
    },
    required: ['script'],
    additionalProperties: false,
  },
};

export const VALIDATE_TOOL: ToolDefinition = {
  name: 'validate',
  description: '同时运行 lint 和 typecheck，返回是否通过及失败原因。',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

export const RECALL_MEMORY_TOOL: ToolDefinition = {
  name: 'recall_memory',
  description: '查询 EverOS 记忆，获取与当前问题相关的历史修复经验或项目约定。',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查询关键词' },
      type: {
        type: 'string',
        enum: ['project_knowledge', 'reviewer_preference', 'maintenance_history'],
        description: '记忆类型',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export const GET_FILE_OVERVIEW_TOOL: ToolDefinition = {
  name: 'get_file_overview',
  description: '获取 worktree 中文件的总行数和顶层符号列表。',
  input_schema: {
    type: 'object',
    properties: {
      relPath: { type: 'string', description: '文件相对路径或 basename' },
    },
    required: ['relPath'],
    additionalProperties: false,
  },
};

export const SEARCH_IN_FILE_TOOL: ToolDefinition = {
  name: 'search_in_file',
  description: '在 worktree 文件中搜索关键字，返回匹配的连续行号范围。',
  input_schema: {
    type: 'object',
    properties: {
      relPath: { type: 'string', description: '文件相对路径或 basename' },
      keyword: { type: 'string', description: '搜索关键字' },
    },
    required: ['relPath', 'keyword'],
    additionalProperties: false,
  },
};

export const RUN_SETUP_COMMAND_TOOL: ToolDefinition = {
  name: 'run_setup_command',
  description:
    '在 worktree 中执行一次环境准备命令，仅用于安装依赖或构建项目。允许示例：npm install、npm run build、cargo build、poetry install、go mod download。禁止用于 git、find、grep、ls、cat 等查询或探索命令。',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的安装/构建命令，例如 "npm install" 或 "cargo build"',
      },
      cwd: {
        type: 'string',
        description: '可选的相对 worktree 根目录的工作目录',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

export const FINISH_TOOL: ToolDefinition = {
  name: 'finish',
  description:
    '当你认为修复已完成、无法继续或需要 Reviewer 澄清时调用，结束工具循环。',
  input_schema: {
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        description: 'true 表示修复已完成并通过验证；false 表示失败或需要人工介入',
      },
      reason: {
        type: 'string',
        description: '说明当前状态，失败时解释原因',
      },
    },
    required: ['success', 'reason'],
    additionalProperties: false,
  },
};

/** 修复 Agent 默认暴露的全部工具 */
export const FIX_TOOLS: ToolDefinition[] = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  DELETE_FILE_TOOL,
  APPLY_PATCH_TOOL,
  RUN_SETUP_COMMAND_TOOL,
  RUN_SCRIPT_TOOL,
  VALIDATE_TOOL,
  RECALL_MEMORY_TOOL,
  GET_FILE_OVERVIEW_TOOL,
  SEARCH_IN_FILE_TOOL,
  FINISH_TOOL,
];
