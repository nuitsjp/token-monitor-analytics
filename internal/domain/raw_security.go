package domain

import (
	"strings"
)

func IsRawSecretField(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", ""), "_", ""))
	for _, marker := range []string{"credential", "password", "secret", "cookie", "authorization", "authheader", "apikey", "accesskey", "privatekey"} {
		if strings.Contains(key, marker) {
			return true
		}
	}
	if key == "token" {
		return true
	}
	for _, marker := range []string{"accesstoken", "refreshtoken", "authtoken", "bearertoken", "idtoken", "sessiontoken", "oauthtoken", "tokensecret"} {
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
		"devices.periodWindows.today.key", "devices.periodWindows.today.endsAt",
		"devices.periodWindows.month", "devices.periodWindows.month.key", "devices.periodWindows.month.endsAt",
		"devices.periods", "devices.periods.allTime",
		"devices.periods.allTime.totalTokens", "devices.periods.allTime.costUsd",
		"devices.periods.allTime.clients", "devices.periods.allTime.clientCosts",
		"devices.periods.allTime.models", "devices.periods.allTime.modelCosts",
		"devices.periods.allTime.clientModels", "devices.periods.allTime.clientModelCosts",
		"devices.periods.today", "devices.periods.today.totalTokens", "devices.periods.today.costUsd",
		"devices.periods.today.clients", "devices.periods.today.clientCosts",
		"devices.periods.today.models", "devices.periods.today.modelCosts",
		"devices.periods.today.clientModels", "devices.periods.today.clientModelCosts",
		"devices.periods.month", "devices.periods.month.totalTokens", "devices.periods.month.costUsd",
		"devices.periods.month.clients", "devices.periods.month.clientCosts",
		"devices.periods.month.models", "devices.periods.month.modelCosts",
		"devices.periods.month.clientModels", "devices.periods.month.clientModelCosts",
		"devices.limits", "devices.limits.refreshMs",
		"devices.limits.providers", "devices.limits.providers.provider", "devices.limits.providers.accountKey",
		"devices.limits.providers.updatedAt", "devices.limits.providers.planLabel", "devices.limits.providers.windows",
		"devices.limits.providers.windows.kind", "devices.limits.providers.windows.metric",
		"devices.limits.providers.windows.label", "devices.limits.providers.windows.usedPercent",
		"devices.limits.providers.windows.resetsAt", "devices.limits.providers.windows.used",
		"devices.limits.providers.windows.limit", "devices.limits.providers.windows.remaining",
		"devices.limits.providers.windows.currency":
		return true
	}
	return len(withoutIndexes) == 5 && withoutIndexes[0] == "devices" && withoutIndexes[1] == "periods" &&
		(withoutIndexes[2] == "allTime" || withoutIndexes[2] == "today" || withoutIndexes[2] == "month") && map[string]bool{
		"clients": true, "clientCosts": true, "models": true, "modelCosts": true, "clientModels": true, "clientModelCosts": true,
	}[withoutIndexes[3]]
}
