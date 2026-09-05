package hub

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"token-monitor-analytics/collector/internal/config"
)

const MaxEventBytes = 8 << 20

type Event struct {
	Name string
	Data []byte
}

// ReadSSE accepts LF, CRLF, CR, comments and multiline data. Incomplete frames
// at EOF are NOT dispatched. The upstream sends complete snapshots, not deltas.
func ReadSSE(r io.Reader, onEvent func(Event) error) error {
	scan := bufio.NewScanner(r)
	scan.Buffer(make([]byte, 4096), MaxEventBytes+1)
	scan.Split(splitLines)
	var name string
	var data []byte
	first := true
	for scan.Scan() {
		line := scan.Text()
		if first {
			line = strings.TrimPrefix(line, "\ufeff")
			first = false
		}
		if line == "" {
			if len(data) > 0 {
				if name == "" {
					name = "message"
				}
				if err := onEvent(Event{Name: name, Data: bytes.Clone(data[:len(data)-1])}); err != nil {
					return err
				}
			}
			name = ""
			data = nil
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			name = value
		case "data":
			if len(data)+len(value)+1 > MaxEventBytes {
				return fmt.Errorf("SSE event exceeds %d bytes", MaxEventBytes)
			}
			data = append(data, value...)
			data = append(data, '\n')
			// id/retry deliberately not used: the verified Worker has no replay contract.
		}
	}
	if err := scan.Err(); err != nil {
		return err
	}
	return io.EOF
}

func splitLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
	for i, b := range data {
		if b == '\n' {
			return i + 1, data[:i], nil
		}
		if b == '\r' {
			if i+1 == len(data) && !atEOF {
				return 0, nil, nil
			}
			if i+1 < len(data) && data[i+1] == '\n' {
				return i + 2, data[:i], nil
			}
			return i + 1, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

type HTTPError struct{ Status int }

func (e *HTTPError) Error() string { return fmt.Sprintf("Hub HTTP %d", e.Status) }
func Permanent(err error) bool {
	var e *HTTPError
	return errors.As(err, &e) && ((e.Status >= 300 && e.Status < 400) || (e.Status >= 400 && e.Status < 500 && e.Status != 408 && e.Status != 429))
}

func NewHTTPClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 20 * time.Second,
		ForceAttemptHTTP2: true,
	}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}

// Stream opens exactly one authenticated SSE request. An idle watchdog includes
// heartbeat comments. It never puts the secret in a URL, error, DB, or frontend.
func Stream(ctx context.Context, client *http.Client, baseURL, secret string, idle time.Duration, onConnected func(), onEvent func(Event) error) error {
	if err := config.ValidateBaseURL(baseURL); err != nil {
		return err
	}
	if secret == "" || strings.ContainsAny(secret, "\r\n") {
		return fmt.Errorf("missing or invalid shared secret")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(baseURL, "/")+"/api/stats/stream", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("SSE connection failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &HTTPError{Status: resp.StatusCode}
	}
	media, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if media != "text/event-stream" {
		return fmt.Errorf("expected text/event-stream (check Hub URL/Cloudflare Access)")
	}
	if idle <= 0 {
		idle = 90 * time.Second
	}
	last := time.Now()
	var mu sync.Mutex
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tick := time.NewTicker(idle / 3)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				_ = resp.Body.Close()
				return
			case <-tick.C:
				mu.Lock()
				age := time.Since(last)
				mu.Unlock()
				if age > idle {
					_ = resp.Body.Close()
					return
				}
			}
		}
	}()
	if onConnected != nil {
		onConnected()
	}
	return ReadSSE(&touchReader{r: resp.Body, touch: func() { mu.Lock(); last = time.Now(); mu.Unlock() }}, onEvent)
}

type touchReader struct {
	r     io.Reader
	touch func()
}

func (r *touchReader) Read(p []byte) (int, error) {
	n, e := r.r.Read(p)
	if n > 0 {
		r.touch()
	}
	return n, e
}
