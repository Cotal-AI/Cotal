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
	Expand     map[string]bool   `json:"expand"`
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
		if len(ctx.AccountEnv) == 0 {
			fmt.Fprint(os.Stderr, "ERROR: The system was unable to find the specified registry key or value.\r\n")
			os.Exit(1)
		}
		fmt.Print("\r\nHKEY_CURRENT_USER\\Environment\r\n")
		for key, value := range ctx.AccountEnv {
			kind := "REG_SZ"
			if ctx.Expand[key] {
				kind = "REG_EXPAND_SZ"
			}
			fmt.Printf("    %s    %s    %s\r\n", key, kind, value)
		}
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
