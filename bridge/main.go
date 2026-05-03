package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// --------------- MCP Protocol Types ---------------

// MCPRequest represents a JSON-RPC request from the MCP client (opencode / any MCP host).
type MCPRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// MCPResponse represents a JSON-RPC response to the client.
type MCPResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Result  interface{} `json:"result,omitempty"`
	Error   *MCPError   `json:"error,omitempty"`
}

// MCPError represents a JSON-RPC error object.
type MCPError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// MCPTool is the schema descriptor for one tool in tools/list response.
type MCPTool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema InputSchema `json:"inputSchema"`
}

// InputSchema is a JSON Schema object describing a tool's parameters.
type InputSchema struct {
	Type       string                    `json:"type"`
	Properties map[string]PropSchema     `json:"properties"`
	Required   []string                  `json:"required"`
}

// PropSchema describes one parameter property.
type PropSchema struct {
	Type        string `json:"type"`
	Description string `json:"description"`
}

// ToolCallParams is the params body of a tools/call request.
type ToolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// --------------- Global State ---------------

// lspClients maps file extension → LSP client instance.
// Multiple extensions may share the same LSPClient (e.g. .cpp and .h → clangd).
var lspClients map[string]*LSPClient

// configPath flag, overridable via command-line arg.
var configPath string

func init() {
	// Default config path: same directory as the executable, named "config.json"
	exe, err := os.Executable()
	if err == nil {
		configPath = filepath.Join(filepath.Dir(exe), "config.json")
	} else {
		configPath = "config.json"
	}
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("mt-lsp-bridge starting...")

	// Parse command-line flags (simple approach, no flag package to keep deps minimal)
	// Usage: mt-lsp-bridge [-config path/to/config.json]
	if len(os.Args) > 1 {
		for i := 0; i < len(os.Args); i++ {
			if os.Args[i] == "-config" && i+1 < len(os.Args) {
				configPath = os.Args[i+1]
				i++
			}
		}
	}

	// Load config
	cfg, err := LoadConfig(configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}
	log.Printf("Loaded %d LSP server configuration(s) from %s", len(cfg.Servers), configPath)

	// Initialize LSP client registry from config (servers are NOT started yet;
	// they are started lazily on first use via EnsureStarted).
	lspClients = make(map[string]*LSPClient)
	for _, sc := range cfg.Servers {
		client := NewLSPClient(sc)
		for _, ext := range sc.Extensions {
			// Normalize extension: ensure leading "."
			if !strings.HasPrefix(ext, ".") {
				ext = "." + ext
			}
			lspClients[ext] = client
		}
		log.Printf("  Registered: [%s] -> %s %s", sc.Language, sc.Command, strings.Join(sc.Args, " "))
	}

	// Enter main loop: read JSON-RPC messages from stdin (MCP stdio transport).
	reader := bufio.NewReader(os.Stdin)
	for {
		msg, err := readStdioMessage(reader)
		if err != nil {
			if err == io.EOF {
				log.Println("stdin closed, shutting down")
				return
			}
			log.Printf("Error reading message: %v", err)
			continue
		}
		go handleMessage(msg)
	}
}

// --------------- MCP Stdio Transport ---------------

// readStdioMessage reads one Content-Length framed message from the reader.
// Format: "Content-Length: N\r\n\r\n<body_of_N_bytes"
func readStdioMessage(reader *bufio.Reader) ([]byte, error) {
	contentLength := 0
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		// Trim \r\n or \n
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			// End of headers
			break
		}
		const prefix = "Content-Length: "
		if strings.HasPrefix(line, prefix) {
			contentLength, err = strconv.Atoi(line[len(prefix):])
			if err != nil {
				return nil, fmt.Errorf("invalid Content-Length value: %v", err)
			}
		}
	}
	if contentLength <= 0 {
		return nil, fmt.Errorf("missing or invalid Content-Length header")
	}

	body := make([]byte, contentLength)
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil, fmt.Errorf("failed to read body: %v", err)
	}
	return body, nil
}

