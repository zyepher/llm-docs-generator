package cfg

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
