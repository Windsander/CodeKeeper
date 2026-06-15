export function LogViewer({ lines }: { lines: string[] }) {
  return (
    <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 12, overflow: 'auto', maxHeight: '80vh' }}>
      {lines.length === 0 ? '暂无日志' : lines.join('\n')}
    </pre>
  );
}
