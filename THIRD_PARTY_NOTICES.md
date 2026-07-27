# Third-Party Notices

本文件说明 CodeKeeper Advance 仓库中需要单独保留的主要第三方许可边界。它不是完整依赖清单，也不替代各组件随附的许可证文本。

本项目不主张拥有下列第三方组件的版权、商标或其他权利。CodeKeeper Advance 仅在各组件自身许可证允许的范围内使用它们；是否可以修改或重新分发，以对应许可证和实际发布物为准。

## EverOS

- 位置：`vendor/everos`
- 上游项目：EverOS
- 版权所有：Copyright 2025 EverMind AI
- 许可证：Apache License 2.0
- 完整许可证：`vendor/everos/LICENSE`
- 上游声明：`vendor/everos/NOTICE`

EverOS 通过 Git submodule 引入，不受本仓库根目录 MIT License 的重新许可。本项目不主张拥有 EverOS；CodeKeeper Advance 依据 Apache License 2.0 使用它，并可在该许可证条件允许的范围内复制、修改、制作衍生作品和重新分发。复制、修改或重新分发 EverOS 时，应继续满足 Apache License 2.0，并保留其 `LICENSE`、`NOTICE` 与适用的版权声明。该许可证不授予 EverOS 的商标使用权。

当前 submodule 可能包含 fork 或定制提交。对外发布前，应核验该固定提交的来源、贡献者授权和再分发权限；本文件不替代这项权利链核验。

### EverOS 上游许可例外

EverOS 的 `NOTICE` 当前列出了以下额外边界：

1. `vendor/everos/tests/fixtures/long_conversation_locomo_caroline_melanie.json`
   - 来源：LoCoMo dataset fixture
   - 许可证：Creative Commons Attribution-NonCommercial 4.0 International（CC BY-NC 4.0）
   - 该文件不属于 EverOS 的 Apache-2.0 授权范围，重新分发和使用时需遵守非商业限制。

2. CairoSVG
   - 许可证：GNU Lesser General Public License v3.0（LGPL-3.0）
   - 它是 EverOS `multimodal` extra 可能引入的可选依赖，默认安装不包含该 extra。
   - 如果显式启用、修改或重新分发 CairoSVG，请遵守其独立许可证。

以上信息根据当前 submodule 中的 `vendor/everos/NOTICE` 整理。升级 EverOS submodule 后，应同步复核本文件。

## JavaScript 与 Python 依赖

本项目使用的 npm 与 Python 依赖由各自作者提供，并继续受各自许可证约束。依赖版本可从以下文件核对：

- `package.json`
- `package-lock.json`
- `vendor/everos/pyproject.toml`
- `vendor/everos/uv.lock`

发布二进制包、容器镜像或重新分发完整依赖集合时，请生成与发布物一致的第三方许可证清单，并保留所有要求的版权和 NOTICE 文件。
