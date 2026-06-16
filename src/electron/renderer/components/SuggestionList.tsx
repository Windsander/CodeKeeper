export function SuggestionList({ content }: { content: string }) {
  if (!content.trim()) {
    return (
      <div className="empty-state">
        <h3>当前没有待处理的建议</h3>
        <p>项目扫描后，这里会显示 LLM 生成的归档建议。</p>
      </div>
    );
  }

  return <pre className="log-viewer">{content}</pre>;
}
