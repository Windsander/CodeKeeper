import simpleGit from 'simple-git';

export interface GitInfo {
  /** 原始 remote URL */
  remoteUrl?: string;
  /** 推断出的 GitLab/GitHub 基础 URL，如 https://gitlab.com */
  baseUrl?: string;
  /** 推断出的项目路径，如 group/project */
  projectPath?: string;
  /** 远端默认分支名 */
  defaultBranch?: string;
  /** 本地分支列表 */
  branches: string[];
}

/**
 * 从项目本地 git 仓库推断 GitLab/GitHub 配置信息
 *
 * 支持 SSH（git@host:group/project.git）与 HTTPS 两种 remote URL 格式。
 */
export async function detectGitInfo(projectRoot: string): Promise<GitInfo> {
  const git = simpleGit(projectRoot);

  let remoteUrl: string | undefined;
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    remoteUrl = origin?.refs.fetch ?? origin?.refs.push;
  } catch {
    // 无法读取 remote 时继续返回空分支列表
  }

  let baseUrl: string | undefined;
  let projectPath: string | undefined;

  if (remoteUrl) {
    // SSH: git@gitlab.com:group/project.git
    const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (sshMatch) {
      baseUrl = `https://${sshMatch[1]}`;
      projectPath = sshMatch[2];
    } else {
      // HTTPS: https://gitlab.com/group/project.git
      try {
        const url = new URL(remoteUrl);
        baseUrl = `${url.protocol}//${url.host}`;
        projectPath = url.pathname.replace(/^\/|\.git$/g, '').replace(/^\//, '');
      } catch {
        // URL 解析失败则留空
      }
    }
  }

  let defaultBranch: string | undefined;
  try {
    const symbolicRef = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    defaultBranch = symbolicRef.trim().replace('refs/remotes/origin/', '');
  } catch {
    // 某些仓库可能没有 origin/HEAD
  }

  let branches: string[] = [];
  try {
    const branchSummary = await git.branchLocal();
    branches = branchSummary.all;
  } catch {
    // 无法读取分支时返回空列表
  }

  return { remoteUrl, baseUrl, projectPath, defaultBranch, branches };
}
