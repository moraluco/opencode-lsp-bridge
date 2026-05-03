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

## Quick Start

1. **Build the bridge:**
   ```bash
   cd bridge
   go build -o mt-lsp-bridge .
   ```

2. **Install AS LSP deps:**
   ```bash
   cd ../as-lsp
   npm install
   ```

3. **Install language LSP servers:**
   - C++: `clangd` (LLVM) — ensure in PATH
   - Python: `npm install -g pyright`
   - JS: `npm install -g typescript-language-server typescript`

4. **Configure opencode.json:**
   ```json
   {
     "lsp": {
       "angelscript": {
         "command": ["node", "path/to/as-lsp/dist/server.js", "--stdio"],
         "extensions": [".as"]
       }
     },
     "mcp": {
       "lsp-bridge": {
         "type": "local",
         "command": ["path/to/bridge/mt-lsp-bridge"]
       }
     }
   }
   ```

5. **Restart opencode** — 5 MCP tools auto-register.

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
