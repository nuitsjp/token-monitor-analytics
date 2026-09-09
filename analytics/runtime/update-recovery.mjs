const OPERATIONAL_STAGES = new Set(['accepted', 'fetching', 'verifying', 'deploying', 'restarting']);

export function normalizeFailedStage(value) {
  return typeof value === 'string' && OPERATIONAL_STAGES.has(value) ? value : null;
}

/**
 * Older state files only carried an error code. Keep those terminal jobs
 * useful to the UI while preferring the runner's explicit stage whenever it
 * is available.
 */
export function inferFailedStage(job) {
  if (!job || (job.status !== 'failed' && job.status !== 'aborted')) return null;
  const explicit = normalizeFailedStage(job.failedStage);
  if (explicit) return explicit;
  if (job.errorCode === 'deploy_failed') return 'deploying';
  if (job.errorCode === 'health_check_failed') return 'restarting';
  return null;
}

const INSPECTION_COMMANDS = Object.freeze([
  'systemctl --user status tma-analytics.service tma-update.service',
  'journalctl --user -u tma-update.service -e',
  'cat /var/lib/tma-deploy/update-state.json'
]);

const RESTART_COMMANDS = Object.freeze([
  ...INSPECTION_COMMANDS,
  'journalctl --user -u tma-analytics.service -e',
  'readlink -f /opt/token-monitor-analytics/current',
  'ls -lt /var/lib/tma-analytics/backups/'
]);

const CONFIGURATION_NOTE = '既定のパスを変更している環境では、発行時の設定値と docs/PUBLICATION.md の復旧手順を確認してください。';

export function recoveryForJob(job) {
  const stage = inferFailedStage(job);
  if (!stage) return null;

  if (stage === 'restarting') {
    return {
      stage,
      kind: 'post_restart',
      title: '再起動後の確認に失敗しました',
      message: `アプリ停止後の起動または疎通確認に失敗した可能性があります。以下は状態確認用のコマンドです。復旧はホストの発行手順に従ってください。${CONFIGURATION_NOTE}`,
      commands: [...RESTART_COMMANDS]
    };
  }

  if (stage === 'deploying') {
    return {
      stage,
      kind: 'post_deploy',
      title: '配置中に更新を中止しました',
      message: `配置、バックアップ、またはサービス停止の途中で失敗した可能性があります。サービスとバックアップの状態を確認し、ホストの発行手順に従って対応してください。${CONFIGURATION_NOTE}`,
      commands: [...INSPECTION_COMMANDS]
    };
  }

  return {
    stage,
    kind: 'pre_stop',
    title: 'アプリ停止前に更新を中止しました',
    message: `現在のアプリを停止する前に更新を中止しました。状態を確認してから更新を再試行してください。${CONFIGURATION_NOTE}`,
    commands: [...INSPECTION_COMMANDS]
  };
}

/** Convert internal state into the safe update DTO returned to the browser. */
export function publicUpdateJob(job) {
  if (!job || typeof job !== 'object') return job;
  const failedStage = normalizeFailedStage(job.failedStage) ?? inferFailedStage(job);
  return {
    ...job,
    failedStage,
    recovery: recoveryForJob({...job, failedStage})
  };
}