// writeStdioMessage writes data to stdout with Content-Length framing.
func writeStdioMessage(data []byte) error {
	header := fmt.Sprintf("Content-Length: %d\r\n\r\n", len(data))
	if _, err := os.Stdout.Write([]byte(header)); err != nil {
		return err
	}
	_, err := os.Stdout.Write(data)
	return err
}

// --------------- Message Dispatcher ---------------

// handleMessage parses a JSON-RPC message and dispatches it.
func handleMessage(raw []byte) {
	var req MCPRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		log.Printf("Failed to parse request JSON: %v", err)
		return
	}

	// Notifications have no "id" field — fire-and-forget.
	if req.ID == nil {
		handleNotification(req)
		return
	}

	id := *req.ID
	switch req.Method {
	case "initialize":
		handleInitialize(id, req.Params)
	case "notifications/initialized":
		log.Println("MCP client initialized")
		sendResult(id, map[string]interface{}{})
	case "tools/list":
		handleToolsList(id)
	case "tools/call":
		handleToolCall(id, req.Params)
	default:
		sendError(id, -32601, fmt.Sprintf("Method not found: %s", req.Method))
	}
}

// handleNotification processes a JSON-RPC notification (no response).
func handleNotification(req MCPRequest) {
	switch req.Method {
	case "notifications/initialized":
		log.Println("Client sent initialized notification")
	case "$/cancelRequest":
		// No-op for now; cancellation is not yet supported.
	default:
		log.Printf("Unhandled notification: %s", req.Method)
	}
}

// --------------- MCP Initialize ---------------

// handleInitialize responds to the MCP "initialize" handshake.
func handleInitialize(id int, _ json.RawMessage) {
	result := map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"capabilities": map[string]interface{}{
			"tools": map[string]interface{}{},
		},
		"serverInfo": map[string]string{
			"name":    "mt-lsp-bridge",
			"version": "0.1.0",
		},
	}
	sendResult(id, result)
}

// --------------- MCP tools/list ---------------

// handleToolsList returns the list of Phase 1 MCP tools with their schemas.
func handleToolsList(id int) {
	tools := []MCPTool{
		{
			Name:        "lsp_diagnostics",
			Description: "Get diagnostics (errors, warnings, hints) for a file from its LSP server",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropSchema{
					"uri": {Type: "string", Description: "File URI to get diagnostics for"},
				},
				Required: []string{"uri"},
			},
		},
		{
			Name:        "lsp_completion",
			Description: "Get code completion suggestions at a given position in a file",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropSchema{
					"uri":       {Type: "string", Description: "File URI"},
					"line":      {Type: "number", Description: "Line number (0-based)"},
					"character": {Type: "number", Description: "Character offset (0-based)"},
				},
				Required: []string{"uri", "line", "character"},
			},
		},
		{
			Name:        "lsp_hover",
			Description: "Get hover information (type signature, documentation) at a given position",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropSchema{
					"uri":       {Type: "string", Description: "File URI"},
					"line":      {Type: "number", Description: "Line number (0-based)"},
					"character": {Type: "number", Description: "Character offset (0-based)"},
				},
				Required: []string{"uri", "line", "character"},
			},
		},
		{
			Name:        "lsp_definition",
			Description: "Go to definition: find the source location where a symbol at the given position is defined",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropSchema{
					"uri":       {Type: "string", Description: "File URI"},
					"line":      {Type: "number", Description: "Line number (0-based)"},
					"character": {Type: "number", Description: "Character offset (0-based)"},
				},
				Required: []string{"uri", "line", "character"},
			},
		},
		{
			Name:        "lsp_references",
			Description: "Find all references to a symbol at the given position across the project",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropSchema{
					"uri":       {Type: "string", Description: "File URI"},
					"line":      {Type: "number", Description: "Line number (0-based)"},
					"character": {Type: "number", Description: "Character offset (0-based)"},
				},
				Required: []string{"uri", "line", "character"},
			},
		},
	}

	sendResult(id, map[string]interface{}{"tools": tools})
}

// --------------- MCP tools/call Router ---------------

