import ReactMarkdown from 'react-markdown';

export function ContextView({ content }: { content: string }) {
  return <ReactMarkdown>{content}</ReactMarkdown>;
}
