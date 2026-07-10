/**
 * patch-applier 单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  parsePatch,
  applyPatch,
  applyPatches,
} from '../../../../src/advance/classic/fix/patch-applier.js';

describe('parsePatch', () => {
  it('解析单行替换补丁', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,3 @@
   const x = 1;
-  const y = 2;
+  const y = 3;
   console.log(x, y);
`;
    const patches = parsePatch(diff);
    expect(patches).toHaveLength(1);
    expect(patches[0].oldPath).toBe('src/a.ts');
    expect(patches[0].newPath).toBe('src/a.ts');
    expect(patches[0].hunks).toHaveLength(1);
    expect(patches[0].hunks[0].oldStart).toBe(10);
    expect(patches[0].hunks[0].oldLines).toBe(3);
    expect(patches[0].hunks[0].newLines).toBe(3);
  });

  it('解析多文件补丁', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-a
+b
 c
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,1 +5,2 @@
 x
+y
`;
    const patches = parsePatch(diff);
    expect(patches).toHaveLength(2);
    expect(patches[0].oldPath).toBe('src/a.ts');
    expect(patches[1].oldPath).toBe('src/b.ts');
  });

  it('解析新增行补丁', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
@@ -5,3 +5,4 @@
 one
 two
+two.point five
 three
`;
    const patches = parsePatch(diff);
    expect(patches[0].hunks[0].lines).toHaveLength(4);
    const added = patches[0].hunks[0].lines.find((l) => l.type === 'add');
    expect(added?.content).toBe('two.point five');
  });

  it('解析省略 diff --git 头的补丁', () => {
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -2,1 +2,1 @@
-old
+new
`;
    const patches = parsePatch(diff);
    expect(patches).toHaveLength(1);
    expect(patches[0].oldPath).toBe('src/a.ts');
    expect(patches[0].newPath).toBe('src/a.ts');
    expect(patches[0].hunks).toHaveLength(1);
  });

  it('解析多文件省略 diff --git 头的补丁', () => {
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-a
+b
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-x
+y
`;
    const patches = parsePatch(diff);
    expect(patches).toHaveLength(2);
    expect(patches[0].oldPath).toBe('src/a.ts');
    expect(patches[1].oldPath).toBe('src/b.ts');
  });
});

describe('applyPatch', () => {
  it('应用单行替换', () => {
    const original = `line1\nline2\nline3\n`;
    const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,1 @@
-line2
+line2-fixed
`;
    const patch = parsePatch(diff)[0];
    const result = applyPatch(original, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe('line1\nline2-fixed\nline3\n');
  });

  it('应用新增行', () => {
    const original = `one\ntwo\nthree\n`;
    const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,2 @@
 two
+two.point five
`;
    const patch = parsePatch(diff)[0];
    const result = applyPatch(original, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe('one\ntwo\ntwo.point five\nthree\n');
  });

  it('应用删除行', () => {
    const original = `one\ntwo\nthree\n`;
    const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,0 @@
-two
`;
    const patch = parsePatch(diff)[0];
    const result = applyPatch(original, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe('one\nthree\n');
  });

  it('应用多 hunk', () => {
    const original = `a\nb\nc\nd\ne\n`;
    const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,3 @@
 a
+x
 b
@@ -5,1 +6,1 @@
-e
+y
`;
    const patch = parsePatch(diff)[0];
    const result = applyPatch(original, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe('a\nx\nb\nc\nd\ny\n');
  });

  it('上下文不匹配时返回冲突', () => {
    const original = `a\nb\nc\n`;
    const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,1 @@
-WRONG
+x
`;
    const patch = parsePatch(diff)[0];
    const result = applyPatch(original, patch);
    expect(result.success).toBe(false);
    expect(result.conflict).toBeDefined();
  });

  it('保留无换行结尾', () => {
    const original = 'line1\nline2';
    const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -2,1 +2,1 @@
-line2
+line2-fixed
`;
    const patch = parsePatch(diff)[0];
    const result = applyPatch(original, patch);
    expect(result.success).toBe(true);
    expect(result.content).toBe('line1\nline2-fixed');
  });
});

describe('applyPatches', () => {
  it('连续应用两个补丁', () => {
    const original = `one\ntwo\nthree\n`;
    const p1 = parsePatch(`diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,1 +1,1 @@
-one
+1
`)[0];
    const p2 = parsePatch(`diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -3,1 +3,1 @@
-three
+3
`)[0];
    const result = applyPatches(original, [p1, p2]);
    expect(result.success).toBe(true);
    expect(result.content).toBe('1\ntwo\n3\n');
  });
});
