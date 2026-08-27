package hubapi

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	baseURL   *url.URL
	allowlist Allowlist
	http      *http.Client
}

type Result struct {
	Health   Health
	Stats    Stats
	Contract Contract
}

func NewClient(rawURL string, allowlist Allowlist) (*Client, error) {
	baseURL, err := validateURL(rawURL)
	if err != nil {
		return nil, err
	}
	originalHost := baseURL.Host
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: ConnectTimeout}).DialContext,
		TLSHandshakeTimeout:   ConnectTimeout,
		ResponseHeaderTimeout: RequestTimeout,
		ExpectContinueTimeout: ConnectTimeout,
	}
	client := &http.Client{Transport: transport, Timeout: RequestTimeout}
	client.CheckRedirect = func(request *http.Request, _ []*http.Request) error {
		if _, err := validateURL(request.URL.String()); err != nil {
			return errRedirectURL
		}
		if !strings.EqualFold(originalHost, request.URL.Host) {
			request.Header.Del("Authorization")
		}
		return nil
	}
	return &Client{baseURL: baseURL, allowlist: allowlist, http: client}, nil
}

func (c *Client) Health(ctx context.Context) (Health, error) {
	if c == nil || c.baseURL == nil {
		return Health{}, classify("health", ClassificationUnreachable, "client is not initialized")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("/api/health"), nil)
	if err != nil {
		return Health{}, classify("health", ClassificationUnreachable, "request could not be created")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return Health{}, classifyTransport("health", err)
	}
	body, readErr := readBody(response.Body)
	closeErr := response.Body.Close()
	err = errors.Join(readErr, closeErr)
	if err != nil {
		return Health{}, classifyRead("health", err)
	}
	if err := checkHTTPStatus("health", response.StatusCode); err != nil {
		return Health{}, err
	}
	health, err := parseHealth(body)
	if err != nil {
		return Health{}, classify("health", ClassificationInvalidJSON, "response JSON is invalid")
	}
	health.HTTPStatus = response.StatusCode
	return health, nil
}

// FetchStats performs the mandatory health check first. The stats request is
// never issued unless both allowlist stages match a supported contract.
func (c *Client) FetchStats(ctx context.Context, secret string) (Result, error) {
	health, err := c.Health(ctx)
	if err != nil {
		return Result{}, err
	}
	contract, ok := c.allowlist.match(health.Build)
	if !ok {
		return Result{Health: health}, classify("health", ClassificationUnsupported, "Hub build is not in the supported contract allowlist")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("/api/stats"), nil)
	if err != nil {
		return Result{Health: health, Contract: contract}, classify("stats", ClassificationUnreachable, "request could not be created")
	}
	if secret != "" {
		request.Header.Set("Authorization", "Bearer "+secret)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return Result{Health: health, Contract: contract}, classifyTransport("stats", err)
	}
	body, readErr := readBody(response.Body)
	closeErr := response.Body.Close()
	err = errors.Join(readErr, closeErr)
	if err != nil {
		return Result{Health: health, Contract: contract}, classifyRead("stats", err)
	}
	if err := checkHTTPStatus("stats", response.StatusCode); err != nil {
		return Result{Health: health, Contract: contract}, err
	}
	stats, err := parseStats(body)
	if err != nil {
		return Result{Health: health, Contract: contract}, classify("stats", ClassificationInvalidJSON, "response JSON is invalid")
	}
	if contract.UsageUpdatedAt {
		if err := requireUsageUpdatedAt(stats.Value); err != nil {
			return Result{Health: health, Contract: contract}, classify("stats", ClassificationUnsupported, "stats does not satisfy the usageUpdatedAt contract")
		}
	}
	stats.HTTPStatus = response.StatusCode
	return Result{Health: health, Stats: stats, Contract: contract}, nil
}

func (c *Client) endpoint(path string) string {
	copy := *c.baseURL
	copy.Path = strings.TrimRight(copy.Path, "/") + path
	copy.RawPath = ""
	copy.RawQuery = ""
	copy.Fragment = ""
	return copy.String()
}

var errRedirectURL = errors.New("redirect URL violates Hub URL policy")

func validateURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" || parsed.Opaque != "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return nil, errors.New("hub URL is invalid")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("hub URL scheme is unsupported")
	}
	host := parsed.Hostname()
	if host == "" {
		return nil, errors.New("hub URL host is invalid")
	}
	if parsed.Scheme == "http" && !isPrivateOrLoopback(host) {
		return nil, errors.New("http is only allowed for private or loopback Hub hosts")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	return parsed, nil
}

func isPrivateOrLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	parsed := net.ParseIP(host)
	return parsed != nil && (parsed.IsLoopback() || parsed.IsPrivate())
}

func readBody(body io.Reader) ([]byte, error) {
	limited := io.LimitReader(body, MaxResponseBytes+1)
	contents, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(contents) > MaxResponseBytes {
		return nil, errBodyTooLarge
	}
	return contents, nil
}

var errBodyTooLarge = errors.New("response body exceeds fixed limit")

func checkHTTPStatus(operation string, status int) error {
	if status >= 200 && status <= 299 {
		return nil
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return classify(operation, ClassificationAuth, "authentication failed")
	}
	return classify(operation, ClassificationHTTP, "unexpected HTTP status")
}

func classifyRead(operation string, err error) error {
	if errors.Is(err, errBodyTooLarge) {
		return classify(operation, ClassificationBodyTooLarge, "response body is too large")
	}
	return classifyTransport(operation, err)
}

func classifyTransport(operation string, err error) error {
	if errors.Is(err, errRedirectURL) {
		return classify(operation, ClassificationUnsupported, "redirect URL violates Hub URL policy")
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || isTimeout(err) {
		return classify(operation, ClassificationTimeout, "request timed out")
	}
	if isTLSError(err) {
		return classify(operation, ClassificationTLS, "TLS verification failed")
	}
	return classify(operation, ClassificationUnreachable, "Hub could not be reached")
}

func isTimeout(err error) bool {
	var networkError net.Error
	return errors.As(err, &networkError) && networkError.Timeout()
}

func isTLSError(err error) bool {
	var certificateError x509.CertificateInvalidError
	if errors.As(err, &certificateError) {
		return true
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "tls") || strings.Contains(text, "certificate") || strings.Contains(text, "x509") || strings.Contains(text, "unknown authority")
}

func requireUsageUpdatedAt(value any) error {
	object, ok := value.(map[string]any)
	if !ok {
		return errors.New("stats is not an object")
	}
	devices, exists := object["devices"]
	if !exists {
		return errors.New("devices is missing")
	}
	rows, valid := devices.([]any)
	if !valid || len(rows) == 0 {
		return errors.New("usageUpdatedAt is missing")
	}
	for _, row := range rows {
		device, ok := row.(map[string]any)
		if !ok {
			return errors.New("device row is invalid")
		}
		marker, exists := device["usageUpdatedAt"]
		if !exists {
			return errors.New("usageUpdatedAt is missing")
		}
		if err := validateUsageUpdatedAt(marker); err != nil {
			return err
		}
	}
	return nil
}
