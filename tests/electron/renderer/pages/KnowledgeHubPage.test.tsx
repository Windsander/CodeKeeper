import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KnowledgeHubPage } from '../../../../src/electron/renderer/pages/KnowledgeHubPage.js';
import { LayoutProvider } from '../../../../src/electron/renderer/contexts/LayoutContext.js';

vi.mock('../../../../src/electron/renderer/hooks/useMemoryGraph.js', () => ({
  useMemoryGraph: () => ({
    graph: {
      nodes: [],
      edges: [],
      stats: {
        totalNodes: 0,
        totalEdges: 0,
        totalMemories: 0,
        projectCount: 0,
        activeDays: 0,
        dailyGrowth: [],
      },
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

describe('KnowledgeHubPage', () => {
  it('渲染单层页面 chrome 与三个智库 tab', () => {
    render(
      <LayoutProvider>
        <KnowledgeHubPage />
      </LayoutProvider>
    );
    expect(screen.getByText('智库')).toBeTruthy();
    expect(screen.getByRole('button', { name: '策展知识' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /记忆图谱/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /记忆统计/ })).toBeTruthy();
    expect(screen.getByText('从项目进入知识库')).toBeTruthy();
  });
});
