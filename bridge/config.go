package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// --------------- Configuration Types ---------------

// Config is the top-level structure of the JSON config file.
type Config struct {
	Servers []ServerConfig `json:"servers"`
}

// ServerConfig describes one LSP server and which file extensions it handles.
//
// Example:
//
//	{
//	  "language":   "angelscript",
//	  "extensions": [".as"],
//	  "command":    "node",
//	  "args":       ["path/to/hazelight-ls"]
//	}
type ServerConfig struct {
	Language   string   `json:"language"`
	Extensions []string `json:"extensions"`
	Command    string   `json:"command"`
	Args       []string `json:"args"`
	Cwd        string   `json:"cwd,omitempty"` // optional working directory for the LSP server process
}

// --------------- Config Loading ---------------

// LoadConfig reads and validates the configuration from a JSON file.
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config file %s: %v", path, err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config file: %v", err)
	}

	// Validation
	if len(cfg.Servers) == 0 {
		return nil, fmt.Errorf("config must define at least one server entry")
	}

	for i, s := range cfg.Servers {
		if s.Language == "" {
			return nil, fmt.Errorf("server[%d]: missing 'language'", i)
		}
		if len(s.Extensions) == 0 {
			return nil, fmt.Errorf("server[%d] (%s): missing 'extensions'", i, s.Language)
		}
		if s.Command == "" {
			return nil, fmt.Errorf("server[%d] (%s): missing 'command'", i, s.Language)
		}
	}

	return &cfg, nil
}
