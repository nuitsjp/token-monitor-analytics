package credential

const DefaultTarget = "TokenMonitorAnalytics/Hub/default"

type Store interface {
	Read() (secret string, found bool, err error)
	Write(secret string) error
	Delete() error
}
