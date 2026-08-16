import { deriveCounters, isCompletedActivity } from "./counters.js";

const NEXT_DAY_FIELDS = {
  knee: "Next-Day Knee",
  groin: "Next-Day Groin",
  calfAchilles: "Next-Day Calf-Achilles",
};

function normalizeTriState(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (normalized === "") return null;
  if (normalized === "clean" || normalized === "issue") return normalized;
  throw new TypeError(`${field} must be clean, issue, or missing`);
}

function normalizeAsOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("asOf must be a valid date");
  return date.toISOString().slice(0, 10);
}

function isValidDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function latestCompletedWorkout(runs, asOf) {
  return runs
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      isCompletedActivity(row) && isValidDateKey(row.Date) && row.Date <= asOf,
    )
    .sort((left, right) =>
      String(left.row.Date).localeCompare(String(right.row.Date)) ||
      left.index - right.index,
    )
    .at(-1)?.row ?? null;
}

function workoutState(row) {
  if (!row) return null;
  const nextDay = Object.fromEntries(
    Object.entries(NEXT_DAY_FIELDS).map(([key, field]) => [
      key,
      normalizeTriState(row[field], field),
    ]),
  );

  return {
    date: row.Date,
    type: row["Workout Type"] ?? null,
    nextDay,
    kneeRoutineDone:
      row["Knee Routine Done"] === true
        ? true
        : row["Knee Routine Done"] === false
          ? false
          : null,
  };
}

export async function rebuildDerivedState({ sheets, asOf }) {
  if (!sheets || typeof sheets.read !== "function") {
    throw new TypeError("rebuildDerivedState requires the Sheets adapter");
  }
  if (asOf === undefined) {
    throw new TypeError("rebuildDerivedState requires an explicit asOf date");
  }

  const asOfDate = normalizeAsOf(asOf);
  const [runs, weightEntries] = await Promise.all([
    sheets.read("Runs"),
    sheets.read("Weight Tracker"),
  ]);
  const counters = deriveCounters({ runs, weightEntries }, { asOf: asOfDate });

  return {
    asOf: asOfDate,
    lastWorkout: workoutState(latestCompletedWorkout(runs, asOfDate)),
    counters,
  };
}