// handleToolCall routes the tool call to a specific handler based on tool name.
func handleToolCall(id int, params json.RawMessage) {
	var callParams ToolCallParams
	if err := json.Unmarshal(params, &callParams); err != nil {
		sendError(id, -32602, fmt.Sprintf("Invalid tool call params: %v", err))
		return
	}

	switch callParams.Name {
	case "lsp_diagnostics":
		handleDiagnostics(id, callParams.Arguments)
	case "lsp_completion":
		handleCompletion(id, callParams.Arguments)
	case "lsp_hover":
		handleHover(id, callParams.Arguments)
	case "lsp_definition":
		handleDefinition(id, callParams.Arguments)
	case "lsp_references":
		handleReferences(id, callParams.Arguments)
	default:
		sendError(id, -32601, fmt.Sprintf("Unknown tool: %s", callParams.Name))
	}
}

// --------------- File Extension → LSP Client Routing ---------------

// uriParams is a helper type to extract the "uri" field from tool arguments.
type uriParams struct {
	URI string `json:"uri"`
}

// getLSPClientForURI finds the LSP client for the given file URI.
// If the client hasn't been started yet, it starts it.
func getLSPClientForURI(uri string) (*LSPClient, error) {
	path := strings.TrimPrefix(uri, "file://")
	ext := filepath.Ext(path)
	if ext == "" {
		return nil, fmt.Errorf("no file extension in URI: %s", uri)
	}

	client, ok := lspClients[ext]
	if !ok {
		return nil, fmt.Errorf("no LSP server configured for extension '%s' (URI: %s)", ext, uri)
	}

	if err := client.EnsureStarted(); err != nil {
		return nil, fmt.Errorf("failed to start LSP server for '%s': %v", ext, err)
	}

	return client, nil
}

// --------------- URI / Path Conversion ---------------

// uriToPath converts a file:// URI to a local filesystem path.
// Examples:
//
//	file:///D:/path/file.as  → D:\path\file.as
//	file:///home/user/file.as → /home/user/file.as
func uriToPath(uri string) string {
	s := strings.TrimPrefix(uri, "file://")
	// Handle Windows paths: /D:/path → D:\path
	if len(s) >= 3 && s[0] == '/' && s[2] == ':' {
		s = s[1:] // remove leading /
	}
	return strings.ReplaceAll(s, "/", "\\")
}

// pathToURI converts a local filesystem path to a file:// URI.
// Examples:
//
//	D:\path\file.as    → file:///D:/path/file.as
//	/home/user/file.as → file:///home/user/file.as
func pathToURI(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	if len(path) >= 2 && path[1] == ':' {
		// Windows: D:/path → file:///D:/path
		return "file:///" + path
	}
	return "file://" + path
}

// --------------- Tool Handlers ---------------

