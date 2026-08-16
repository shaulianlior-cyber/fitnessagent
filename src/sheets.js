import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export class ReadOnlySheetsError extends Error {
  constructor(operation) {
    super(`Google Sheets write operation '${operation}' is disabled in local demo stages`);
    this.name = "ReadOnlySheetsError";
    this.writeOutcome = "not_written";
  }
}

export class ReadOnlyDemoSheets {
  constructor(fixturePath) {
    this.fixturePath = resolve(fixturePath);
    this.cache = null;
  }

  async load() {
    if (!this.cache) {
      this.cache = JSON.parse(await readFile(this.fixturePath, "utf8"));
    }
    return this.cache;
  }

  async read(tab, range = null) {
    const workbook = await this.load();
    if (!Object.hasOwn(workbook, tab)) {
      throw new Error(`Unknown demo sheet tab: ${tab}`);
    }

    const rows = structuredClone(workbook[tab]);
    if (!range) return rows;

    const start = Math.max(0, range.start ?? 0);
    const end = range.end ?? rows.length;
    return rows.slice(start, end);
  }

  async write() {
    throw new ReadOnlySheetsError("write");
  }

  async update() {
    throw new ReadOnlySheetsError("update");
  }
}

export function createReadOnlySheets(fixturePath) {
  return new ReadOnlyDemoSheets(fixturePath);
}
