export function SuggestionList({ content }: { content: string }) {
  return (
    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'system-ui' }}>
      {content || '当前没有待处理的建议。'}
    </pre>
  );
}
