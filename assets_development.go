//go:build !production

package main

import "embed"

// Bindings generation and Go tests run before the frontend build on a clean checkout.
//
//go:embed frontend/index.html
var assets embed.FS
