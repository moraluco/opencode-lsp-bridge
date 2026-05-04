# opencode-lsp-bridge

OpenCode 多语言 LSP 桥接插件。将 opencode.json 中配置的所有 LSP Server 的能力（诊断/补全/悬停/跳转/引用）暴露为 MCP 工具，供 AI Agent 直接调用。

## 架构

```
opencode.json  ──MCP──→  opencode-lsp-bridge (Go)
  ├─ lsp.angelscript ──→  as-lsp/ (Hazelight LS, Node.js)
  ├─ lsp.cpp         ──→  clangd
  ├─ lsp.python      ──→  pyright
  └─ lsp.javascript  ──→  typescript-language-server
```

## 原理

bridge 只是一个**协议翻译器**。它不解析代码、不做语法分析，只做一件事：

```
AI 调用 MCP 工具 "lsp_completion"  →
  bridge 根据文件扩展名找到对应的 LSP Server →
  翻译为 LSP 协议请求发送给子进程 →
  等 LSP 返回结果 →
  翻译回 MCP 格式返回给 AI
```

每种语言的 LSP Server 是独立的子进程，互不影响。clangd 崩溃不会影响 Python 的 pyright。

启动时 bridge 自动向上查找 `opencode.json`，读取 `"lsp"` 段中配置的所有语言。

## 一键安装

```bash
# Windows
.\install.bat

# 之后在 opencode.json 中补上 lsp 和 mcp 段，重启 OpenCode
```

**bridge 已预编译**（Windows/Linux/macOS），无需安装 Go。AS LSP 需要 Node.js 18+。

---

## 手动安装

> 所有路径用 `$PLUGIN_DIR` 占位。替换为你 clone 本仓库的实际绝对路径。

### 1. 构建 Go bridge

```bash
cd $PLUGIN_DIR/bridge
go build -o opencode-lsp-bridge .
```

验证：
```bash
$PLUGIN_DIR/bridge/opencode-lsp-bridge   # 应打印 "starting..." 后退出
```

依赖：Go 1.21+

---

### 2. 安装 AngelScript LSP

```bash
cd $PLUGIN_DIR/as-lsp
npm install
```

验证：
```bash
node -e "require('./dist/server.js')"   # 应打印 --stdio 相关错误（正常）
node dist/server.js --stdio             # 启动后等待 stdin（正常）
```

依赖：Node.js 18+

---

### 3. 安装其他语言 LSP（可选）

每种语言的 LSP Server 相互独立。缺失的只影响对应语言，其余照常。

**C++（clangd）：**
```bash
# 方式 A：Visual Studio 2022 已自带
#   路径：C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\Llvm\x64\bin\clangd.exe
# 方式 B：从 https://github.com/llvm/llvm-project/releases 下载
# 方式 C：winget install LLVM.LLVM
```
验证：`clangd --version`

**Python（pyright）：**
```bash
npm install -g pyright
```
验证：`pyright --version`

**JavaScript/TypeScript：**
```bash
npm install -g typescript-language-server typescript
```
验证：`typescript-language-server --version`

---

### 4. 配置 opencode.json

bridge **自动发现** `opencode.json`——从自身二进制所在目录向上查找。在 `opencode.json` 的 `"lsp"` 段中添加语言：

```json
{
  "lsp": {
    "angelscript": {
      "command": ["node", "$PLUGIN_DIR/as-lsp/dist/server.js", "--stdio"],
      "extensions": [".as"]
    },
    "cpp": {
      "command": ["clangd"],
      "extensions": [".cpp", ".h", ".hpp", ".c"]
    },
    "python": {
      "command": ["pyright-langserver", "--stdio"],
      "extensions": [".py"]
    },
    "javascript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".js", ".mjs", ".ts"]
    }
  },
  "mcp": {
    "lsp-bridge": {
      "type": "local",
      "command": ["$PLUGIN_DIR/bridge/opencode-lsp-bridge"]
    }
  }
}
```

**不需要单独的 config.json。** bridge 直接读 opencode.json 的 `lsp` 段。

> 如果某个语言不在 opencode.json 中，也可以创建 `bridge/config.json` 用 `"servers"` 数组补充——bridge 会合并两份配置。

---

### 5. 随时扩展新语言

往 `opencode.json` 的 `lsp` 里加一行即可：

```json
"rust": {
  "command": ["rust-analyzer"],
  "extensions": [".rs"]
}
```

重启 opencode，5 个 MCP 工具自动覆盖 `.rs` 文件。

---

### 6. 重启 OpenCode

重启后检查：
- **侧栏**：`lsp-bridge` 显示已连接（无超时报错）
- **MCP 工具**：`lsp_diagnostics`、`lsp_completion`、`lsp_hover`、`lsp_definition`、`lsp_references` 可用

验证：对任意 `.as` 文件调用 `lsp_diagnostics`，应返回诊断信息。

## MCP 工具

| 工具 | LSP 协议 | 功能 |
|------|---------|------|
| `lsp_diagnostics` | `textDocument/publishDiagnostics` | 错误/警告/提示 |
| `lsp_completion` | `textDocument/completion` | 代码补全 |
| `lsp_hover` | `textDocument/hover` | 悬停类型信息 |
| `lsp_definition` | `textDocument/definition` | 跳转到定义 |
| `lsp_references` | `textDocument/references` | 查找所有引用 |

## 工作方式

```
bridge 启动
  ├─ 自动查找 opencode.json（从二进制目录向上遍历）
  ├─ 读取 "lsp" 段 → 建立 扩展名→LSP Server 映射表
  └─ 等待 MCP 请求

AI 调用 lsp_completion(file.as, line=24, char=25)
  ├─ bridge 根据 .as 找到 Hazelight LS
  ├─ 首次调用 → spawn 子进程 + LSP 握手（惰性启动）
  ├─ 发送 textDocument/didOpen（读取文件内容）
  ├─ 发送 textDocument/completion
  ├─ 返回结果给 AI
  └─ 后续调用直接复用已启动的子进程

后台 goroutine 持续读取 LSP stdout
  ├─ 收到 publishDiagnostics → 缓存到 diagCache
  └─ AI 调用 lsp_diagnostics → 直接从缓存返回
```

## AS LSP 说明

- 基于 Hazelight unreal-angelscript 剥离 UE 编辑器 TCP 依赖
- 混合架构：优先连接 UE 编辑器 TCP（端口 27099），不可用时降级为 `as.predefined` 静态快照
- PEG.js 解析器提供 `.as` 文件跨文件分析
- 跨文件补全和引用查找可用；悬停和跳转定义支持同文件

## 新机器部署步骤

```bash
# 1. 克隆
git clone https://github.com/moraluco/opencode-lsp-bridge.git
cd opencode-lsp-bridge

# 2. 构建 bridge
cd bridge
go build -o opencode-lsp-bridge .

# 3. 安装 AS LSP
cd ../as-lsp
npm install

# 4. 安装其他 LSP（按需）
npm install -g pyright
npm install -g typescript-language-server typescript

# 5. 修改 opencode.json 的 lsp 和 mcp 段（见上方 Step 4）

# 6. 重启 opencode
```
