# dsh-tools

DSH (DeepSeek Harness) 插件集合仓库。目前包含 Claude Code 插件体系的桥接工具组，后续可扩展其它工具。

所有插件均为 **DSH 动态 Cordis 插件**（`cordis_define` 定义、`cordis_run` 激活），源码为纯 JavaScript，无构建步骤。插件读写一律落在 DSH 自有目录 `~/.dsh/ccbridge/plugins`，**不污染 `~/.claude`**。

## 目录结构

```
plugins/
├── cc-bridge/             Claude Code Bridge（host-only）
│   ├── plugin.json        插件元数据
│   └── host.js            code.host 函数体
├── cc-file-installer/     CC File Installer（host-only）
│   ├── plugin.json
│   └── host.js
└── cc-market/             CC插件市场 设置页（host + client）
    ├── plugin.json
    ├── host.js            code.host 函数体
    └── client.js          code.client 函数体
```

## 插件说明

### 1. cc-bridge — Claude Code Bridge（`ccode-1`）

把 Claude Code 插件体系桥接到 DSH 原生机制：

- 读取 Claude 插件声明（`plugin.json` / `SKILL.md` / `marketplace.json`），翻译为 DSH 技能注册、`harness.registerTool` 工具、`tools/pre-execute` / `tools/post-execute` 事件瀑布
- MCP 服务器懒加载：自研 stdio JSON-RPC 客户端（initialize → tools/list → tools/call），`ccmcp_refresh` 时启动并注册 `ccmcp-*` 工具，卸载时终止
- Hooks 桥接：`PreToolUse` → `tools/pre-execute`（block→deny / ask→ask），`PostToolUse` → `tools/post-execute`
- 提供工具：`ccplugin_marketplaces` / `ccplugin_search` / `ccplugin_list` / `ccplugin_details` / `ccplugin_install` / `ccplugin_toggle` / `ccplugin_manage` / `ccplugin_run_skill` / `ccbridge_list` / `ccmcp_list` / `ccmcp_refresh` / `claude_code_run` / `claude_code_status`
- 提供服务：`claudeCode`

> 注意：本版本为 DSH-owned。CLAUDE 侧（`~/.claude`）仅当用户明确要求时才通过显式 `ccplugin_*` 工具读写；技能桥接注册默认禁用（`ccbridge_list` 仅列出不注册）。

### 2. cc-file-installer — CC File Installer（`ccfi-3`）

纯文件方式管理 Claude 插件市场与插件，完全不用 claude CLI、不碰 `~/.claude`：

- 市场：git clone / 本地复制 → `~/.dsh/ccbridge/plugins/marketplaces/<name>`，记账于 `known_marketplaces.json`
- 安装：解析 manifest → 按版本目录落 `~/.dsh/ccbridge/plugins/cache/<market>/<plugin>/<ver>`，记账于 `installed_plugins.json`
- 工具：`ccmarket_file`（add/remove/update 市场）、`ccinstall_file`（安装）、`ccuninstall_file`（卸载）、`ccrescan_skills`（刷新技能目录缓存）

### 3. cc-market — CC插件市场（`cmar-4`）

WebUI 设置页「CC插件市场」：市场列表（插件名/描述/分类/作者/安装状态）、筛选搜索、安装/升级/卸载、添加/更新/移除市场、刷新技能目录。宿主复用 cc-file-installer 的文件引擎（`cm.*` handlers），客户端注入 `settings.section` slot（id: `plugin-market`）。

## 在 DSH 中加载

两种方式，二选一：

### 方式 A：动态加载（进程级，重启后需重新激活）

源码文件是 `cordis_define` 的 `code.host` / `code.client` 函数体，原样粘贴即可：

```text
cordis_define(plugin: {kind: "new", idPrefix: "ccxx"}, name: ..., purpose: ...,
  code: {host: <plugins/cc-*/host.js 内容>, client: <plugins/cc-market/client.js 内容，可选>})
```

然后 `cordis_run` 激活（带 client 的包需浏览器审批）。

### 方式 B：包插件持久安装（推荐，重启后仍在）

`packages/` 下是与 `plugins/` 同源的 npm 包形态（`scripts/build-packages.mjs` 自动生成），
host 代码经 harness 垫片桥接到包插件 API（`ctx.tools.register` / `defineTool`），
cc-market 的 `cm.*` RPC 改为 `ctx.webServer` HTTP 路由（`/api/cc-market/*`），
client 的 `host.call` 改为 `fetch`，可在 Web 设置页「CC插件市场」直接管理。

```bash
# 1. 构建包（若 packages/ 缺失或源码有更新）
node scripts/build-packages.mjs

# 2. 官方 CLI 安装到 web profile（等价于 pnpm add link:，自动进 bundles 层）
dsh plugin --profile web add link:$(pwd)/packages/dsh-cc-bridge
dsh plugin --profile web add link:$(pwd)/packages/dsh-cc-market

# 3. 重启 dsh web 生效
```

> 注意：包内 import 仅 `@deepseek-ai/dsh-tools`（profile 模块回退目录 `$DSH_HOME/profiles/node_modules`
> 提供）；若从源码目录直接运行请勿用软链（Node 按真实路径解析会找不到依赖），拷贝或 `link:` 安装均可。

## 默认市场

`defaults/known_marketplaces.json` 是首次使用时的推荐市场清单（官方市场）。市场页/工具在 `~/.dsh/ccbridge/plugins/known_marketplaces.json` 为空时，先按该清单初始化：

```bash
# 手动方式：在 CC插件市场 页面的「添加市场」框输入 owner/repo
anthropics/claude-plugins-official
```

## 目录约定

- 所有数据落 `~/.dsh/ccbridge/plugins`，权限敏感文件（如 SSH 配置）不在本仓库
- `spawnCli().ok` 仅表示进程跑完，成功判断一律用 `exitCode === 0`（`ok0()` helper）

## License

MIT
