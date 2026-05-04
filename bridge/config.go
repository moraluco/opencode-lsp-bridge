package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// --------------- Configuration Types ---------------

// Config holds all configured LSP servers.
type Config struct {
	Servers []ServerConfig
}

// ServerConfig describes one LSP server and which file extensions it handles.
type ServerConfig struct {
	Language   string   `json:"language"`
	Extensions []string `json:"extensions"`
	Command    string   `json:"command"`
	Args       []string `json:"args"`
	Cwd        string   `json:"cwd,omitempty"`
}

// --------------- opencode.json Format ---------------

// opencodeLSPConfig is the "lsp" section of an opencode.json file.
// Format: { "angelscript": { "command": ["node", "server.js", "--stdio"], "extensions": [".as"] }, ... }
type opencodeLSPConfig map[string]struct {
	Command    []string `json:"command"`
	Extensions []string `json:"extensions"`
	Disabled   bool     `json:"disabled"`
	Env        map[string]string `json:"env"`
}

// opencodeRoot is the top-level structure we read from opencode.json.
type opencodeRoot struct {
	LSP opencodeLSPConfig `json:"lsp"`
}

// --------------- Loading ---------------

// findOpenCodeJSON walks up from the executable directory to find opencode.json.
func findOpenCodeJSON() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exe)
	for {
		candidate := filepath.Join(dir, "opencode.json")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		// Also try Agent/opencode.json (project layout)
		candidate = filepath.Join(dir, "Agent", "opencode.json")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// LoadConfig reads LSP server configuration.
// Priority: merges opencode.json (primary) + config.json (supplement).
func LoadConfig(path string) (*Config, error) {
	cfg := &Config{}

	// Primary: opencode.json (auto-discovered)
	if ocPath := findOpenCodeJSON(); ocPath != "" {
		ocCfg, err := loadFromOpenCode(ocPath)
		if err == nil {
			cfg.Servers = append(cfg.Servers, ocCfg.Servers...)
		}
	}

	// Supplement: config.json (same dir as binary)
	if path == "" {
		exe, err := os.Executable()
		if err == nil {
			path = filepath.Join(filepath.Dir(exe), "config.json")
		} else {
			path = "config.json"
		}
	}
	if cfg2, err := loadFromConfigJSON(path); err == nil {
		// Merge: config.json entries supplement (don't override) opencode.json entries
		seen := make(map[string]bool)
		for _, s := range cfg.Servers {
			seen[s.Language] = true
		}
		for _, s := range cfg2.Servers {
			if !seen[s.Language] {
				cfg.Servers = append(cfg.Servers, s)
			}
		}
	}

	if len(cfg.Servers) == 0 {
		return nil, fmt.Errorf("no LSP servers found in opencode.json or config.json")
	}
	return cfg, nil
}

// loadFromOpenCode reads the "lsp" section from an opencode.json file.
// Relative paths in command args are resolved against the directory containing opencode.json.
func loadFromOpenCode(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var root opencodeRoot
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("parse %s: %v", path, err)
	}

	baseDir := filepath.Dir(path)

	servers := make([]ServerConfig, 0, len(root.LSP))
	for lang, entry := range root.LSP {
		if entry.Disabled {
			continue
		}
		if len(entry.Command) == 0 || len(entry.Extensions) == 0 {
			continue
		}
		cmd := entry.Command[0]
		args := make([]string, 0, len(entry.Command)-1)
		for _, a := range entry.Command[1:] {
			// Resolve relative paths against opencode.json's directory
			if !filepath.IsAbs(a) && !isBareFlag(a) {
				a = filepath.Join(baseDir, a)
			}
			args = append(args, a)
		}
		servers = append(servers, ServerConfig{
			Language:   lang,
			Extensions: entry.Extensions,
			Command:    cmd,
			Args:       args,
		})
	}

	return &Config{Servers: servers}, nil
}

// isBareFlag returns true if the string looks like a command-line flag (e.g. "--stdio", "-v")
// rather than a file path that needs resolution.
func isBareFlag(s string) bool {
	return len(s) > 0 && s[0] == '-'
}

// loadFromConfigJSON reads the deprecated standalone config.json format.
func loadFromConfigJSON(path string) (*Config, error) {
	type configFile struct {
		Servers []ServerConfig `json:"servers"`
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %v", path, err)
	}
	var cfg configFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %v", path, err)
	}
	if len(cfg.Servers) == 0 {
		return nil, fmt.Errorf("no servers in %s", path)
	}
	return &Config{Servers: cfg.Servers}, nil
}
