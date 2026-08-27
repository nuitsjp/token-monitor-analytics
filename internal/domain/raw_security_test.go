package domain

import "testing"

func TestIsRawSecretFieldDistinguishesUsageCountersFromCredentials(t *testing.T) {
	t.Parallel()

	for _, key := range []string{"token", "access_token", "refresh-token", "bearerToken", "apiKey", "clientSecret"} {
		if !IsRawSecretField(key) {
			t.Errorf("IsRawSecretField(%q) = false, want true", key)
		}
	}
	for _, key := range []string{"token_count", "model_tokens_json", "totalTokens", "cacheReadTokens"} {
		if IsRawSecretField(key) {
			t.Errorf("IsRawSecretField(%q) = true, want false", key)
		}
	}
}
