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

- CodeKeeper 在**本地**处理 LLM API Key、GitLab Token 等敏感凭据（`daemon-config.json`，永不入库）。提交 Issue、日志或崩溃报告时，请务必先脱敏。
  CodeKeeper handles sensitive credentials (LLM API keys, GitLab tokens) **locally** via `daemon-config.json`, which is never committed. Please redact credentials before sharing logs or crash reports.
- MCP 门面（外部 Agent 接入点）仅绑定 `127.0.0.1` 并携带启动期随机 token；其 `pipeline_submit` 具有真实世界写副作用（评审评论、代码修复、MR 合并）。**绑定本机即信任本机全部进程**——请勿在共享/多租户机器上运行，勿把门面 URL 转发到本机之外。
  The MCP facade binds to `127.0.0.1` with a per-boot random token; `pipeline_submit` has real-world write side effects. Running on this host implies trusting all local processes — do not run on shared machines or forward the facade URL off-host.
- 若发现凭据意外进入 git 历史，请立即通过上述私密渠道告知，我们将重写历史并轮换凭据。
  If you find credentials accidentally committed to git history, please report via the private channel above; we will rewrite history and rotate the credentials.
