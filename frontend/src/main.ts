import {Service} from "../bindings/token-monitor-analytics/internal/app/index.js";

type Settings = {hubUrl: string; secret?: string; secretConfigured: boolean; intervalSeconds: number};
type Status = {configured: boolean; running: boolean; lastError: string; lastFetchedAt: string; snapshotCount: number; intervalSeconds: number};
type Observation = {
    provider: string; accountKey: string; accountLabel: string; windowKind: string; windowLabel: string;
    periodKey: string; usageUsd: number; utilizationPercent: number; estimatedLimitUsd: number;
    calculationStatus: string; calculationNote: string; observedAt: string; resetAt: string;
};
type AccountOption = {provider: string; accountKey: string; accountLabel: string};
type SubscriptionMetric = {
    id: number; provider: string; accountKey: string; accountLabel: string; planName: string;
    monthlyPriceUsd: number; actualUsageUsd: number | null; estimatedLimitUsd: number | null;
    actualValueMultiplier: number | null; estimatedMaxValueMultiplier: number | null; dataQuality: string;
};
type UsageBreakdown = {dimension: "tool" | "model" | "device"; key: string; label: string; tokens: number; costUsd: number};
type Dashboard = {periodKey: string; totalTokens: number; totalCostUsd: number; subscriptions: SubscriptionMetric[]; trend: Observation[]; breakdowns: UsageBreakdown[]};
type CloudSettings = {url: string; secret?: string; secretConfigured: boolean; enabled: boolean; deviceId: string};

const svgNamespace = "http://www.w3.org/2000/svg";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settingsForm = $("settings-form") as HTMLFormElement;
const subscriptionForm = $("subscription-form") as HTMLFormElement;
const cloudForm = $("cloud-form") as HTMLFormElement;
const hubUrl = $("hub-url") as HTMLInputElement;
const secret = $("secret") as HTMLInputElement;
const interval = $("interval") as HTMLInputElement;
const message = $("settings-message");
const historyBody = $("history-body");
const comparisonBody = $("comparison-body");
const accountSelect = $("subscription-account") as HTMLSelectElement;
const trendFilter = $("trend-filter") as HTMLSelectElement;
const statusPill = $("status-pill");
let accountOptions: AccountOption[] = [];
let currentDashboard: Dashboard = {periodKey: "month", totalTokens: 0, totalCostUsd: 0, subscriptions: [], trend: [], breakdowns: []};

function setMessage(value: string, error = false) {
    message.textContent = value;
    message.classList.toggle("error", error);
}

function formatDate(value: string) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ja-JP");
}

function formatUSD(value: number | null | undefined) {
    if (value === null || value === undefined) return "—";
    return new Intl.NumberFormat("ja-JP", {style: "currency", currency: "USD", maximumFractionDigits: 2}).format(value);
}

function formatNumber(value: number) {
    return new Intl.NumberFormat("ja-JP", {maximumFractionDigits: 0}).format(value || 0);
}

