const INVALID_ERROR = '推定設定の形式が不正です。';
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isSafeObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasDangerousKey(value) {
  return Object.getOwnPropertyNames(value).some((key) => DANGEROUS_KEYS.has(key));
}

function parseRequiredString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function invalidSettings() {
  return { planMultipliers: [], error: INVALID_ERROR };
}

function parsePlanMultipliers(value) {
  if (!isSafeObject(value) || hasDangerousKey(value) || !hasOwn(value, 'planMultipliers')) {
    return null;
  }
  const settings = value.planMultipliers;
  if (!Array.isArray(settings)) return null;
  if (hasDangerousKey(settings)) return null;

  const seenSelectors = new Set();
  const planMultipliers = [];
  for (let index = 0; index < settings.length; index += 1) {
    if (!hasOwn(settings, index)) return null;
    const setting = settings[index];
    if (!isSafeObject(setting) || hasDangerousKey(setting)) return null;
    if (!hasOwn(setting, 'tool') || !hasOwn(setting, 'windowKey') || !hasOwn(setting, 'basePlan')) {
      return null;
    }

    const tool = parseRequiredString(setting.tool);
    const windowKey = parseRequiredString(setting.windowKey);
    const basePlan = parseRequiredString(setting.basePlan);
    if (!tool || !windowKey || !basePlan || !hasOwn(setting, 'plans')) return null;

    const selector = JSON.stringify([tool, windowKey]);
    if (seenSelectors.has(selector)) return null;
    seenSelectors.add(selector);

    const plans = setting.plans;
    if (!isSafeObject(plans) || hasDangerousKey(plans)) return null;
    const normalizedPlans = [];
    const planNames = new Set();
    for (const planName of Object.keys(plans)) {
      const normalizedPlanName = planName.trim();
      if (!normalizedPlanName || DANGEROUS_KEYS.has(normalizedPlanName) || planNames.has(normalizedPlanName)) {
        return null;
      }
      const multiplier = plans[planName];
      if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
      planNames.add(normalizedPlanName);
      normalizedPlans.push([normalizedPlanName, multiplier]);
    }

    const basePlanEntry = normalizedPlans.find(([name]) => name === basePlan);
    if (!planNames.has(basePlan) || basePlanEntry?.[1] !== 1) {
      return null;
    }

    planMultipliers.push({
      tool,
      windowKey,
      basePlan,
      plans: Object.fromEntries(normalizedPlans)
    });
  }

  return planMultipliers;
}

export function parseEstimationSettings(value) {
  if (value === undefined) return { planMultipliers: [], error: null };

  try {
    const planMultipliers = parsePlanMultipliers(value);
    if (planMultipliers === null) return invalidSettings();
    return { planMultipliers, error: null };
  } catch {
    return invalidSettings();
  }
}
