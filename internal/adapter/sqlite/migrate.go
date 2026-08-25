package sqlite

import (
	"database/sql"
	"embed"
	"fmt"

	"github.com/pressly/goose/v3"
)

const CurrentSchemaVersion int64 = 10

//go:embed migrations/*.sql
var migrations embed.FS

func migrate(database *sql.DB) error {
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("sqlite3"); err != nil {
		return fmt.Errorf("set migration dialect: %w", err)
	}
	if err := goose.Up(database, "migrations"); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	version, err := goose.GetDBVersion(database)
	if err != nil {
		return fmt.Errorf("read migration version: %w", err)
	}
	if version != CurrentSchemaVersion {
		return fmt.Errorf("migration version %d does not match current schema version %d", version, CurrentSchemaVersion)
	}
	var schemaVersion int64
	if err := database.QueryRow(`SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&schemaVersion); err != nil {
		return fmt.Errorf("read schema metadata: %w", err)
	}
	if schemaVersion != CurrentSchemaVersion {
		return fmt.Errorf("schema metadata version %d does not match current schema version %d", schemaVersion, CurrentSchemaVersion)
	}
	return nil
}
