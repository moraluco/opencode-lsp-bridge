package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DiagnosticItem represents a single diagnostic result from the LSP server,
// cached from push notifications (textDocument/publishDiagnostics).
type DiagnosticItem struct {
	URI       string `json:"uri"`
	Message   string `json:"message"`
	Severity  int    `json:"severity"`  // 1=Error, 2=Warning, 3=Info, 4=Hint
	Line      int    `json:"line"`
	Character int    `json:"character"`
}

// docState tracks the open state of a document on the LSP server side.
type docState struct {
	version int // incremental version, incremented on each didChange
}

// --------------- LSP Client ---------------

// LSPClient manages a single LSP server subprocess.
//
// Lifecycle:
//   - Constructed via NewLSPClient (does NOT start the process).
//   - EnsureStarted / Start launches the subprocess and performs the LSP
//     initialize handshake.
//   - Call sends a JSON-RPC request and waits for the matching response.
//
// Fields are protected by a mutex since Call may be invoked concurrently
// from multiple goroutines (each MCP tool call runs in its own goroutine).
type LSPClient struct {
	Config ServerConfig

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader

	mu     sync.Mutex
	reqID  int64 // atomic counter for JSON-RPC request IDs
	started bool

	// Verbose enables detailed request/response logging for troubleshooting.
	Verbose bool

	// capabilities stores the server's response to the initialize request.
	capabilities map[string]interface{}

	// openDocs tracks which documents have been opened on the LSP server,
	// keyed by URI (e.g. "file:///D:/path/file.as").
	openDocs map[string]*docState

	// diagCache stores the latest push diagnostics per URI, keyed by URI.
	// Populated from textDocument/publishDiagnostics notifications in the
	// background reader goroutine.
	diagCache map[string][]DiagnosticItem
	diagMu    sync.RWMutex

	// responseChans maps JSON-RPC request IDs to channels that the background
	// reader uses to deliver responses to the waiting Call() goroutine.
	responseChans map[int64]chan []byte
	respMu        sync.Mutex

	// bgReaderDone is closed when the background reader goroutine exits.
	bgReaderDone chan struct{}
}

// NewLSPClient creates a new LSPClient from the given server configuration.
// The subprocess is NOT started yet; call EnsureStarted() before use.
func NewLSPClient(config ServerConfig) *LSPClient {
	return &LSPClient{
		Config:        config,
		openDocs:      make(map[string]*docState),
		diagCache:     make(map[string][]DiagnosticItem),
		responseChans: make(map[int64]chan []byte),
	}
}

// EnsureStarted starts the LSP server subprocess if it has not been started yet.
// It is safe to call multiple times.
func (c *LSPClient) EnsureStarted() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.started {
		return nil
	}
	return c.startLocked()
}

// startLocked starts the subprocess and performs the LSP handshake.
// The caller MUST hold c.mu.
func (c *LSPClient) startLocked() error {
	if c.cmd != nil {
		return fmt.Errorf("LSP client already started")
	}

	log.Printf("Starting LSP server: %s %s", c.Config.Command, strings.Join(c.Config.Args, " "))

	c.cmd = exec.Command(c.Config.Command, c.Config.Args...)
	if c.Config.Cwd != "" {
		c.cmd.Dir = c.Config.Cwd
	}

	// Stdin pipe (write requests to the server)
	stdin, err := c.cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %v", err)
	}
	c.stdin = stdin

	// Stdout pipe (read responses from the server)
	stdout, err := c.cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %v", err)
	}
	c.stdout = bufio.NewReader(stdout)

	// Initialize background reader infrastructure before starting the process.
	c.bgReaderDone = make(chan struct{})

	// Start background reader goroutine. This goroutine owns reading from
	// c.stdout — it processes all inbound LSP messages, routing notifications
	// to handlers and responses to the waiting Call() goroutine via channels.
	go c.backgroundReader()

	// Stderr pipe (forwarded to our log for debugging)
	stderr, err := c.cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe: %v", err)
	}
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			log.Printf("[%s:stderr] %s", c.Config.Language, scanner.Text())
		}
	}()

	if err := c.cmd.Start(); err != nil {
		return fmt.Errorf("start process: %v", err)
	}

	// Perform LSP initialize handshake
	if err := c.initializeLocked(); err != nil {
		// Kill the process, then wait for the background reader to exit
		_ = c.cmd.Process.Kill()
		<-c.bgReaderDone
		c.cmd = nil
		return fmt.Errorf("initialize handshake: %v", err)
	}

	c.started = true
	log.Printf("LSP server [%s] started and initialized", c.Config.Language)
	return nil
}