// handleDiagnostics gets diagnostics for a file from the LSP server.
//
// Hazelight LS uses push mode (textDocument/publishDiagnostics). This handler:
//  1. Sends didChange to trigger re-analysis on the server.
//  2. Makes a textDocument/diagnostic pull request — the Call() read loop
//     captures any publishDiagnostics notifications from the server and caches
//     them in the diagnostic cache.
//  3. Checks the push diagnostic cache first (for push-mode servers).
//  4. Falls back to the pull response (for servers that support LSP 3.17+ pull).
//  5. Returns an empty array if nothing is available.
func handleDiagnostics(id int, args json.RawMessage) {
	var p uriParams
	if err := json.Unmarshal(args, &p); err != nil {
		sendError(id, -32602, fmt.Sprintf("Invalid arguments: %v", err))
		return
	}
	client, err := getLSPClientForURI(p.URI)
	if err != nil {
		sendError(id, -32000, err.Error())
		return
	}

	// Priority 0: Return cached diagnostics immediately (fast path).
	// The background reader continuously caches push diagnostics from LSP.
	if cached := client.GetDiagnostics(p.URI); len(cached) > 0 {
		diagnostics := formatDiagnosticsFromItems(p.URI, cached)
		sendResult(id, map[string]interface{}{
			"uri":         p.URI,
			"diagnostics": diagnostics,
		})
		return
	}

	// Cache is empty — wait a moment for the LSP server to finish its
	// initial scan (which sends push diagnostics), then check again.
	time.Sleep(2 * time.Second)
	if cached := client.GetDiagnostics(p.URI); len(cached) > 0 {
		diagnostics := formatDiagnosticsFromItems(p.URI, cached)
		sendResult(id, map[string]interface{}{
			"uri":         p.URI,
			"diagnostics": diagnostics,
		})
		return
	}

	// Cache is empty — force refresh and retry
	if err := client.EnsureDocumentOpen(p.URI, true); err != nil {
		sendError(id, -32000, fmt.Sprintf("Failed to open document: %v", err))
		return
	}

	// Make a pull diagnostic request. Even for push-mode servers, this is
	// necessary to enter the Call() read loop, which processes any pending
	// publishDiagnostics notifications and populates the push diagnostic cache.
	// For servers that support pull diagnostics, the response is available
	// as a fallback.
	result, pullErr := client.Call("textDocument/diagnostic", map[string]interface{}{
		"textDocument": map[string]interface{}{
			"uri": p.URI,
		},
	})

	// Priority 1: Use push-diagnostic cache (populated during the Call() read loop)
	items := client.GetDiagnostics(p.URI)
	if len(items) > 0 {
		diagnostics := formatDiagnosticsFromItems(p.URI, items)
		sendResult(id, map[string]interface{}{
			"uri":         p.URI,
			"diagnostics": diagnostics,
		})
		return
	}

	// Priority 2: Fall back to pull diagnostics (for servers that support it)
	if pullErr == nil && result != nil {
		rawItems := extractDiagnosticItems(result)
		diagnostics := formatDiagnostics(p.URI, rawItems)
		sendResult(id, map[string]interface{}{
			"uri":         p.URI,
			"diagnostics": diagnostics,
		})
		return
	}

	// Priority 3: No diagnostics available — return empty (no error, no note)
	sendResult(id, map[string]interface{}{
		"uri":         p.URI,
		"diagnostics": []interface{}{},
	})
}

// handleCompletion gets code completion suggestions at a given position in a file.
func handleCompletion(id int, args json.RawMessage) {
	var p struct {
		uriParams
		Line      int `json:"line"`
		Character int `json:"character"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		sendError(id, -32602, fmt.Sprintf("Invalid arguments: %v", err))
		return
	}
	client, err := getLSPClientForURI(p.URI)
	if err != nil {
		sendError(id, -32000, err.Error())
		return
	}

	if err := client.EnsureDocumentOpen(p.URI, false); err != nil {
		sendError(id, -32000, fmt.Sprintf("Failed to open document: %v", err))
		return
	}

	result, err := client.Call("textDocument/completion", map[string]interface{}{
		"textDocument": map[string]interface{}{"uri": p.URI},
		"position": map[string]interface{}{
			"line":      p.Line,
			"character": p.Character,
		},
		"context": map[string]interface{}{
			"triggerKind": 1, // Invoked
		},
	})
	if err != nil {
		sendError(id, -32000, fmt.Sprintf("Completion request failed: %v", err))
		return
	}

	// Debug: log raw LSP result for troubleshooting
	if raw, jsonErr := json.Marshal(result); jsonErr == nil {
		log.Printf("[completion] Raw LSP result (%d bytes): %s", len(raw), string(raw))
	} else {
		log.Printf("[completion] Failed to marshal raw result: %v", jsonErr)
	}

	items := extractCompletionItems(result)
	log.Printf("[completion] Extracted %d items from result type %T", len(items), result)
	completions := formatCompletionItems(items)

	sendResult(id, map[string]interface{}{
		"uri":         p.URI,
		"line":        p.Line,
		"character":   p.Character,
		"completions": completions,
	})
}

// handleHover gets hover information (type signature, documentation) at a position.
func handleHover(id int, args json.RawMessage) {
	var p struct {
		uriParams
		Line      int `json:"line"`
		Character int `json:"character"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		sendError(id, -32602, fmt.Sprintf("Invalid arguments: %v", err))
		return
	}
	client, err := getLSPClientForURI(p.URI)
	if err != nil {
		sendError(id, -32000, err.Error())
		return
	}

	if err := client.EnsureDocumentOpen(p.URI, false); err != nil {
		sendError(id, -32000, fmt.Sprintf("Failed to open document: %v", err))
		return
	}

	result, err := client.Call("textDocument/hover", map[string]interface{}{
		"textDocument": map[string]interface{}{"uri": p.URI},
		"position": map[string]interface{}{
			"line":      p.Line,
			"character": p.Character,
		},
	})
	if err != nil {
		sendError(id, -32000, fmt.Sprintf("Hover request failed: %v", err))
		return
	}

	// Debug: log raw LSP result for troubleshooting
	if raw, jsonErr := json.Marshal(result); jsonErr == nil {
		log.Printf("[hover] Raw LSP result (%d bytes): %s", len(raw), string(raw))
	} else {
		log.Printf("[hover] Failed to marshal raw result: %v", jsonErr)
	}

	hover := formatHoverResult(result)

	// Retry up to 5 times if empty — cross-file resolution may not be complete yet
	for attempt := 0; len(hover) == 0 && attempt < 5; attempt++ {
		time.Sleep(3 * time.Second)
		log.Printf("[hover] Retry %d/5...", attempt+1)
		result, err = client.Call("textDocument/hover", map[string]interface{}{
			"textDocument": map[string]interface{}{"uri": p.URI},
			"position":     map[string]interface{}{"line": p.Line, "character": p.Character},
		})
		if err == nil {
			hover = formatHoverResult(result)
		}
	}

	sendResult(id, map[string]interface{}{
		"uri":       p.URI,
		"line":      p.Line,
		"character": p.Character,
		"hover":     hover,
	})
}

