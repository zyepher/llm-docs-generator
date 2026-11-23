package cfg

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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

// settingFor maps an UnmarshalTypeError.Field path to a Help key. The path is
// the full path from the root to the value: it can contain array indexes
// ("servers.1.port") and map keys ("limits.mem"), which Help does not.
func settingFor(field string) (string, bool) {
	var kept []string
	for _, seg := range strings.Split(field, ".") {
		if isIndex(seg) {
			continue
		}
		kept = append(kept, seg)
	}
	// Walk back from the longest candidate so map keys fall away.
	for n := len(kept); n > 0; n-- {
		key := strings.Join(kept[:n], ".")
		if _, ok := Help[key]; ok {
			return key, true
		}
	}
	return field, false
}

func isIndex(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Load parses a config. When a value has the wrong type, the error names the
// setting and includes its help text.
func Load(data []byte) (*Config, error) {
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) {
			if key, ok := settingFor(te.Field); ok {
				return nil, fmt.Errorf("setting %q has the wrong type: expected %s", key, Help[key])
			}
			return nil, fmt.Errorf("setting %q has the wrong type", te.Field)
		}
		return nil, err
	}
	return &c, nil
}