// initializeLocked performs the LSP initialize + initialized handshake.
// The caller MUST hold c.mu.
func (c *LSPClient) initializeLocked() error {
	// 1. Send "initialize" request
	initParams := map[string]interface{}{
		"processId":    nil,
		"clientInfo": map[string]string{
			"name":    "mt-lsp-bridge",
			"version": "0.1.0",
		},
		"rootUri":              nil,
		"capabilities":         map[string]interface{}{},
		"trace":                "off",
		"workspaceFolders":     nil,
	}

	result, err := c.callLocked("initialize", initParams)
	if err != nil {
		return fmt.Errorf("initialize request failed: %v", err)
	}

	// Store capabilities for future reference
	if resultMap, ok := result.(map[string]interface{}); ok {
		if caps, ok := resultMap["capabilities"]; ok {
			if capsMap, ok := caps.(map[string]interface{}); ok {
				c.capabilities = capsMap
				log.Printf("[%s] Server capabilities received", c.Config.Language)
			}
		}
	}

	// 2. Send "initialized" notification (fire-and-forget)
	notif := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "initialized",
		"params":  map[string]interface{}{},
	}
	data, _ := json.Marshal(notif)
	if err := c.writeMessageLocked(data); err != nil {
		return fmt.Errorf("initialized notification: %v", err)
	}

	return nil
}

// --------------- Background Reader (Strategy C) ---------------
//
// backgroundReader owns reading from c.stdout. It runs in a dedicated
// goroutine started at the end of startLocked(). All inbound LSP messages
// (both notifications and responses) flow through this single goroutine:
//
//   - Notifications (method != "" && id == 0) → handled directly:
//     textDocument/publishDiagnostics → cached in diagCache
//     other notifications → logged
//   - Responses (id != 0) → routed to the channel registered by Call()
//     in responseChans[id]
//
// This ensures notifications are never lost, even if they arrive before the
// first Call() request or interleaved between calls.

// backgroundReader is the main read loop for LSP server responses.
// It MUST be started as a goroutine.
func (c *LSPClient) backgroundReader() {
	defer func() {
		// Clean up: close all pending response channels so any waiting
		// Call() goroutines unblock with an error.
		c.respMu.Lock()
		for id, ch := range c.responseChans {
			close(ch)
			delete(c.responseChans, id)
		}
		c.respMu.Unlock()
		close(c.bgReaderDone)
		log.Printf("[%s] LSP background reader exited", c.Config.Language)
	}()

	log.Printf("[%s] LSP background reader started", c.Config.Language)

	for {
		data, err := readLSPMessage(c.stdout)
		if err != nil {
			if err == io.EOF {
				log.Printf("[%s] LSP server stdout closed", c.Config.Language)
			} else {
				log.Printf("[%s] background reader error: %v", c.Config.Language, err)
			}
			return
		}

		// Parse the JSON-RPC envelope to determine message type
		var base struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if err := json.Unmarshal(data, &base); err != nil {
			log.Printf("[%s] failed to parse LSP message envelope: %v", c.Config.Language, err)
			continue
		}

		if base.Method != "" && base.ID == 0 {
			// --- Notification (has method, no id) ---
			c.handleInboundNotification(base.Method, data)
		} else if base.ID != 0 {
			// --- Response (has id) ---
			c.routeResponse(base.ID, data)
		} else {
			log.Printf("[%s] received malformed LSP message (no id, no method)", c.Config.Language)
		}
	}
}

// handleInboundNotification dispatches a notification received from the LSP server.
func (c *LSPClient) handleInboundNotification(method string, data []byte) {
	switch method {
	case "textDocument/publishDiagnostics":
		c.handlePublishDiagnostics(data)
	default:
		log.Printf("[%s] Server notification: %s", c.Config.Language, method)
	}
}

// routeResponse delivers a response to the Call() goroutine waiting for it.
func (c *LSPClient) routeResponse(id int64, data []byte) {
	c.respMu.Lock()
	ch, ok := c.responseChans[id]
	if ok {
		delete(c.responseChans, id)
	}
	c.respMu.Unlock()

	if !ok {
		log.Printf("[%s] received response for unknown request id %d", c.Config.Language, id)
		return
	}

	// Non-blocking send: the channel has buffer 1, so this should always succeed.
	// If it fails, the Call() goroutine already timed out and cleaned up.
	select {
	case ch <- data:
	default:
		log.Printf("[%s] dropped response for id %d (channel full/closed)", c.Config.Language, id)
	}
}

