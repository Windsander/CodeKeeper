interface FileTreeNode {
  name: string;
  path: string;
  relPath: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

function TreeNode({ node, depth = 0 }: { node: FileTreeNode; depth?: number }) {
  const paddingLeft = depth * 16 + 8;
  const isDir = node.type === 'directory';

  return (
    <div className="file-tree-node">
      <div
        className={`file-tree-row ${isDir ? 'directory' : 'file'}`}
        style={{ paddingLeft }}
        title={node.path}
      >
        <span className="file-tree-icon">{isDir ? '📁' : '📄'}</span>
        <span className="file-tree-name">{node.name}</span>
      </div>
      {isDir && node.children && node.children.length > 0 && (
        <div className="file-tree-children">
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ArchiveTree({ tree }: { tree: FileTreeNode | null }) {
  if (!tree) {
    return <div className="empty-state">归档位置尚未生成文件结构</div>;
  }

  return (
    <div className="file-tree">
      <TreeNode node={tree} />
    </div>
  );
}