// handleDefinition finds the source location where a symbol at the given position is defined.
func handleDefinition(id int, args json.RawMessage) {
	var p struct {
		uriParams
		Line      int `json:"line"`
		Character int `json:"character"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		sendError(id, -32602, fmt.Sprintf("Invalid arguments: %v", err))
		return
	}
	client, err := getLSPClientForURI(p.URI)
	if err != nil {
		sendError(id, -32000, err.Error())
		return
	}

	if err := client.EnsureDocumentOpen(p.URI, false); err != nil {
		sendError(id, -32000, fmt.Sprintf("Failed to open document: %v", err))
		return
	}

	result, err := client.Call("textDocument/definition", map[string]interface{}{
		"textDocument": map[string]interface{}{"uri": p.URI},
		"position": map[string]interface{}{
			"line":      p.Line,
			"character": p.Character,
		},
	})
	if err != nil {
		sendError(id, -32000, fmt.Sprintf("Definition request failed: %v", err))
		return
	}

	// Debug: log raw result
	if raw, jsonErr := json.Marshal(result); jsonErr == nil {
		log.Printf("[definition] Raw LSP result (%d bytes): %s", len(raw), string(raw))
	}

	locations := extractLocations(result)

	// Retry up to 5 times if empty — cross-file resolution may not be complete yet
	for attempt := 0; len(locations) == 0 && attempt < 5; attempt++ {
		time.Sleep(3 * time.Second)
		log.Printf("[definition] Retry %d/5...", attempt+1)
		result, err = client.Call("textDocument/definition", map[string]interface{}{
			"textDocument": map[string]interface{}{"uri": p.URI},
			"position":     map[string]interface{}{"line": p.Line, "character": p.Character},
		})
		if err == nil {
			locations = extractLocations(result)
		}
	}

	sendResult(id, map[string]interface{}{
		"uri":       p.URI,
		"line":      p.Line,
		"character": p.Character,
		"locations": locations,
	})
}

// handleReferences finds all references to a symbol at the given position.
func handleReferences(id int, args json.RawMessage) {
	var p struct {
		uriParams
		Line      int `json:"line"`
		Character int `json:"character"`
	}
	if err := json.Unmarshal(args, &p); err != nil {
		sendError(id, -32602, fmt.Sprintf("Invalid arguments: %v", err))
		return
	}
	client, err := getLSPClientForURI(p.URI)
	if err != nil {
		sendError(id, -32000, err.Error())
		return
	}

	if err := client.EnsureDocumentOpen(p.URI, false); err != nil {
		sendError(id, -32000, fmt.Sprintf("Failed to open document: %v", err))
		return
	}

	result, err := client.Call("textDocument/references", map[string]interface{}{
		"textDocument": map[string]interface{}{"uri": p.URI},
		"position": map[string]interface{}{
			"line":      p.Line,
			"character": p.Character,
		},
		"context": map[string]interface{}{
			"includeDeclaration": true,
		},
	})
	if err != nil {
		sendError(id, -32000, fmt.Sprintf("References request failed: %v", err))
		return
	}

	// Debug: log raw result
	if raw, jsonErr := json.Marshal(result); jsonErr == nil {
		log.Printf("[references] Raw LSP result (%d bytes): %s", len(raw), string(raw))
	}

	locations := extractLocations(result)

	sendResult(id, map[string]interface{}{
		"uri":       p.URI,
		"line":      p.Line,
		"character": p.Character,
		"locations": locations,
	})
}

// --------------- LSP Response Formatting ---------------

// extractDiagnosticItems extracts diagnostic items from a textDocument/diagnostic response.
// The response may be { kind: "full", items: [...] } or { diagnostics: [...] }.
func extractDiagnosticItems(result interface{}) []interface{} {
	resultMap, ok := result.(map[string]interface{})
	if !ok {
		return nil
	}
	if items, ok := resultMap["items"].([]interface{}); ok {
		return items
	}
	if items, ok := resultMap["diagnostics"].([]interface{}); ok {
		return items
	}
	return nil
}

// formatDiagnostics converts LSP diagnostic items to the MCP-friendly format.
// Each entry contains: uri, message, severity, line, character, range, source.
func formatDiagnostics(uri string, items []interface{}) []map[string]interface{} {
	if items == nil {
		return []map[string]interface{}{}
	}
	result := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		diag, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		entry := map[string]interface{}{
			"uri":     uri,
			"message": diag["message"],
		}
		if sev, ok := diag["severity"]; ok {
			entry["severity"] = sev
		}
		if rng, ok := diag["range"].(map[string]interface{}); ok {
			entry["range"] = rng
			if start, ok := rng["start"].(map[string]interface{}); ok {
				if line, ok := start["line"]; ok {
					entry["line"] = line
				}
				if ch, ok := start["character"]; ok {
					entry["character"] = ch
				}
			}
		}
		if src, ok := diag["source"]; ok {
			entry["source"] = src
		}
		result = append(result, entry)
	}
	return result
}

// formatDiagnosticsFromItems converts DiagnosticItem entries (from push
// diagnostic cache) to the MCP-friendly output format.
func formatDiagnosticsFromItems(uri string, items []DiagnosticItem) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		entry := map[string]interface{}{
			"uri":       uri,
			"message":   item.Message,
			"severity":  item.Severity,
			"line":      item.Line,
			"character": item.Character,
		}
		result = append(result, entry)
	}
	return result
}

// extractCompletionItems extracts completion items from a textDocument/completion response.
// The response is either { isIncomplete, items } or directly an array of items.
func extractCompletionItems(result interface{}) []interface{} {
	switch r := result.(type) {
	case map[string]interface{}:
		if items, ok := r["items"].([]interface{}); ok {
			return items
		}
		return nil
	case []interface{}:
		return r
	default:
		return nil
	}
}

// formatCompletionItems converts LSP completion items to an MCP-friendly format.
// LSP completion item kind reference:
//
//	1=Text, 2=Method, 3=Function, 4=Constructor, 5=Field, 6=Variable, 7=Class,
//	8=Interface, 9=Module, 10=Property, 11=Unit, 12=Value, 13=Enum, 14=Keyword,
//	15=Snippet, 16=Color, 17=File, 18=Reference, 19=Folder, 20=EnumMember,
//	21=Constant, 22=Struct, 23=Event, 24=Operator, 25=TypeParameter
func formatCompletionItems(items []interface{}) []map[string]interface{} {
	if items == nil {
		return []map[string]interface{}{}
	}
	kindNames := map[float64]string{
		1: "Text", 2: "Method", 3: "Function", 4: "Constructor",
		5: "Field", 6: "Variable", 7: "Class", 8: "Interface",
		9: "Module", 10: "Property", 11: "Unit", 12: "Value",
		13: "Enum", 14: "Keyword", 15: "Snippet", 16: "Color",
		17: "File", 18: "Reference", 19: "Folder", 20: "EnumMember",
		21: "Constant", 22: "Struct", 23: "Event", 24: "Operator",
		25: "TypeParameter",
	}
	result := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		ci, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		entry := map[string]interface{}{
			"label": ci["label"],
		}
		if kind, ok := ci["kind"].(float64); ok {
			entry["kind"] = kind
			if name, ok := kindNames[kind]; ok {
				entry["kindName"] = name
			}
		}
		if detail, ok := ci["detail"].(string); ok && detail != "" {
			entry["detail"] = detail
		}
		if doc, ok := ci["documentation"]; ok && doc != nil {
			entry["documentation"] = doc
		}
		result = append(result, entry)
	}
	return result
}

// formatHoverResult extracts hover contents into a simplified MCP-friendly format.
func formatHoverResult(result interface{}) map[string]interface{} {
	formatted := make(map[string]interface{})

	resultMap, ok := result.(map[string]interface{})
	if !ok || resultMap == nil {
		return formatted
	}

	if contents, ok := resultMap["contents"]; ok {
		formatted["contents"] = contents

		// Try to extract readable text from various hover content formats
		switch c := contents.(type) {
		case map[string]interface{}:
			// MarkupContent: { kind: "markdown", value: "..." }
			if value, ok := c["value"].(string); ok {
				formatted["text"] = value
			}
		case string:
			formatted["text"] = c
		case []interface{}:
			// Array of MarkupContent or MarkedString
			var texts []string
			for _, item := range c {
				switch item := item.(type) {
				case map[string]interface{}:
					if value, ok := item["value"].(string); ok {
						texts = append(texts, value)
					} else if lang, ok := item["language"].(string); ok {
						if value, ok := item["value"].(string); ok {
							texts = append(texts, lang+": "+value)
						}
					}
				case string:
					texts = append(texts, item)
				}
			}
			if len(texts) > 0 {
				formatted["text"] = texts
			}
		}
	}

	if rng, ok := resultMap["range"].(map[string]interface{}); ok {
		formatted["range"] = rng
	}

	return formatted
}

// extractLocations parses a Location or []Location from an LSP response.
// Handles both: single Location { uri, range } and array of Locations.
func extractLocations(result interface{}) []map[string]interface{} {
	switch r := result.(type) {
	case []interface{}:
		// Array of locations
		locs := make([]map[string]interface{}, 0, len(r))
		for _, item := range r {
			if loc, ok := item.(map[string]interface{}); ok {
				locs = append(locs, formatLocation(loc))
			}
		}
		return locs
	case map[string]interface{}:
		// Single location
		return []map[string]interface{}{formatLocation(r)}
	default:
		return []map[string]interface{}{}
	}
}

// formatLocation converts a single LSP Location to a simplified format.
func formatLocation(loc map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{})
	if uri, ok := loc["uri"].(string); ok {
		result["uri"] = uri
	}
	if rng, ok := loc["range"].(map[string]interface{}); ok {
		result["range"] = rng
		if start, ok := rng["start"].(map[string]interface{}); ok {
			if line, ok := start["line"]; ok {
				result["line"] = line
			}
			if ch, ok := start["character"]; ok {
				result["character"] = ch
			}
		}
	}
	return result
}

// --------------- JSON-RPC Helpers ---------------

func sendResult(id int, result interface{}) {
	resp := MCPResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	}
	data, _ := json.Marshal(resp)
	if err := writeStdioMessage(data); err != nil {
		log.Printf("Failed to send result: %v", err)
	}
}

func sendError(id int, code int, message string) {
	resp := MCPResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &MCPError{
			Code:    code,
			Message: message,
		},
	}
	data, _ := json.Marshal(resp)
	if err := writeStdioMessage(data); err != nil {
		log.Printf("Failed to send error: %v", err)
	}
}
