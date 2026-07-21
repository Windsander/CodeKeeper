/**
 * 测试辅助：把部分 mock 对象标记为目标类型。
 *
 * `Partial<T>` → `T` 是 TypeScript 允许的向下转型，因此可以替代
 * `as unknown as T` 双重断言：既保留属性级的类型检查（写错属性名/类型会报错），
 * 又不需要绕过类型系统的 `unknown`。
 *
 * 用法：
 * ```ts
 * const provider = mockOf<GitLabProvider>({ getMRDiff: vi.fn() });
 * ```
 */
export function mockOf<T>(parts: Partial<T>): T {
  return parts as T;
}
