package domain

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

func ValidateHubURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse Hub URL: %w", err)
	}
	if !parsed.IsAbs() || parsed.Host == "" || parsed.Opaque != "" {
		return "", errors.New("hub URL must be an absolute hierarchical URL")
	}
	if parsed.User != nil {
		return "", errors.New("hub URL must not contain user information")
	}
	if parsed.RawQuery != "" || parsed.ForceQuery {
		return "", errors.New("hub URL must not contain a query")
	}
	if strings.Contains(raw, "#") {
		return "", errors.New("hub URL must not contain a fragment")
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errors.New("hub URL scheme must be HTTP or HTTPS")
	}
	if scheme == "http" && !isLiteralPrivateOrLoopback(parsed.Hostname()) {
		return "", errors.New("HTTP is allowed only for a literal private or loopback host")
	}
	parsed.Scheme = scheme
	return parsed.String(), nil
}

func isLiteralPrivateOrLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && (address.IsLoopback() || address.IsPrivate())
}
