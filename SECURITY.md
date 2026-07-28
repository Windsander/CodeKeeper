# Security Policy / 安全政策

## 支持的版本 / Supported Versions

仅维护 `main` 分支的最新代码，历史提交不回溯修复。

| Version                       | Supported |
| ----------------------------- | --------- |
| `main`（最新）                | ✅        |
| 历史提交 / Historical commits | ❌        |

## 报告漏洞 / Reporting a Vulnerability

**请勿通过公开 Issue 披露安全漏洞。/ Please do NOT report security vulnerabilities through public GitHub issues.**

推荐通过 GitHub [Private Vulnerability Reporting](../../security/advisories/new) 私下提交，我们会尽快确认与修复。
Preferred: report privately via [GitHub Private Vulnerability Reporting](../../security/advisories/new); we will acknowledge and address it as soon as possible.

个人维护项目，响应时间以尽力而为为准（通常 7 天内给予初步答复）。
This is an individually maintained project; responses are best-effort (initial reply usually within 7 days).

## 本项目特有的安全注意点 / Project-specific Notes

- CodeKeeper 在**本地**处理 LLM API Key、GitLab Token 等敏感凭据（`.env`，永不入库）。提交 Issue、日志或崩溃报告时，请务必先脱敏。
  CodeKeeper handles sensitive credentials (LLM API keys, GitLab tokens) **locally** via `.env`, which is never committed. Please redact credentials before sharing logs or crash reports.
- 若发现凭据意外进入 git 历史，请立即通过上述私密渠道告知，我们将重写历史并轮换凭据。
  If you find credentials accidentally committed to git history, please report via the private channel above; we will rewrite history and rotate the credentials.
