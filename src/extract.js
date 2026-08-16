const REQUIRED_FIELDS = ["Date", "Workout Type"];
const TRI_STATE = new Set(["clean", "issue", null]);
const SOURCE_FIELDS = new Set([
  "Date",
  "Workout Type",
  "Distance (km)",
  "Duration",
  "Avg Heart Rate",
  "Avg Pace",
  "Zone 1",
  "Zone 2",
  "Zone 3",
  "Zone 4",
  "Zone 5",
  "RPE",
  "Knee Pain",
  "Groin During",
  "Next-Day Knee",
  "Next-Day Groin",
  "Next-Day Calf-Achilles",
  "Knee Routine Done",
]);

const EXTRACT_SYSTEM = `Extract one completed workout from 1-4 screenshots.
Return JSON only: {"fields":{},"confidence":0.0,"missing":[]}.
Use the exact English column names supplied by the user message.
Do not infer an unreadable value. Use null and list its column in missing.
Keep dates as YYYY-MM-DD and times as H:MM:SS or M:SS.`;

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new TypeError("Extractor returned invalid JSON");
  }
}

function seconds(value) {
  if (typeof value !== "string" || !/^\d{1,2}:\d{2}(?::\d{2})?$/u.test(value)) {
    return null;
  }
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.slice(1).some((part) => part > 59)) {
    return null;
  }
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3_600 + parts[1] * 60 + parts[2];
}

