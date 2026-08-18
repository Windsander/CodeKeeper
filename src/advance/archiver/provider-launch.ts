/** uv/uvx 启动器自动继承的非敏感运行环境。 */
export const UV_LAUNCH_ENVIRONMENT_KEYS = [
  'UV_CACHE_DIR',
  'UV_NATIVE_TLS',
  'UV_NO_CONFIG',
  'UV_OFFLINE',
  'UV_PYTHON',
  'UV_PYTHON_INSTALL_DIR',
  'UV_TOOL_BIN_DIR',
  'UV_TOOL_DIR',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
] as const;

/** Python 模块启动器可显式继承的解释器和虚拟环境变量 */
export const PYTHON_LAUNCH_ENVIRONMENT_KEYS = [
  'CONDA_DEFAULT_ENV',
  'CONDA_PREFIX',
  'PYTHONHOME',
  'PYTHONIOENCODING',
  'PYTHONPATH',
  'PYTHONUTF8',
  'VIRTUAL_ENV',
] as const;
