// Package outbox is a bounded, single-process durable retry spool; not a database.
package outbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"token-monitor-analytics/collector/internal/hub"
)

var ErrFull = errors.New("outbox is full; collection stopped without deleting pending data")

type Box struct {
	mu    sync.Mutex
	dir   string
	limit int64
	used  int64
	seq   int64
}
type Item struct {
	Name        string
	Observation hub.Observation
}

func Open(dir string, limit int64) (*Box, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	b := &Box{dir: dir, limit: limit, seq: time.Now().UnixNano()}
	es, e := os.ReadDir(dir)
	if e != nil {
		return nil, e
	}
	for _, v := range es {
		// Uncommitted temporary files may remain after a crash. Never treat them as sent.
		if strings.HasPrefix(v.Name(), ".tmp-") {
			if e = os.Remove(filepath.Join(dir, v.Name())); e != nil {
				return nil, e
			}
			continue
		}
		if strings.HasSuffix(v.Name(), ".json") {
			i, e := v.Info()
			if e != nil {
				return nil, e
			}
			b.used += i.Size()
			if prefix, _, ok := strings.Cut(v.Name(), "-"); ok {
				if n, err := strconv.ParseInt(prefix, 10, 64); err == nil && n > b.seq {
					b.seq = n
				}
			}
		}
	}
	return b, nil
}
func (b *Box) Put(o hub.Observation) error {
	raw, e := json.Marshal(o)
	if e != nil {
		return e
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.used+int64(len(raw)) > b.limit {
		return ErrFull
	}
	f, e := os.CreateTemp(b.dir, ".tmp-")
	if e != nil {
		return e
	}
	temp := f.Name()
	defer os.Remove(temp)
	if _, e = f.Write(raw); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	b.seq++
	dest := filepath.Join(b.dir, fmt.Sprintf("%020d-%s.json", b.seq, o.EventID))
	if e = os.Rename(temp, dest); e != nil {
		return e
	}
	b.used += int64(len(raw))
	return nil
}
func (b *Box) Peek(n int) ([]Item, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	es, e := os.ReadDir(b.dir)
	if e != nil {
		return nil, e
	}
	names := []string{}
	for _, v := range es {
		if strings.HasSuffix(v.Name(), ".json") {
			names = append(names, v.Name())
		}
	}
	sort.Strings(names)
	if len(names) > n {
		names = names[:n]
	}
	items := make([]Item, 0, len(names))
	for _, name := range names {
		raw, e := os.ReadFile(filepath.Join(b.dir, name))
		if e != nil {
			return nil, e
		}
		var o hub.Observation
		if e = json.Unmarshal(raw, &o); e != nil {
			return nil, fmt.Errorf("corrupt outbox item %s; preserved for inspection", name)
		}
		items = append(items, Item{name, o})
	}
	return items, nil
}
func (b *Box) Ack(items []Item) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, i := range items {
		if filepath.Base(i.Name) != i.Name {
			return errors.New("invalid outbox item")
		}
		p := filepath.Join(b.dir, i.Name)
		st, e := os.Stat(p)
		if errors.Is(e, fs.ErrNotExist) {
			continue
		}
		if e != nil {
			return e
		}
		if e = os.Remove(p); e != nil {
			return e
		}
		b.used -= st.Size()
	}
	return nil
}
func (b *Box) Bytes() int64 { b.mu.Lock(); defer b.mu.Unlock(); return b.used }
