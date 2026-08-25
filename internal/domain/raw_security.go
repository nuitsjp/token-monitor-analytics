package domain

import (
	"strings"
)

func IsRawSecretField(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", ""), "_", ""))
	for _, marker := range []string{"credential", "password", "secret", "token", "cookie", "authorization", "authheader", "apikey", "accesskey", "privatekey"} {
		if strings.Contains(key, marker) {
			return true
		}
	}
	return false
}

func IsKnownRawField(kind string, parts []string) bool {
	if len(parts) == 1 {
		return parts[0] == "hubBuild" || parts[0] == "devices"
	}
	if kind == "health" {
		return len(parts) == 2 && parts[0] == "hubBuild" && map[string]bool{
			"schemaVersion": true, "runtime": true, "coreBuildId": true, "runtimeBuildId": true,
			"coreRevision": true, "runtimeRevision": true,
		}[parts[1]]
	}
	if kind != "stats" {
		return false
	}
	withoutIndexes := make([]string, 0, len(parts))
	for _, part := range parts {
		if strings.HasPrefix(part, "[") {
			continue
		}
		withoutIndexes = append(withoutIndexes, part)
	}
	joined := strings.Join(withoutIndexes, ".")
	switch joined {
	case "devices", "devices.deviceId", "devices.usageUpdatedAt", "devices.syncUploadIntervalMs",
		"devices.periodWindows", "devices.periodWindows.timeZone", "devices.periodWindows.today",
		"devices.periodWindows.today.key", "devices.periods", "devices.periods.allTime",
		"devices.periods.allTime.clientCosts", "devices.limits", "devices.limits.refreshMs",
		"devices.limits.providers", "devices.limits.providers.provider", "devices.limits.providers.accountKey",
		"devices.limits.providers.updatedAt", "devices.limits.providers.planLabel", "devices.limits.providers.windows",
		"devices.limits.providers.windows.kind", "devices.limits.providers.windows.metric",
		"devices.limits.providers.windows.label", "devices.limits.providers.windows.usedPercent",
		"devices.limits.providers.windows.resetsAt":
		return true
	}
	return len(withoutIndexes) == 5 && withoutIndexes[0] == "devices" && withoutIndexes[1] == "periods" &&
		withoutIndexes[2] == "allTime" && withoutIndexes[3] == "clientCosts"
}
