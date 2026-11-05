module github.com/acme/service

go 1.22.0

toolchain go1.23.2

require (
	github.com/BurntSushi/toml v1.4.0
	github.com/go-chi/chi/v5 v5.1.0
	golang.org/x/sync v0.8.0 // indirect
	example.com/forked v1.0.0
	gopkg.in/yaml.v3 v3.0.1 // indirect; needed by tests
)

require github.com/google/uuid v1.6.0

require (
	golang.org/x/text v0.0.0-20240909161429-701f63a606c0 // indirect
)

replace example.com/forked => ../forked

replace (
	github.com/google/uuid v1.5.0 => github.com/google/uuid v1.5.1
)
