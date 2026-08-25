export type StatusIntent = "info" | "success" | "warning" | "error";

export interface StatusPresentation {
  label: string;
  intent: StatusIntent;
  description: string;
  nextAction?: string;
}

const statuses: Record<string, StatusPresentation> = {
  registered: {
    label: "登録済み",
    intent: "success",
    description: "共有秘密がWindows Credential Managerに登録されています。",
  },
  unregistered: {
    label: "未登録",
    intent: "warning",
    description: "共有秘密が登録されていません。",
    nextAction: "資格情報を登録",
  },
  post_restore_pending: {
    label: "復元後再登録待ち",
    intent: "warning",
    description: "復元後のため、共有秘密の再登録と接続確認が必要です。",
    nextAction: "資格情報を再登録",
  },
  not_checked: {
    label: "未実行",
    intent: "info",
    description: "接続確認はまだ実行されていません。",
    nextAction: "接続確認",
  },
  connected: {
    label: "正常",
    intent: "success",
    description: "対応するHub APIへ接続できました。",
  },
  unreachable: {
    label: "到達不能",
    intent: "error",
    description: "Hubへ到達できません。URLとネットワークを確認してください。",
    nextAction: "再試行",
  },
  timeout: {
    label: "タイムアウト",
    intent: "error",
    description: "固定時間内にHubから応答がありませんでした。",
    nextAction: "再試行",
  },
  tls_error: {
    label: "TLSエラー",
    intent: "error",
    description: "HubのTLS証明書を検証できません。",
  },
  authentication_failed: {
    label: "認証失敗",
    intent: "error",
    description: "Hubの認証に失敗しました。",
    nextAction: "資格情報を更新",
  },
  unsupported_contract: {
    label: "未対応API契約",
    intent: "warning",
    description: "検出したHub API契約には対応していません。",
  },
  invalid_json: {
    label: "不正JSON",
    intent: "error",
    description: "Hubの応答を安全に読み取れません。",
    nextAction: "再試行",
  },
};

export function presentStatus(code: string): StatusPresentation {
  return (
    statuses[code] ?? {
      label: code || "不明",
      intent: "warning",
      description: "未定義の状態です。",
    }
  );
}
