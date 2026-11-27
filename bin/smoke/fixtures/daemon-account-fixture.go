// Fixture executable for the default-install home check.
// It answers whoami and reg from DAEMON_UNIT_FIXTURE and never opens the real registry.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type context struct {
	SID        string            `json:"sid"`
	Profile    string            `json:"profile"`
	AccountEnv map[string]string `json:"accountEnv"`
}

func main() {
	raw, err := os.ReadFile(os.Getenv("DAEMON_UNIT_FIXTURE"))
	if err != nil {
		os.Exit(2)
	}
	var ctx context
	if json.Unmarshal(raw, &ctx) != nil {
		os.Exit(2)
	}
	args := os.Args[1:]
	name := strings.ToLower(filepath.Base(os.Args[0]))
	switch {
	case strings.HasPrefix(name, "whoami"):
		fmt.Printf("\"host\\user\",\"%s\"\r\n", ctx.SID)
	case strings.HasPrefix(name, "reg") && len(args) > 0 && args[0] == "query" && contains(args, "ProfileImagePath"):
		fmt.Printf("\r\n    ProfileImagePath    REG_SZ    %s\r\n", ctx.Profile)
	case strings.HasPrefix(name, "reg") && len(args) > 1 && args[0] == "query" && args[1] == `HKCU\Environment`:
		key := valueAfter(args, "/v")
		value, ok := ctx.AccountEnv[key]
		if !ok {
			os.Exit(1)
		}
		fmt.Printf("\r\n    %s    REG_SZ    %s\r\n", key, value)
	default:
		os.Exit(87)
	}
}

func contains(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func valueAfter(args []string, flag string) string {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}
