<div align=center id=readme-top>

# CodeKeeper Advance

**A local-first, multi-project agent collaboration and knowledge-base workbench.**

[English](README.md) · [中文](README.zh-CN.md)

</div>

> [!WARNING]
> Version `0.1.0` is an Alpha release. Validate it in a test project or a protected branch before using it with important repositories.

<details>
  <summary><kbd>Table of Contents</kbd></summary>

<br>

- [Overview](#overview)
- [Core Capabilities](#core-capabilities)
- [EverOS Memory System](#everos-memory-system)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [CLI](#cli)
- [Local Data](#local-data)
- [Development Commands](#development-commands)
- [Security and Privacy](#security-and-privacy)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License and Rights](#license-and-rights)

<br>

</details>

## Overview

CodeKeeper Advance is a local-first desktop workbench for multi-project agent collaboration and knowledge management. Long-running **Reviewer**, **Maintainer**, and **Archiver** roles coordinate code review, finding maintenance, knowledge archiving, and persistent memory in one workspace.

The project is designed for teams that want an observable, recoverable automation loop rather than a one-shot script. The Electron workbench exposes project configuration, role status, logs, memory views, and archive history, while the Node.js daemon owns scheduling and role lifecycles.

## Core Capabilities

| Capability               | Description                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-project management | Register multiple local projects with independent archive locations, GitLab settings, role switches, and runtime state.                       |
| Reviewer                 | Scan Merge Requests and produce structured review findings from project rules, changes, and historical memory.                                |
| Maintainer               | Re-check findings, attempt fixes in an isolated Git worktree, validate changes, and deliver recoverable discussion replies.                   |
| Archiver                 | Organize project documentation through a file-first pipeline with archive, reorganize, ignore, mark, and undo operations.                     |
| Persistent memory        | Use EverOS for project knowledge, role experience, cases, and skills, with graph and statistics views.                                        |
| Desktop workbench        | Manage projects, role settings, service health, logs, memory graphs, and archive history from Electron + React.                               |
| Daemon and CLI           | Run scheduling, IPC, model access, and role lifecycles through the Node.js daemon; use the CLI for registration, scanning, history, and undo. |

The sections below describe the memory boundary, local setup, operational safeguards, and release rights.

## EverOS Memory System

CodeKeeper Advance uses **EverOS** as its long-term memory layer. The EverOS source is included as a Git submodule at `vendor/everos`.

- EverOS runs as a local sidecar service; the main process accesses memory through HTTP and an MCP bridge.
- The first role-service startup creates an isolated Python virtual environment under the user data directory and installs EverOS from the submodule.
- Memories are project-scoped by default. Reviewer, Maintainer, and Archiver memories are attached to the corresponding project node.
- Only knowledge intended for reuse across projects should be attached to the system-level node, so project contexts do not contaminate one another.
- Local embedding and reranking models are used for memory retrieval; the first run may download model files.
- EverOS data is stored locally by default. If remote LLM or multimodal providers are enabled, required context may still be sent to those configured services.

> [!NOTE]
> CodeKeeper Advance does not claim ownership of EverOS. `vendor/everos` remains under its own Apache License 2.0 terms. Use, modification, and redistribution must follow that license and the upstream `LICENSE` and `NOTICE` files. See [License and Rights](#license-and-rights) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Architecture

The runtime is organized around a small set of local services:

- **Electron workbench** — project registration, role settings, health, logs, memory views, and archive history.
- **Node.js daemon and IPC** — scheduling, configuration, model access, and role lifecycles.
- **Reviewer / Maintainer / Archiver** — review, fix, and file-first archive pipelines.
- **GitLab provider and isolated worktrees** — remote MR operations and controlled code changes.
- **EverOS MCP bridge and local service** — project-scoped long-term memory.

## Quick Start

> Goal: start the desktop workbench, configure one project, and validate a role in a controlled repository.

### 0. Prerequisites

- Node.js `>= 22`
- npm
- Python `>= 3.12` with `venv` and `pip`
- Git
- Network access to the configured model providers
- GitLab project access and a token with the permissions required by the selected role

The project is primarily developed and validated on Windows. Cross-platform path handling is included, but the complete Linux and macOS desktop flow should be validated separately.

### 1. Clone the repository and submodules

Replace `YOUR_REPOSITORY_URL` with the GitHub repository URL:

```bash
git clone --recurse-submodules YOUR_REPOSITORY_URL
cd codekeeper-advance
```

If the repository was already cloned, initialize EverOS with:

```bash
git submodule update --init --recursive
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the desktop development environment

```bash
npm run electron:dev:all
```

This builds the backend and starts the daemon, Vite, the Electron TypeScript watcher, and the desktop window. The first role-service startup may take additional time while the EverOS virtual environment and local models are initialized.

### 4. Complete the desktop setup

1. Configure the Agent LLM in **Settings**.
2. Select local embedding and reranking models; configure an EverOS multimodal model only when needed.
3. Register a local project from the **Dashboard** and choose an independent archive location when appropriate.
4. Enter the GitLab project URL, token, filters, and role settings on the role page.
5. Enable roles in a test project first, inspect the logs, and expand the scope only after the behavior is understood.

## Configuration

### Application-level configuration

Desktop settings are written to:

```text
~/.codekeeper-advance/daemon-config.json
```

The main settings include:

- Agent LLM provider, API key, base URL, model, and custom headers
- Scan interval and per-minute request limits
- Local embedding and reranking models
- EverOS multimodal model overrides

The Advance desktop flow uses the desktop settings and `daemon-config.json` as its source of truth. The root `.env.example` exists for compatibility entry points and should not be treated as the only desktop configuration source.

### Project-level configuration

Project registration, GitLab settings, and role settings are stored in the local metadata database. Documentation scanning rules are read from this file by default:

```text
<project>/.codekeeper/config.yaml
```

Example:

```yaml
name: example-project
include:
  - '**/*.md'
  - '**/*.yaml'
exclude:
  - '**/node_modules/**'
  - '**/.git/**'
  - '**/dist/**'
  - '**/release/*-unpacked/**'
categories:
  - architecture
  - operations
docTypes:
  - guide
  - decision
```

When no archive location is specified, archive output is written to the project's `.codekeeper` directory. A separate directory outside the repository can also be selected when registering the project.

## CLI

In development mode, invoke the CLI with `npm run dev --`:

```bash
npm run dev -- register /path/to/project
npm run dev -- list
npm run dev -- status
```

| Command                                           | Purpose                                              |
| ------------------------------------------------- | ---------------------------------------------------- |
| `register <project-path> [--archive-root <path>]` | Register a project and an optional archive location. |
| `unregister <project-id>`                         | Unregister a project.                                |
| `list`                                            | List registered projects.                            |
| `start [--api-key <key>]`                         | Start the daemon.                                    |
| `process <project-path> --api-key <key>`          | Run one archive cycle for a registered project.      |
| `status`                                          | Show project and pending-event status.               |
| `history <project-path>`                          | Show archive-action history.                         |
| `undo <action-id> <project-path>`                 | Undo a specific archive action.                      |

After building, the same entry points can be used with:

```bash
npm run build
npm start
```

Running `npm link` also exposes a `codekeeper` command. Full role and GitLab configuration is currently best completed through the Electron workbench.

## Local Data

| Path                                     | Contents                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `~/.codekeeper-advance/`                 | Daemon configuration, SQLite metadata, and IPC files.                                  |
| `~/.codekeeper/everos-venv/`             | Automatically created EverOS Python virtual environment.                               |
| `~/.codekeeper/everos-data/`             | EverOS configuration and long-term memory data.                                        |
| `~/.codekeeper/memory/`                  | Project role state, Soul files, and supporting memory files.                           |
| `<project>/.codekeeper/`                 | Default project configuration and archive output; can be moved outside the repository. |
| `<project-parent>/.codekeeper-worktree/` | Isolated worktrees used by Maintainer.                                                 |
| `~/Logs/codekeeper/`                     | Application and role-agent logs.                                                       |

## Development Commands

| Command                    | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `npm run build`            | Compile TypeScript and copy schemas and prompts.         |
| `npm run electron:dev:all` | Start the complete desktop development environment.      |
| `npm run electron:build`   | Build the Electron renderer and main/preload TypeScript. |
| `npm test`                 | Run the project test entry point.                        |
| `npm run test:vitest`      | Run Vitest directly.                                     |
| `npm run lint`             | Check TypeScript under `src`.                            |
| `npm run format`           | Check Prettier formatting.                               |

The repository does not yet provide a formal installer release flow. `electron:build` produces build artifacts but does not create a platform installer.

## Security and Privacy

- API keys and GitLab tokens are stored in local configuration files or SQLite metadata; protect the user data directory and never commit or share these files.
- Maintainer can modify code, run validation, and interact with remote branches. Use least-privilege tokens and validate automatic-fix policies in a controlled project first.
- Project rules, MR content, code snippets, and recalled memories may enter the configured model context. Select model services according to your organization's data policy.
- EverOS services and memory data run locally by default, but local memory does not make the entire Agent workflow offline.
- New tests should use temporary directories, fixtures, or virtual repositories instead of writing to a developer's real project path.

## Limitations

- The current MR provider primarily targets GitLab.
- The desktop application is still source-based and does not yet ship a signed installer.
- Credentials are not yet integrated with operating-system secure storage.
- The complete cross-platform desktop flow and long-running stability still require more public-environment validation.

## Contributing

Issues, design suggestions, and pull requests are welcome. Before submitting, run at least:

```bash
npm run build
npm run test:vitest
npm run lint
npm run format
```

Do not submit real tokens, user directories, private project paths, model caches, runtime logs, or local EverOS data.

## License and Rights

- The MIT License in [`LICENSE`](LICENSE) applies only to original CodeKeeper Advance code, documentation, and other materials for which the project has the right to grant that license. It does not cover `vendor/everos`, third-party dependencies, dataset fixtures, or other separately marked materials.
- CodeKeeper Advance original materials carry `Copyright © 2026 SobertLi`. This notice does not change the copyright, trademark, or other rights of third-party components and does not claim ownership of EverOS.
- EverOS is located at `vendor/everos` and remains under Apache License 2.0. Within that license's conditions, it may be used, modified, turned into derivative works, and redistributed; redistribution must preserve its `LICENSE`, `NOTICE`, and applicable copyright notices. Apache License 2.0 does not grant permission to use EverOS trademarks.
- EverOS also contains separately licensed test fixtures and notes for optional dependencies. Read [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the submodule's `NOTICE` before redistributing.
- npm, Python, and model dependencies remain subject to their own licenses and terms of use.

This project makes no promise about a third-party component's chain of title beyond the applicable license text. Before publishing a binary, container image, or source archive that contains forked commits, custom changes, or a complete dependency set, verify provenance, contributor authorization, and redistribution conditions, and generate a third-party license inventory matching the actual release.

Copyright © 2026 SobertLi

<div align=right>

[Back to top](#readme-top)

</div>