function rangeError(errors, row, field, min, max) {
  const value = row[field];
  if (value === null || value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    errors.push({ field, code: "out_of_range", expected: `${min}-${max}` });
  }
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateTimes(row, errors) {
  const duration = row.Duration == null ? null : seconds(row.Duration);
  if (row.Duration != null && duration === null) {
    errors.push({ field: "Duration", code: "invalid_time" });
  }
  const pace = row["Avg Pace"] == null ? null : seconds(row["Avg Pace"]);
  if (row["Avg Pace"] != null && (pace === null || pace < 180 || pace > 900)) {
    errors.push({ field: "Avg Pace", code: "out_of_range", expected: "3:00-15:00" });
  }

  const zones = [1, 2, 3, 4, 5].map((number) => row[`Zone ${number}`]);
  if (zones.every((value) => value == null)) return;
  const zoneSeconds = zones.map((value, index) => {
    if (value == null) return 0;
    const parsed = seconds(value);
    if (parsed === null) errors.push({ field: `Zone ${index + 1}`, code: "invalid_time" });
    return parsed ?? 0;
  });
  if (duration !== null && Math.abs(zoneSeconds.reduce((sum, value) => sum + value, 0) - duration) > 60) {
    errors.push({ field: "Zones", code: "sum_mismatch" });
  }
}

export function validateExtraction(payload, { asOf } = {}) {
  if (!validDate(asOf)) {
    throw new TypeError("validateExtraction requires an explicit asOf date");
  }
  if (!payload?.fields || typeof payload.fields !== "object" || Array.isArray(payload.fields)) {
    throw new TypeError("Extractor output requires a fields object");
  }

  const row = {};
  for (const [field, value] of Object.entries(payload.fields)) {
    if (SOURCE_FIELDS.has(field)) row[field] = value === "" ? null : value;
  }
  row.Source = "ocr";

  const missing = new Set(Array.isArray(payload.missing) ? payload.missing : []);
  for (const field of REQUIRED_FIELDS) {
    if (row[field] === null || row[field] === undefined) missing.add(field);
  }

  const errors = [];
  if (row.Date != null && (!validDate(row.Date) || row.Date > asOf)) {
    errors.push({ field: "Date", code: "invalid_or_future_date" });
  }
  rangeError(errors, row, "Distance (km)", 0, 50);
  rangeError(errors, row, "Avg Heart Rate", 30, 200);
  rangeError(errors, row, "RPE", 1, 10);
  rangeError(errors, row, "Knee Pain", 0, 10);
  rangeError(errors, row, "Groin During", 0, 10);
  validateTimes(row, errors);

  for (const field of ["Next-Day Knee", "Next-Day Groin", "Next-Day Calf-Achilles"]) {
    if (Object.hasOwn(row, field) && !TRI_STATE.has(row[field])) {
      errors.push({ field, code: "invalid_tri_state" });
    }
  }
  if (Object.hasOwn(row, "Knee Routine Done") &&
      row["Knee Routine Done"] !== null &&
      typeof row["Knee Routine Done"] !== "boolean") {
    errors.push({ field: "Knee Routine Done", code: "invalid_boolean" });
  }
  const confidence = Number(payload.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push({ field: "confidence", code: "out_of_range", expected: "0-1" });
  }

  return { row, confidence, missing: [...missing], errors };
}

export function createWorkoutExtractor({ model }) {
  if (!model || typeof model.generate !== "function") throw new TypeError("A model client is required");

  return {
    async extract({ images, asOf }) {
      if (!Array.isArray(images) || images.length < 1 || images.length > 4) {
        throw new TypeError("Extraction requires 1-4 images");
      }
      for (const image of images) {
        const validBase64 = typeof image?.mediaType === "string" && typeof image?.data === "string";
        const validSource = image?.source?.type === "url" && typeof image.source.url === "string";
        if (!validBase64 && !validSource) throw new TypeError("Each image requires base64 data or a URL source");
      }
      const content = images.map((image) => ({
        type: "image",
        source: image.source ?? {
          type: "base64",
          media_type: image.mediaType,
          data: image.data,
        },
      }));
      content.push({
        type: "text",
        text: `As-of date: ${asOf}\nAllowed columns: ${[...SOURCE_FIELDS].join(", ")}`,
      });
      const response = await model.generate({
        tier: "haiku",
        system: EXTRACT_SYSTEM,
        messages: [{ role: "user", content }],
        maxTokens: 1_024,
        cache: true,
      });
      return {
        ...validateExtraction(parseJson(response.text), { asOf }),
        usage: response.usage,
        budget: response.budget ?? null,
      };
    },
  };
}

export function createExtractionWorkflow({ db, sheets, extractor, now = () => new Date() }) {
  if (!db || !sheets || !extractor) throw new TypeError("db, sheets and extractor are required");

  function getPending(pendingId, userId) {
    return db.prepare(
      "SELECT * FROM pending_extractions WHERE id = ? AND user_id = ?",
    ).get(pendingId, String(userId));
  }

  function resultFromRow(row) {
    const missing = JSON.parse(row.missing_json);
    const errors = JSON.parse(row.errors_json);
    const metrics = row.usage_json ? JSON.parse(row.usage_json) : null;
    const wrappedMetrics = metrics && Object.hasOwn(metrics, "usage");
    return {
      pendingId: row.id,
      row: JSON.parse(row.row_json),
      missing,
      errors,
      confidence: row.confidence,
      usage: wrappedMetrics ? metrics.usage : metrics,
      budget: wrappedMetrics ? metrics.budget ?? null : null,
      canConfirm: errors.length === 0 && !missing.some((field) => REQUIRED_FIELDS.includes(field)),
      status: row.status === "pending" ? "awaiting_confirmation" : row.status,
    };
  }

  return {
    async submit({ userId, images, asOf, eventKey = null }) {
      if (eventKey) {
        const existing = db.prepare(
          "SELECT * FROM pending_extractions WHERE event_key = ?",
        ).get(String(eventKey));
        if (existing) return resultFromRow(existing);
      }
      const result = await extractor.extract({ images, asOf });
      const createdAt = now().toISOString();
      const inserted = db.prepare(`
        INSERT INTO pending_extractions
          (user_id, event_key, row_json, missing_json, errors_json,
           confidence, usage_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(userId),
        eventKey ? String(eventKey) : null,
        JSON.stringify(result.row),
        JSON.stringify(result.missing),
        JSON.stringify(result.errors),
        result.confidence,
        result.usage || result.budget
          ? JSON.stringify({ usage: result.usage ?? null, budget: result.budget ?? null })
          : null,
        createdAt,
      );
      return resultFromRow(db.prepare(
        "SELECT * FROM pending_extractions WHERE id = ?",
      ).get(Number(inserted.lastInsertRowid)));
    },

    async confirm({ pendingId, userId, approved }) {
      if (approved !== true) throw new TypeError("Explicit approval is required before writing");
      const pending = getPending(pendingId, userId);
      if (!pending || pending.status !== "pending") throw new Error("Pending extraction is not available");
      const errors = JSON.parse(pending.errors_json);
      if (errors.length) throw new Error("Extraction validation errors must be corrected before writing");
      const missing = JSON.parse(pending.missing_json);
      if (missing.some((field) => REQUIRED_FIELDS.includes(field))) {
        throw new Error("Required extraction fields must be supplied before writing");
      }
      const row = JSON.parse(pending.row_json);
      await sheets.write("Runs", row);
      db.prepare(`
        UPDATE pending_extractions SET status = 'confirmed', resolved_at = ? WHERE id = ?
      `).run(now().toISOString(), pendingId);
      return { pendingId, status: "confirmed", row };
    },

    cancel({ pendingId, userId }) {
      const pending = getPending(pendingId, userId);
      if (!pending || pending.status !== "pending") throw new Error("Pending extraction is not available");
      db.prepare(`
        UPDATE pending_extractions SET status = 'cancelled', resolved_at = ? WHERE id = ?
      `).run(now().toISOString(), pendingId);
      return { pendingId, status: "cancelled" };
    },
  };
}
