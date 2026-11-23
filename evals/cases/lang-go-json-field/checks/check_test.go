package cfg

import (
	"strings"
	"testing"
)

// Hidden check: copied into the module under test as check_test.go.
func TestWrongTypeNamesSettingWithHelp(t *testing.T) {
	cases := []struct{ in, setting string }{
		{`{"name": 5}`, "name"},
		{`{"servers": [{"host": "a", "port": 80}, {"host": "b", "port": "eighty"}]}`, "servers.port"},
		{`{"limits": {"cpu": 2, "mem": "lots"}}`, "limits"},
	}
	for _, c := range cases {
		_, err := Load([]byte(c.in))
		if err == nil {
			t.Errorf("%s: no error", c.in)
			continue
		}
		msg := err.Error()
		if !strings.Contains(msg, `"`+c.setting+`"`) || !strings.Contains(msg, Help[c.setting]) {
			t.Errorf("%s: error %q should name %q and include its help text", c.in, msg, c.setting)
		}
	}
}
