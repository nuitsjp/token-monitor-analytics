package desktop

import "fmt"

// StatusPresentationSnapshot is the single display contract for status text,
// Fluent intent, icon, explanation and next action used by M01 and T01.
type StatusPresentationSnapshot struct {
	Code        string `json:"code"`
	Label       string `json:"label"`
	Intent      string `json:"intent"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
	NextAction  string `json:"nextAction"`
	NextRoute   string `json:"nextRoute"`
}

type statusPresentationDefinition struct {
	label, intent, icon, description, nextAction, nextRoute string
}

var statusPresentations = map[string]statusPresentationDefinition{
	"not_started":                {"未着手", "subtle", "info", "この設定はまだ開始されていません。", "設定を開始", "/overview"},
	"in_progress":                {"進行中", "informative", "sync", "設定または処理が進行中です。", "続きを確認", "/overview"},
	"complete":                   {"完了", "success", "checkmark", "必要な設定または確認が完了しています。", "", ""},
	"action_required":            {"要対応", "warning", "warning", "利用者の確認または設定が必要です。", "対応する", "/review"},
	"not_checked":                {"未確認", "subtle", "info", "Hub への接続確認がまだ行われていません。", "接続を確認", "/hubs"},
	"connected":                  {"接続済み", "success", "checkmark", "Hub への接続を確認できました。", "", ""},
	"unreachable":                {"到達不能", "danger", "error", "Hub に到達できません。", "Hub を確認", "/hubs"},
	"timeout":                    {"タイムアウト", "danger", "error", "Hub への接続がタイムアウトしました。", "Hub を確認", "/hubs"},
	"tls_error":                  {"TLS エラー", "danger", "error", "Hub の TLS 証明書を検証できません。", "Hub を確認", "/hubs"},
	"authentication_failed":      {"認証失敗", "danger", "error", "Hub の認証に失敗しました。", "資格情報を確認", "/hubs"},
	"unsupported_contract":       {"未対応契約", "danger", "error", "対応していない Hub API 契約です。", "Hub を確認", "/hubs"},
	"invalid_json":               {"応答不正", "danger", "error", "Hub の応答を安全に読み取れません。", "取得履歴を確認", "/hubs"},
	"collection_not_run":         {"未取得", "subtle", "info", "この Hub の取得履歴はありません。", "取得を開始", "/hubs"},
	"collection_idle":            {"待機中", "subtle", "info", "現在実行中の取得はありません。", "", ""},
	"collection_started":         {"収集中", "informative", "sync", "Hub からデータを取得しています。", "取得状況を確認", "/hubs"},
	"collection_succeeded":       {"取得成功", "success", "checkmark", "最後の取得は成功しました。", "", ""},
	"collection_failed":          {"取得失敗", "danger", "error", "最後の取得は失敗しました。", "取得履歴を確認", "/hubs"},
	"collection_skipped":         {"重複要求スキップ", "warning", "warning", "重複した取得要求を実行しませんでした。", "取得履歴を確認", "/hubs"},
	"freshness_current":          {"最新", "success", "checkmark", "保存された取得間隔内の観測です。", "", ""},
	"freshness_stale":            {"鮮度低下", "warning", "warning", "保存された取得間隔を超えて新しい観測がありません。", "取得状況を確認", "/hubs"},
	"reset_scheduled":            {"リセット予定", "informative", "info", "Hub が返したリセット日時です。", "", ""},
	"reset_unknown":              {"不明", "subtle", "info", "リセット日時は提供されていません。", "利用枠を確認", "/limits"},
	"reset_elapsed":              {"経過済み", "warning", "warning", "新しい観測がないままリセット日時を過ぎています。", "取得状況を確認", "/hubs"},
	"privacy_hidden":             {"非表示", "subtle", "info", "プライバシーモードで機微値を非表示にしています。", "", ""},
	"remaining_high":             {"残量良好", "success", "checkmark", "残量は 50% を超えています。", "", ""},
	"remaining_medium":           {"残量注意", "warning", "warning", "残量は 20% 以上 50% 以下です。", "利用枠を確認", "/limits"},
	"remaining_low":              {"残量低下", "danger", "error", "残量は 20% 未満です。", "利用枠を確認", "/limits"},
	"review_action_required":     {"要確認", "warning", "warning", "利用者の判断または設定が必要な項目です。", "要確認を開く", "/review"},
	"review_warning":             {"データ警告", "warning", "warning", "現在有効なデータ品質の警告です。", "警告を確認", "/review"},
	"recalculation_failed":       {"処理失敗", "danger", "error", "判断保存後の再計算が失敗しました。", "失敗を確認", "/review"},
	"insufficient_observations":  {"観測不足", "warning", "warning", "推定に必要な観測が不足しています。", "推定根拠を確認", "/limits"},
	"unidentifiable":             {"識別不能", "warning", "warning", "観測から利用上限を一意に識別できません。", "推定根拠を確認", "/limits"},
	"provisional":                {"暫定推定", "informative", "info", "利用上限は暫定推定です。", "推定根拠を確認", "/limits"},
	"verified":                   {"検証済み推定", "success", "checkmark", "利用上限の推定を検証できました。", "", ""},
	"model_mismatch":             {"モデル不適合", "danger", "error", "観測が推定モデルと整合しません。", "推定根拠を確認", "/limits"},
	"not_applicable":             {"推定対象外", "subtle", "info", "現在の区間は推定対象外です。", "理由を確認", "/limits"},
	"uncomputed":                 {"未算出", "warning", "warning", "利用上限はまだ算出できていません。", "未算出理由を確認", "/limits"},
	"recovery_rolled_back":       {"復元を回復", "warning", "warning", "未完了の復元を検出し、元のデータベースへ戻しました。", "データ管理を確認", "/data"},
	"recovery_committed_cleaned": {"復元完了を確認", "success", "checkmark", "完了済みの復元を確認し、一時ファイルを整理しました。", "データ管理を確認", "/data"},
}

func statusPresentation(code string) (StatusPresentationSnapshot, error) {
	definition, ok := statusPresentations[code]
	if !ok {
		return StatusPresentationSnapshot{}, fmt.Errorf("unsupported overview status %q", code)
	}
	return StatusPresentationSnapshot{
		Code: code, Label: definition.label, Intent: definition.intent, Icon: definition.icon,
		Description: definition.description, NextAction: definition.nextAction, NextRoute: definition.nextRoute,
	}, nil
}
