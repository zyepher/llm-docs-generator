package cfg

import (
	"encoding/json"
	"errors"
	"fmt"
)

type Server struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type Config struct {
	Name    string         `json:"name"`
	Servers []Server       `json:"servers"`
	Limits  map[string]int `json:"limits"`
}

// Help is the per-setting help text shown to operators, keyed by setting name.
var Help = map[string]string{
	"name":         "a short identifier for this deployment",
	"servers.host": "hostname or IP address of a backend server",
	"servers.port": "TCP port of a backend server, a whole number",
	"limits":       "resource limits, each a whole number",
}

// Load parses a config. When a value has the wrong type, the error names the
// setting and includes its help text.
func Load(data []byte) (*Config, error) {
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) {
			if h, ok := Help[te.Field]; ok {
				return nil, fmt.Errorf("setting %q has the wrong type: expected %s", te.Field, h)
			}
			return nil, fmt.Errorf("setting %q has the wrong type", te.Field)
		}
		return nil, err
	}
	return &c, nil
}
