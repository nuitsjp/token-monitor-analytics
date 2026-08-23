import {Service} from "../bindings/token-monitor-analytics/internal/app/index.js";

type Settings = {hubUrl: string; secret?: string; secretConfigured: boolean; intervalSeconds: number};
type Status = {configured: boolean; running: boolean; lastError: string; lastFetchedAt: string; snapshotCount: number; intervalSeconds: number};
type Observation = {
    provider: string; accountKey: string; accountLabel: string; windowKind: string; windowLabel: string;
    periodKey: string; usageUsd: number; utilizationPercent: number; estimatedLimitUsd: number;
    calculationStatus: string; calculationNote: string; observedAt: string; resetAt: string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settingsForm = $("settings-form") as HTMLFormElement;
const hubUrl = $("hub-url") as HTMLInputElement;
const secret = $("secret") as HTMLInputElement;
const interval = $("interval") as HTMLInputElement;
const message = $("settings-message");
const historyBody = $("history-body");
const statusPill = $("status-pill");

function setMessage(value: string, error = false) {
    message.textContent = value;
    message.classList.toggle("error", error);
}

function formatDate(value: string) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ja-JP");
}

function formatUSD(value: number) {
    return new Intl.NumberFormat("ja-JP", {style: "currency", currency: "USD", maximumFractionDigits: 2}).format(value || 0);
}

function appendCell(row: HTMLTableRowElement, value: string, className?: string) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = value;
    row.appendChild(cell);
    return cell;
}

function renderHistory(items: Observation[]) {
    historyBody.replaceChildren();
    if (!items.length) {
        const row = document.createElement("tr");
        const cell = appendCell(row, "まだ観測データがありません。", "empty");
        cell.colSpan = 8;
        historyBody.appendChild(row);
        return;
    }
    for (const item of items) {
        const row = document.createElement("tr");
        appendCell(row, formatDate(item.observedAt));
        const identity = document.createElement("td");
        const provider = document.createElement("strong");
        provider.textContent = item.provider;
        identity.appendChild(provider);
        const account = document.createElement("small");
        account.textContent = item.accountLabel || item.accountKey || "アカウント不明";
        identity.appendChild(account);
        row.appendChild(identity);
        appendCell(row, item.windowLabel || item.windowKind);
        appendCell(row, item.periodKey || "—");
        appendCell(row, formatUSD(item.usageUsd));
        appendCell(row, item.utilizationPercent ? `${item.utilizationPercent.toFixed(1)}%` : "—");
        appendCell(row, item.estimatedLimitUsd ? formatUSD(item.estimatedLimitUsd) : "—");
        const quality = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = `quality ${item.calculationStatus}`;
        badge.textContent = item.calculationStatus || "unknown";
        badge.title = item.calculationNote || "";
        quality.appendChild(badge);
        row.appendChild(quality);
        historyBody.appendChild(row);
    }
}

async function refresh() {
    const [status, history] = await Promise.all([
        Service.GetStatus() as Promise<Status>,
        Service.GetHistory(100) as Promise<Observation[]>,
    ]);
    $("snapshot-count").textContent = String(status.snapshotCount);
    $("last-fetched").textContent = formatDate(status.lastFetchedAt);
    $("running-state").textContent = status.running ? `実行中（${status.intervalSeconds}秒）` : "停止中";
    $("last-error").textContent = status.lastError || "なし";
    statusPill.textContent = status.running ? "定期取得中" : (status.configured ? "設定済み" : "未接続");
    statusPill.classList.toggle("connected", status.configured && !status.lastError);
    renderHistory(history);
}

async function loadSettings() {
    const settings = await Service.GetSettings() as Settings;
    hubUrl.value = settings.hubUrl;
    interval.value = String(settings.intervalSeconds || 300);
    secret.placeholder = settings.secretConfigured ? "保存済み（変更する場合のみ入力）" : "Hub の共有シークレット";
}

settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("保存中…");
    try {
        await Service.SaveSettings({hubUrl: hubUrl.value.trim(), secret: secret.value, intervalSeconds: Number(interval.value || 300)});
        secret.value = "";
        setMessage("設定を保存しました。定期取得を開始できます。");
        await refresh();
    } catch (error) {
        setMessage(String(error), true);
    }
});

$("start-button").addEventListener("click", async () => {
    try { await Service.Start(); setMessage("定期取得を開始しました。"); await refresh(); }
    catch (error) { setMessage(String(error), true); }
});

$("stop-button").addEventListener("click", async () => {
    await Service.Stop();
    setMessage("定期取得を停止しました。");
    await refresh();
});

$("fetch-button").addEventListener("click", async () => {
    const button = $("fetch-button") as HTMLButtonElement;
    button.disabled = true;
    setMessage("取得中…");
    try {
        const result = await Service.FetchNow() as {observationCount: number};
        setMessage(`${result.observationCount} 件の利用枠を保存しました。`);
        await refresh();
    } catch (error) { setMessage(String(error), true); }
    finally { button.disabled = false; }
});

void (async () => {
    try { await loadSettings(); await refresh(); }
    catch (error) { setMessage(String(error), true); }
    window.setInterval(() => { void refresh().catch((error) => setMessage(String(error), true)); }, 10000);
})();
