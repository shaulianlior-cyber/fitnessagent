const DAY_MS = 24 * 60 * 60 * 1_000;

function dateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? value : null;
}

function asUtcDateKey(value) {
  if (typeof value === "string" && dateKey(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("asOf must be a valid date");
  return date.toISOString().slice(0, 10);
}

function isCompleted(row) {
  if (Object.hasOwn(row, "Completed Activity")) {
    return row["Completed Activity"] === true;
  }

  const status = String(row.Status ?? "").trim().toLowerCase();
  return !["planned", "cancelled", "canceled", "skipped"].includes(status);
}

function isRun(row) {
  const type = String(row["Workout Type"] ?? row["Activity Type"] ?? "");
  return /(?:^|\s)(?:run|running)(?:\s|$)|ריצ/iu.test(type);
}

function latestDate(rows, predicate, asOf) {
  return rows
    .filter((row) => isCompleted(row) && predicate(row))
    .map((row) => dateKey(row.Date))
    .filter((value) => value && value <= asOf)
    .sort()
    .at(-1) ?? null;
}

function daysSince(date, asOf) {
  if (!date) return null;
  return Math.floor(
    (Date.parse(`${asOf}T00:00:00.000Z`) - Date.parse(`${date}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

function hasWeight(row) {
  const value = row.Weight ?? row["Weight (kg)"];
  return value !== null && value !== undefined && value !== "";
}

export function deriveCounters({ runs = [], weightEntries = [] }, options = {}) {
  const asOf = asUtcDateKey(options.asOf ?? new Date());
  const lastRunDate = latestDate(runs, isRun, asOf);
  const lastKneeRoutineDate = latestDate(
    runs,
    (row) => row["Knee Routine Done"] === true,
    asOf,
  );
  const lastWeighInDate = latestDate(weightEntries, hasWeight, asOf);

  return {
    daysSinceRun: daysSince(lastRunDate, asOf),
    daysSinceKneeRoutine: daysSince(lastKneeRoutineDate, asOf),
    daysSinceWeighIn: daysSince(lastWeighInDate, asOf),
  };
}

export function isCompletedActivity(row) {
  return isCompleted(row);
}