function formatMultiplier(value: number | null | undefined) {
    return value === null || value === undefined ? "—" : `${value.toFixed(2)}×`;
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
    for (const item of items.slice(0, 100)) {
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

function accountValue(account: AccountOption) {
    return `${account.provider}\u0000${account.accountKey}`;
}

function renderAccounts(accounts: AccountOption[]) {
    const previous = accountSelect.value;
    accountOptions = accounts;
    accountSelect.replaceChildren(new Option(accounts.length ? "選択してください" : "観測後に選択", ""));
    for (const account of accounts) {
        accountSelect.appendChild(new Option(`${account.provider} / ${account.accountLabel || account.accountKey}`, accountValue(account)));
    }
    if ([...accountSelect.options].some((option) => option.value === previous)) accountSelect.value = previous;
}

function renderComparison(items: SubscriptionMetric[]) {
    comparisonBody.replaceChildren();
    if (!items.length) {
        const row = document.createElement("tr");
        const cell = appendCell(row, "契約料金を登録してください。", "empty");
        cell.colSpan = 8;
        comparisonBody.appendChild(row);
        return;
    }
    for (const item of items) {
        const row = document.createElement("tr");
        const identity = document.createElement("td");
        const plan = document.createElement("strong");
        plan.textContent = `${item.provider} / ${item.planName}`;
        identity.appendChild(plan);
        const account = document.createElement("small");
        account.textContent = item.accountLabel || item.accountKey;
        identity.appendChild(account);
        row.appendChild(identity);
        appendCell(row, formatUSD(item.monthlyPriceUsd));
        appendCell(row, formatUSD(item.actualUsageUsd));
        appendCell(row, formatMultiplier(item.actualValueMultiplier));
        appendCell(row, formatUSD(item.estimatedLimitUsd));
        appendCell(row, formatMultiplier(item.estimatedMaxValueMultiplier));
        const quality = appendCell(row, item.dataQuality);
        quality.title = item.dataQuality;
        const actions = document.createElement("td");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "danger-button";
        button.textContent = "削除";
        button.addEventListener("click", () => void deleteSubscription(item));
        actions.appendChild(button);
        row.appendChild(actions);
        comparisonBody.appendChild(row);
    }
}

function trendValue(item: Observation) {
    return `${item.provider}\u0000${item.accountKey}\u0000${item.windowKind}`;
}

function renderTrendOptions(items: Observation[]) {
    const previous = trendFilter.value;
    const seen = new Set<string>();
    trendFilter.replaceChildren(new Option("すべての観測", ""));
    for (const item of items) {
        const value = trendValue(item);
        if (seen.has(value)) continue;
        seen.add(value);
        trendFilter.appendChild(new Option(`${item.provider} / ${item.accountLabel || item.accountKey} / ${item.windowLabel || item.windowKind}`, value));
    }
    if ([...trendFilter.options].some((option) => option.value === previous)) trendFilter.value = previous;
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>) {
    const element = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
}

function renderTrend(items: Observation[]) {
    const chart = $("trend-chart") as unknown as SVGSVGElement;
    const empty = $("chart-empty");
    const selected = trendFilter.value;
    const points = items.filter((item) => !selected || trendValue(item) === selected).slice(0, 60).reverse();
    chart.replaceChildren();
    empty.hidden = points.length > 0;
    chart.hidden = points.length === 0;
    if (!points.length) return;

    const left = 62, right = 900, top = 24, bottom = 250;
    const usdMax = Math.max(1, ...points.flatMap((item) => [item.usageUsd || 0, item.estimatedLimitUsd || 0]));
    const x = (index: number) => points.length === 1 ? (left + right) / 2 : left + (right - left) * index / (points.length - 1);
    const yUsd = (value: number) => bottom - (bottom - top) * Math.max(0, value) / usdMax;
    const yPercent = (value: number) => bottom - (bottom - top) * Math.min(100, Math.max(0, value)) / 100;
    for (let step = 0; step <= 4; step++) {
        const y = top + (bottom - top) * step / 4;
        chart.appendChild(svgElement("line", {x1: String(left), x2: String(right), y1: String(y), y2: String(y), class: "grid"}));
        const usdLabel = svgElement("text", {x: "4", y: String(y + 4), class: "axis-label"});
        usdLabel.textContent = `$${(usdMax * (1 - step / 4)).toFixed(0)}`;
        chart.appendChild(usdLabel);
        const percentLabel = svgElement("text", {x: "910", y: String(y + 4), class: "axis-label"});
        percentLabel.textContent = `${Math.round(100 * (1 - step / 4))}%`;
        chart.appendChild(percentLabel);
    }
    const addPolyline = (values: Array<{x: number; y: number}>, className: string) => {
        if (!values.length) return;
        chart.appendChild(svgElement("polyline", {points: values.map((point) => `${point.x},${point.y}`).join(" "), class: className}));
    };
    addPolyline(points.map((item, index) => ({x: x(index), y: yUsd(item.usageUsd)})), "usage-line");
    addPolyline(points.flatMap((item, index) => item.estimatedLimitUsd > 0 ? [{x: x(index), y: yUsd(item.estimatedLimitUsd)}] : []), "estimate-line");
    addPolyline(points.map((item, index) => ({x: x(index), y: yPercent(item.utilizationPercent)})), "utilization-line");
    const firstLabel = svgElement("text", {x: String(left), y: "282", class: "axis-label"});
    firstLabel.textContent = new Date(points[0].observedAt).toLocaleDateString("ja-JP");
    chart.appendChild(firstLabel);
    const lastLabel = svgElement("text", {x: String(right), y: "282", class: "axis-label", "text-anchor": "end"});
    lastLabel.textContent = new Date(points[points.length - 1].observedAt).toLocaleDateString("ja-JP");
    chart.appendChild(lastLabel);
}

function renderBreakdown(dimension: UsageBreakdown["dimension"], items: UsageBreakdown[]) {
    const body = $(`${dimension}-breakdown`);
    body.replaceChildren();
    const rows = items.filter((item) => item.dimension === dimension);
    if (!rows.length) {
        const row = document.createElement("tr");
        const cell = appendCell(row, "データなし", "empty");
        cell.colSpan = 3;
        body.appendChild(row);
        return;
    }
    for (const item of rows) {
        const row = document.createElement("tr");
        appendCell(row, item.label || item.key);
        appendCell(row, formatNumber(item.tokens));
        appendCell(row, formatUSD(item.costUsd));
        body.appendChild(row);
    }
}

function renderDashboard(dashboard: Dashboard) {
    currentDashboard = dashboard;
    $("monthly-cost").textContent = formatUSD(dashboard.totalCostUsd);
    $("monthly-tokens").textContent = formatNumber(dashboard.totalTokens);
    renderComparison(dashboard.subscriptions || []);
    renderTrendOptions(dashboard.trend || []);
    renderTrend(dashboard.trend || []);
    renderBreakdown("tool", dashboard.breakdowns || []);
    renderBreakdown("model", dashboard.breakdowns || []);
    renderBreakdown("device", dashboard.breakdowns || []);
    renderHistory(dashboard.trend || []);
}

async function refresh() {
    const [status, dashboard, accounts] = await Promise.all([
        Service.GetStatus() as Promise<Status>,
        Service.GetDashboard() as Promise<Dashboard>,
        Service.GetAccounts() as Promise<AccountOption[]>,
    ]);
    $("snapshot-count").textContent = String(status.snapshotCount);
    $("last-fetched").textContent = formatDate(status.lastFetchedAt);
    $("running-state").textContent = status.running ? `実行中（${status.intervalSeconds}秒）` : "停止中";
    $("last-error").textContent = status.lastError || "なし";
    statusPill.textContent = status.running ? "定期取得中" : (status.configured ? "設定済み" : "未接続");
    statusPill.classList.toggle("connected", status.configured && !status.lastError);
    renderAccounts(accounts || []);
    renderDashboard(dashboard);
}

async function loadSettings() {
    const settings = await Service.GetSettings() as Settings;
    hubUrl.value = settings.hubUrl;
    interval.value = String(settings.intervalSeconds || 300);
    secret.placeholder = settings.secretConfigured ? "保存済み（変更する場合のみ入力）" : "Hub の共有シークレット";
}

async function loadCloudSettings() {
    const settings = await Service.GetCloudSettings() as CloudSettings;
    ($("cloud-url") as HTMLInputElement).value = settings.url || "";
    ($("cloud-enabled") as HTMLInputElement).checked = settings.enabled;
    const cloudSecret = $("cloud-secret") as HTMLInputElement;
    cloudSecret.value = "";
    cloudSecret.placeholder = settings.secretConfigured ? "保存済み（変更する場合のみ入力）" : "Cloudの共有シークレット";
    $("cloud-device").textContent = `Device: ${settings.deviceId || "—"}`;
}

async function deleteSubscription(item: SubscriptionMetric) {
    if (!window.confirm(`${item.provider} / ${item.planName} の契約料金を削除しますか？`)) return;
    try {
        await Service.DeleteSubscription(item.id);
        setMessage("契約料金を削除しました。");
        await refresh();
    } catch (error) {
        setMessage(String(error), true);
    }
}

function download(content: string, mimeType: string, extension: string) {
    const blob = new Blob([content], {type: `${mimeType};charset=utf-8`});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `token-monitor-analytics-${new Date().toISOString().slice(0, 10)}.${extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
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

subscriptionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = accountOptions.find((account) => accountValue(account) === accountSelect.value);
    if (!selected) {
        setMessage("Provider / Accountを選択してください。", true);
        return;
    }
    try {
        await Service.SaveSubscription({
            provider: selected.provider,
            accountKey: selected.accountKey,
            accountLabel: selected.accountLabel,
            planName: ($("subscription-plan") as HTMLInputElement).value.trim(),
            monthlyPriceUsd: Number(($("subscription-price") as HTMLInputElement).value),
        });
        subscriptionForm.reset();
        setMessage("契約料金を保存しました。");
        await refresh();
    } catch (error) {
        setMessage(String(error), true);
    }
});

cloudForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const cloudSecret = $("cloud-secret") as HTMLInputElement;
    try {
        await Service.SaveCloudSettings({
            url: ($("cloud-url") as HTMLInputElement).value.trim(),
            secret: cloudSecret.value,
            enabled: ($("cloud-enabled") as HTMLInputElement).checked,
            deviceId: "",
            secretConfigured: false,
        });
        cloudSecret.value = "";
        setMessage("クラウド設定を保存しました。");
        await loadCloudSettings();
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

$("cloud-sync").addEventListener("click", async () => {
    const button = $("cloud-sync") as HTMLButtonElement;
    button.disabled = true;
    try {
        const result = await Service.SyncCloudNow() as {uploadedSnapshots: number; syncedAt: string};
        setMessage(`クラウド同期完了: ${result.uploadedSnapshots}スナップショット`);
    } catch (error) {
        setMessage(String(error), true);
    } finally {
        button.disabled = false;
    }
});

$("create-backup").addEventListener("click", async () => {
    try { download(await Service.CreateBackup(), "application/json", "backup.json"); }
    catch (error) { setMessage(String(error), true); }
});

$("select-restore").addEventListener("click", () => ($("restore-file") as HTMLInputElement).click());
$("restore-file").addEventListener("change", async () => {
    const input = $("restore-file") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!window.confirm("現在のローカルデータをバックアップ内容で置き換えます。続行しますか？")) {
        input.value = "";
        return;
    }
    try {
        await Service.RestoreBackup(await file.text());
        setMessage("バックアップを復元しました。シークレットはCredential Managerの現在値を維持しています。");
        await Promise.all([loadSettings(), loadCloudSettings(), refresh()]);
    } catch (error) {
        setMessage(String(error), true);
    } finally {
        input.value = "";
    }
});

trendFilter.addEventListener("change", () => renderTrend(currentDashboard.trend || []));
$("export-csv").addEventListener("click", async () => {
    try { download(await Service.ExportCSV(), "text/csv", "csv"); }
    catch (error) { setMessage(String(error), true); }
});
$("export-json").addEventListener("click", async () => {
    try { download(await Service.ExportJSON(), "application/json", "json"); }
    catch (error) { setMessage(String(error), true); }
});

void (async () => {
    try { await Promise.all([loadSettings(), loadCloudSettings(), refresh()]); }
    catch (error) { setMessage(String(error), true); }
    window.setInterval(() => { void refresh().catch((error) => setMessage(String(error), true)); }, 10000);
})();