// readLSPMessage reads one Content-Length framed LSP message from the reader.
// It is a package-level helper used by backgroundReader.
func readLSPMessage(reader *bufio.Reader) ([]byte, error) {
	contentLength := 0
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break // end of headers
		}
		const prefix = "Content-Length: "
		if strings.HasPrefix(line, prefix) {
			n, err := fmt.Sscanf(line, prefix+"%d", &contentLength)
			if err != nil || n != 1 {
				return nil, fmt.Errorf("invalid Content-Length: %s", line)
			}
		}
	}
	if contentLength <= 0 {
		return nil, fmt.Errorf("missing or invalid Content-Length header")
	}

	body := make([]byte, contentLength)
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil, fmt.Errorf("read body: %v", err)
	}
	return body, nil
}

// --------------- Synchronous RPC ---------------

// Call sends a JSON-RPC request to the LSP server and returns the response.
// It is safe for concurrent use.
func (c *LSPClient) Call(method string, params interface{}) (interface{}, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.callLocked(method, params)
}

// callLocked sends a request and waits for the matching response via the
// background reader's response routing mechanism.
// The caller MUST hold c.mu.
func (c *LSPClient) callLocked(method string, params interface{}) (interface{}, error) {
	id := atomic.AddInt64(&c.reqID, 1)

	req := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}

	reqData, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %v", err)
	}

	if c.Verbose {
		log.Printf("[%s] --> request #%d: method=%s body=%s", c.Config.Language, id, method, string(reqData))
	}

	// Check that the background reader is still alive before proceeding
	select {
	case <-c.bgReaderDone:
		return nil, fmt.Errorf("LSP server connection is closed")
	default:
	}

	// Register a response channel for this request ID BEFORE writing, so the
	// background reader can deliver the response as soon as it arrives.
	respCh := make(chan []byte, 1)
	c.respMu.Lock()
	c.responseChans[id] = respCh
	c.respMu.Unlock()

	// Clean up on exit: remove the channel from the map if still present.
	defer func() {
		c.respMu.Lock()
		delete(c.responseChans, id)
		c.respMu.Unlock()
	}()

	// Write the request to the LSP server
	if err := c.writeMessageLocked(reqData); err != nil {
		return nil, fmt.Errorf("write request: %v", err)
	}

	// Wait for the response (via background reader) with timeout
	var respData []byte
	select {
	case respData = <-respCh:
		// Got the response data
	case <-time.After(30 * time.Second):
		return nil, fmt.Errorf("LSP request #%d (%s) timed out after 30s", id, method)
	case <-c.bgReaderDone:
		return nil, fmt.Errorf("LSP server connection closed while waiting for response #%d", id)
	}

	// Parse the response
	var resp struct {
		Result interface{} `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(respData, &resp); err != nil {
		return nil, fmt.Errorf("parse response body: %v", err)
	}

	if c.Verbose {
		respBody, _ := json.Marshal(resp.Result)
		log.Printf("[%s] <-- response #%d: %s", c.Config.Language, id, string(respBody))
	}

	if resp.Error != nil {
		return nil, fmt.Errorf("LSP error (code %d): %s", resp.Error.Code, resp.Error.Message)
	}
	return resp.Result, nil
}

// Notify sends a JSON-RPC notification to the LSP server (fire-and-forget, no response expected).
// It is safe for concurrent use.
func (c *LSPClient) Notify(method string, params interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.notifyLocked(method, params)
}

// notifyLocked sends a notification. The caller MUST hold c.mu.
func (c *LSPClient) notifyLocked(method string, params interface{}) error {
	notif := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	}
	data, err := json.Marshal(notif)
	if err != nil {
		return fmt.Errorf("marshal notification: %v", err)
	}
	return c.writeMessageLocked(data)
}

// EnsureDocumentOpen ensures the LSP server knows about the given document.
// If the document has not been opened yet (or refresh is true), it reads the
// file from disk and sends textDocument/didOpen (or didChange for refresh).
//
// The refresh parameter forces a didChange even if the document is already open,
// which is useful for triggering re-diagnosis before calling textDocument/diagnostic.
func (c *LSPClient) EnsureDocumentOpen(uri string, refresh bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.started {
		return fmt.Errorf("LSP client not started")
	}

	state, exists := c.openDocs[uri]

	if exists && !refresh {
		return nil // already open and no refresh requested
	}

	// Read file content from disk
	path := uriToPath(uri)
	content, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read file %s: %v", path, err)
	}

	if !exists {
		// First access: send textDocument/didOpen
		params := map[string]interface{}{
			"textDocument": map[string]interface{}{
				"uri":        uri,
				"languageId": c.Config.Language,
				"version":    1,
				"text":       string(content),
			},
		}
		if err := c.notifyLocked("textDocument/didOpen", params); err != nil {
			return fmt.Errorf("didOpen: %v", err)
		}
		c.openDocs[uri] = &docState{version: 1}
		log.Printf("[%s] Opened document: %s", c.Config.Language, uri)
	} else {
		// Already open: send textDocument/didChange to refresh
		state.version++
		params := map[string]interface{}{
			"textDocument": map[string]interface{}{
				"uri":     uri,
				"version": state.version,
			},
			"contentChanges": []map[string]interface{}{
				{
					"text": string(content),
				},
			},
		}
		if err := c.notifyLocked("textDocument/didChange", params); err != nil {
			return fmt.Errorf("didChange: %v", err)
		}
		log.Printf("[%s] Refreshed document: %s (version %d)", c.Config.Language, uri, state.version)
	}

	return nil
}

// --------------- Push Diagnostic Cache ---------------

// handlePublishDiagnostics parses a textDocument/publishDiagnostics notification
// and caches the diagnostic items keyed by URI.
func (c *LSPClient) handlePublishDiagnostics(data []byte) {
	var msg struct {
		Params struct {
			URI         string `json:"uri"`
			Diagnostics []struct {
				Range struct {
					Start struct {
						Line      int `json:"line"`
						Character int `json:"character"`
					} `json:"start"`
				} `json:"range"`
				Severity int    `json:"severity"`
				Message  string `json:"message"`
			} `json:"diagnostics"`
		} `json:"params"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("[%s] Failed to parse publishDiagnostics: %v", c.Config.Language, err)
		return
	}

	uri := msg.Params.URI
	if uri == "" {
		log.Printf("[%s] publishDiagnostics with empty URI, ignoring", c.Config.Language)
		return
	}

	items := make([]DiagnosticItem, 0, len(msg.Params.Diagnostics))
	for _, d := range msg.Params.Diagnostics {
		items = append(items, DiagnosticItem{
			URI:       uri,
			Message:   d.Message,
			Severity:  d.Severity,
			Line:      d.Range.Start.Line,
			Character: d.Range.Start.Character,
		})
	}

	c.diagMu.Lock()
	c.diagCache[uri] = items
	c.diagMu.Unlock()

	log.Printf("[%s] Cached %d diagnostics for %s", c.Config.Language, len(items), uri)
}

