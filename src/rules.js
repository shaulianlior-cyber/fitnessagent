import { readFileSync } from "node:fs";

const DEFAULT_RULES = JSON.parse(
  readFileSync(new URL("../rules.json", import.meta.url), "utf8"),
).rules;

function fieldValue(context, path) {
  return path.split(".").reduce((value, key) => value?.[key], context);
}

function isMissing(value) {
  return value === null || value === undefined || value === "";
}

function compare(value, condition) {
  switch (condition.op) {
    case "eq":
      return value === condition.value;
    case "is_missing":
      return isMissing(value);
    case "is_not_missing":
      return !isMissing(value);
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(value);
    case "gt":
      return value > condition.value;
    case "gte":
      return value >= condition.value;
    case "lt":
      return value < condition.value;
    case "lte":
      return value <= condition.value;
    default:
      throw new TypeError(`Unsupported rule operator: ${condition.op}`);
  }
}

function matches(condition, context) {
  if (Array.isArray(condition?.all)) {
    return condition.all.every((item) => matches(item, context));
  }
  if (Array.isArray(condition?.any)) {
    return condition.any.some((item) => matches(item, context));
  }
  if (typeof condition?.field !== "string") {
    throw new TypeError("Rule condition requires a field or all/any group");
  }
  return compare(fieldValue(context, condition.field), condition);
}

function ordered(rules, type) {
  return rules
    .filter((rule) => rule.type === type)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

function validateRules(rules) {
  if (!Array.isArray(rules)) throw new TypeError("rules must be an array");
  const ids = new Set();
  for (const rule of rules) {
    if (!rule?.id || ids.has(rule.id)) throw new TypeError("Rule ids must be unique");
    if (!Number.isFinite(rule.priority)) throw new TypeError(`Rule ${rule.id} needs priority`);
    ids.add(rule.id);
  }
}

export function evaluateRules(
  { state = {}, workout = {}, counters = {} },
  rules = DEFAULT_RULES,
) {
  validateRules(rules);
  const context = { state, workout, counters };

  for (const rule of ordered(rules, "hard_block")) {
    if (matches(rule.condition, context)) {
      return {
        verdict: "block",
        ruleId: rule.id,
        reason: rule.message_key ?? rule.action,
        severity: rule.severity ?? "blocking",
      };
    }
  }

  const warnings = ordered(rules, "soft_warn")
    .filter((rule) => matches(rule.condition, context))
    .map((rule) => ({
      ruleId: rule.id,
      reason: rule.message_key ?? rule.action,
      severity: rule.severity ?? "warning",
    }));

  return {
    verdict: "allow",
    ruleId: null,
    reason: warnings.length ? "soft_warning" : "no_blocking_rule",
    severity: warnings.length ? "warning" : "none",
    warnings,
  };
}
