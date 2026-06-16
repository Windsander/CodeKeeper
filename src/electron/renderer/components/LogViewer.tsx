import { useEffect, useRef } from 'react';

export function LogViewer({ lines }: { lines: string[] }) {
  const bottomRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lines]);

  if (lines.length === 0) {
    return (
      <div className="empty-state">
        <h3>暂无日志</h3>
        <p>守护进程运行后会产生日志输出。</p>
      </div>
    );
  }

  return (
    <pre className="log-viewer">
      {lines.join('\n')}
      <span ref={bottomRef} style={{ display: 'block', height: 1 }} />
    </pre>
  );
}
