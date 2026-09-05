package outbox

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"token-monitor-analytics/collector/internal/hub"
)

func obs(id string) hub.Observation {
	return hub.Observation{SchemaVersion: 1, EventID: id, HubID: "hub-a"}
}
func TestPersistenceOrderAck(t *testing.T) {
	dir := t.TempDir()
	b, e := Open(dir, 1<<20)
	if e != nil {
		t.Fatal(e)
	}
	if e = b.Put(obs("a")); e != nil {
		t.Fatal(e)
	}
	b.Put(obs("b"))
	b, e = Open(dir, 1<<20)
	if e != nil {
		t.Fatal(e)
	}
	is, e := b.Peek(2)
	if e != nil {
		t.Fatal(e)
	}
	if len(is) != 2 || is[0].Observation.EventID != "a" {
		t.Fatal(is)
	}
	if e = b.Ack(is[:1]); e != nil {
		t.Fatal(e)
	}
	left, _ := b.Peek(2)
	if len(left) != 1 || left[0].Observation.EventID != "b" {
		t.Fatal(left)
	}
	if b.Bytes() == 0 {
		t.Fatal("bad byte count")
	}
}
func TestCapacityRetainsData(t *testing.T) {
	b, _ := Open(t.TempDir(), 1)
	if e := b.Put(obs("a")); !errors.Is(e, ErrFull) {
		t.Fatal(e)
	}
	is, _ := b.Peek(1)
	if len(is) != 0 {
		t.Fatal("partial event")
	}
}
func TestCorruptFilePreserved(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "bad.json"), []byte("not json"), 0600)
	b, _ := Open(dir, 1024)
	if _, e := b.Peek(1); e == nil {
		t.Fatal("corruption ignored")
	}
	if _, e := os.Stat(filepath.Join(dir, "bad.json")); e != nil {
		t.Fatal("deleted bad file")
	}
}
func TestPartialTempNotSent(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".tmp-interrupted"), []byte("partial"), 0600)
	b, e := Open(dir, 1024)
	if e != nil {
		t.Fatal(e)
	}
	is, e := b.Peek(1)
	if e != nil || len(is) > 0 {
		t.Fatal(is, e)
	}
}
