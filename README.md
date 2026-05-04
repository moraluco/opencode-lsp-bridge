# mt-lsp-bridge

Multi-language LSP bridge for OpenCode — exposes **diagnostics, completion, hover, definition, references** for AS/C++/Python/JS via MCP tools.

## Architecture

```
opencode.json → MCP → mt-lsp-bridge (Go)
                        ├── as-lsp/ (Hazelight LS, Node.js) → AngelScript
                        ├── clangd → C++
                        ├── pyright → Python
                        └── typescript-language-server → JS/MJS
```

## Installation (for AI Agent)

> All paths use a placeholder `$PLUGIN_DIR`. Replace it with the absolute path where you cloned this repo.

### Step 1: Build Go MCP Bridge

```bash
cd $PLUGIN_DIR/bridge
go build -o mt-lsp-bridge .
```

Verification:
```bash
$PLUGIN_DIR/bridge/mt-lsp-bridge  # should print "mt-lsp-bridge starting..." then exit
```

Requirements: Go 1.21+

---

### Step 2: Install AngelScript LSP Dependencies

```bash
cd $PLUGIN_DIR/as-lsp
npm install
```

Verification:
```bash
node -e "require('./dist/server.js')"    # should print error about --stdio (expected)
node dist/server.js --stdio              # starts and waits for stdin (expected)
```

Requirements: Node.js 18+

---

### Step 3: Install Other Language LSP Servers (optional)

Each language LSP server is independently optional. Missing servers produce a clear error for their tools, other languages continue working.

**C++ (clangd):**
```bash
# Option A: Already installed with Visual Studio 2022
#   Path: C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\Llvm\x64\bin\clangd.exe
# Option B: Install LLVM from https://github.com/llvm/llvm-project/releases
# Option C: winget install LLVM.LLVM
```
Verification: `clangd --version`

**Python (pyright):**
```bash
npm install -g pyright
```
Verification: `pyright --version`

**JavaScript/TypeScript:**
```bash
npm install -g typescript-language-server typescript
```
Verification: `typescript-language-server --version`

---

### Step 4: Configure opencode.json

The bridge **auto-discovers** your `opencode.json` — it walks up from the binary's directory to find it. Add LSP servers to the `"lsp"` section:

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
      "command": ["$PLUGIN_DIR/bridge/mt-lsp-bridge"]
    }
  }
}
```

**No separate config.json needed.** The bridge reads whatever languages you have in `opencode.json`'s `lsp` section.

> If you need a language that's not in opencode.json, you can still create `bridge/config.json` with a `"servers"` array — the bridge merges both sources.

### Step 5: Add new languages anytime

Just add another entry to `opencode.json` → `lsp`:

```json
"rust": {
  "command": ["rust-analyzer"],
  "extensions": [".rs"]
}
```

Restart opencode, the 5 MCP tools automatically cover `.rs` files too.

---

### Step 6: Restart OpenCode

After restart, check:
- **Sidebar**: `lsp-bridge` shows as connected (no timeout error)
- **MCP tools**: `lsp_diagnostics`, `lsp_completion`, `lsp_hover`, `lsp_definition`, `lsp_references` available

Verification:
```
Call:  lsp_diagnostics  on any .as file → should return diagnostics
Call:  lsp_completion   on an .as file  → should return completion items
```

## MCP Tools

| Tool | LSP Protocol | Description |
|------|-------------|-------------|
| `lsp_diagnostics` | `textDocument/publishDiagnostics` | Errors/warnings/hints |
| `lsp_completion` | `textDocument/completion` | Code completion |
| `lsp_hover` | `textDocument/hover` | Type info on hover |
| `lsp_definition` | `textDocument/definition` | Go to definition |
| `lsp_references` | `textDocument/references` | Find all references |

## Config

Edit `bridge/config.json` to configure LSP servers:

```json
{
  "servers": [
    {
      "language": "angelscript",
      "extensions": [".as"],
      "command": "node",
      "args": ["../as-lsp/dist/server.js", "--stdio"],
      "cwd": "../as-lsp"
    },
    {
      "language": "cpp",
      "extensions": [".cpp", ".h"],
      "command": "clangd"
    }
  ]
}
```

## AS LSP Notes

- Hazelight LS stripped of UE editor TCP dependency
- Hybrid: TCP (UE Editor) preferred, `as.predefined` static snapshot as fallback
- PEG.js parser provides cross-file AS analysis
- Cross-file completion + references work; hover/definition for same-file symbols
