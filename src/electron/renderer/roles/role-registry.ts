import type { ComponentType } from 'react';
import type { Role } from '../../shared/types.js';

/**
 * 根据角色获取对应配置类型的辅助类型
 */
type RoleConfigOf<R extends Role> = R extends 'reviewer'
  ? import('../../shared/types.js').ReviewerConfig
  : R extends 'maintainer'
    ? import('../../shared/types.js').MaintainerConfig
    : never;

/**
 * 字段类型：文本输入、开关、定时调度
 */
export type FieldType = 'text' | 'toggle' | 'schedule';

/**
 * 角色字段配置：描述 UI 中一个配置项的元数据
 */
export interface RoleFieldConfig<R extends Role> {
  /** 对应 RoleConfig 中的字段名 */
  key: keyof RoleConfigOf<R>;
  /** 展示标签 */
  label: string;
  /** 字段类型 */
  type: FieldType;
  /** 默认值 */
  defaultValue: unknown;
}

/**
 * 角色 UI 配置：渲染端注册一个角色所需的完整元数据
 */
export interface RoleUIConfig<R extends Role> {
  /** 角色标识 */
  role: R;
  /** 展示名称 */
  displayName: string;
  /** 导航栏标签 */
  navLabel: string;
  /** 路由路径 */
  routePath: string;
  /** 图标组件 */
  icon: ComponentType;
  /** 默认 Soul 模板内容 */
  defaultSoulTemplate: string;
  /** Soul 文件名称 */
  soulFileName: string;
  /** 项目配置字段列表 */
  projectConfigFields: RoleFieldConfig<R>[];
  /** 默认配置 */
  defaultConfig: RoleConfigOf<R>;
}

/** 内部注册表 */
const registry = new Map<Role, RoleUIConfig<Role>>();

/**
 * 注册角色的 UI 配置
 * @param config 角色 UI 配置
 */
export function registerRoleUI<R extends Role>(config: RoleUIConfig<R>): void {
  registry.set(config.role, config as RoleUIConfig<Role>);
}

/**
 * 获取指定角色的 UI 配置
 * @param role 角色标识
 * @returns 角色 UI 配置
 * @throws 若角色未注册则抛出错误
 */
export function getRoleUI<R extends Role>(role: R): RoleUIConfig<R> {
  const config = registry.get(role);
  if (!config) throw new Error(`角色 ${role} 的 UI 配置未注册`);
  return config as RoleUIConfig<R>;
}

/**
 * 获取所有已注册角色的 UI 配置
 * @returns 所有角色 UI 配置数组
 */
export function getAllRoleUIs(): RoleUIConfig<Role>[] {
  return Array.from(registry.values());
}