// GetDiagnostics returns the latest cached push diagnostics for the given URI.
// Returns an empty slice if no diagnostics have been pushed for this URI.
func (c *LSPClient) GetDiagnostics(uri string) []DiagnosticItem {
	c.diagMu.RLock()
	defer c.diagMu.RUnlock()
	items := c.diagCache[uri]
	if items == nil {
		return []DiagnosticItem{}
	}
	return items
}

// WaitForDiagnostics polls the diagnostic cache until diagnostics arrive or
// the timeout elapses. Returns whatever is in the cache (possibly empty) on
// timeout. Cache is populated by the Call() read loop when the server pushes
// textDocument/publishDiagnostics notifications.
func (c *LSPClient) WaitForDiagnostics(uri string, timeout time.Duration) []DiagnosticItem {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c.diagMu.RLock()
		items := c.diagCache[uri]
		c.diagMu.RUnlock()
		if len(items) > 0 {
			return items
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Timeout: return whatever we have (likely empty)
	c.diagMu.RLock()
	defer c.diagMu.RUnlock()
	items := c.diagCache[uri]
	if items == nil {
		return []DiagnosticItem{}
	}
	return items
}

// --------------- Low-level I/O ---------------

// writeMessageLocked writes a Content-Length framed message to the LSP server.
// The caller MUST hold c.mu.
func (c *LSPClient) writeMessageLocked(data []byte) error {
	header := fmt.Sprintf("Content-Length: %d\r\n\r\n", len(data))
	if _, err := c.stdin.Write([]byte(header)); err != nil {
		return err
	}
	_, err := c.stdin.Write(data)
	return err
}

// Stop shuts down the LSP server subprocess and waits for the background
// reader goroutine to exit. It is safe to call multiple times.
func (c *LSPClient) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.cmd == nil || c.cmd.Process == nil {
		return
	}

	log.Printf("[%s] Stopping LSP server", c.Config.Language)
	if err := c.cmd.Process.Kill(); err != nil {
		log.Printf("[%s] Failed to kill process: %v", c.Config.Language, err)
	}

	// Wait for the background reader to finish (it will exit when the
	// stdout pipe closes due to process termination).
	<-c.bgReaderDone
	c.cmd = nil
	c.started = false
	log.Printf("[%s] LSP server stopped", c.Config.Language)
}
