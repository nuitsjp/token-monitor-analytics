export type UpdateStage =
  | 'accepted'
  | 'fetching'
  | 'verifying'
  | 'deploying'
  | 'restarting'
  | 'success'
  | 'failed'
  | 'aborted';

export type UpdateOperationalStage = Exclude<UpdateStage, 'success' | 'failed' | 'aborted'>;

export type UpdateStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted';

export type SafeUpdateErrorCode =
  | 'lock_conflict'
  | 'fetch_failed'
  | 'invalid_remote_commit'
  | 'main_moved'
  | 'already_current'
  | 'commit_not_found'
  | 'verification_failed'
  | 'deploy_failed'
  | 'health_check_failed'
  | 'configuration_changed'
  | 'migration_required'
  | 'provision_required'
  | 'job_aborted'
  | 'system_restarted'
  | 'save_state_failed'
  | 'unknown_error';

export interface CurrentVersionInfo {
  releaseId: string | null;
  commitSha: string | null;
  commitDate: string | null;
  configurationId: string | null;
  contentHash: string | null;
  archiveSha256: string | null;
}

export interface CandidateInfo {
  targetCommitSha: string;
  commitDate: string | null;
  message: string | null;
  compareUrl: string | null;
  lastCheckedAt: string | null;
  hasUpdate: boolean;
}

export interface UpdateRecovery {
  stage: UpdateOperationalStage;
  kind: 'pre_stop' | 'post_deploy' | 'post_restart';
  title: string;
  message: string;
  commands: string[];
}

export interface UpdateJobState {
  jobId: string;
  targetCommitSha: string;
  targetCommitDate: string | null;
  targetMessage: string | null;
  repositoryUrl?: string | null;
  branch?: string | null;
  initialConfigurationId?: string | null;
  expectedReleaseId?: string | null;
  contentHash?: string | null;
  archiveSha256?: string | null;
  configurationId?: string | null;
  outcome?: 'updated' | 'unchanged' | null;
  status: UpdateStatus;
  stage: UpdateStage;
  failedStage: UpdateOperationalStage | null;
  recovery: UpdateRecovery | null;
  errorCode: SafeUpdateErrorCode | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface UpdateResponse {
  supported: boolean;
  enabled: boolean;
  current: CurrentVersionInfo;
  candidate: CandidateInfo | null;
  job: UpdateJobState | null;
  reason?: string;
}

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  lock_conflict: '他の発行タスクまたは更新処理が実行中です。',
  fetch_failed: 'mainブランチの最新コミット取得に失敗しました。ネットワーク接続を確認してください。',
  invalid_remote_commit: 'リモートブランチのコミット識別子を検証できないため、更新を中止しました。',
  main_moved: '確認後にmainが進んだため、指定SHAへの更新を中止しました。',
  already_current: '選択したコミットはすでに発行済みです。',
  commit_not_found: '指定されたコミットがリモートのmainブランチに見つかりません。',
  verification_failed: '新バージョンのローカル検証（テストまたはビルド）に失敗したため、適用を中止しました。現在のバージョンは維持されています。',
  deploy_failed: '成果物の配置またはSQLiteバックアップに失敗しました。',
  health_check_failed: '新バージョンの起動または疎通確認に失敗しました。ホストログを確認してください。',
  configuration_changed: '受付後に起動設定が変更されたため、停止前に更新を中止しました。',
  migration_required: '新しいサービス構成には管理者による移行が必要です。',
  provision_required: '更新に必要な固定ツールがありません。管理者にprovision:ubuntuを依頼してください。',
  job_aborted: '更新処理が途中で中断されました（プロセス終了またはサービス停止）。',
  system_restarted: 'OS再起動により更新処理が中断されました。',
  save_state_failed: '状態ファイルの保存に失敗しました。',
  unknown_error: '予期せぬエラーが発生しました。'
};

export function getSafeErrorMessage(code: string | null | undefined): string {
  if (!code) return '';
  return SAFE_ERROR_MESSAGES[code] ?? '更新処理中にエラーが発生しました。ホストログを確認してください。';
}
