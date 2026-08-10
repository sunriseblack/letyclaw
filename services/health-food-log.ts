import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { FoodLogPayload } from "../lib.js";

export interface FoodLogAppendResult {
  file: string;
  entryCount: number;
  caloriesKcal?: number;
  proteinG?: number;
}

const CSV_HEADER = "date,logged_at,meal,description,calories_kcal,protein_g,source\n";

function csvField(value: string | number | undefined): string {
  const text = value === undefined
    ? ""
    : String(value).replace(/[\r\n]+/g, " ").trim();
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Append an accepted meal suggestion to a month-level, analysis-friendly food
 * log. The caller receives a token-validated payload, but this guard still
 * prevents a malformed date from ever becoming a filesystem path.
 */
export function appendFoodLog(
  vaultPath: string,
  payload: FoodLogPayload,
  loggedAt = new Date(),
): FoodLogAppendResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
    throw new Error("food log has an invalid date");
  }
  const directory = join(vaultPath, "health", "food");
  const file = join(directory, `${payload.date.slice(0, 7)}.csv`);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, CSV_HEADER);

  const timestamp = loggedAt.toISOString();
  const rows = payload.entries.map((entry) => [
    payload.date,
    timestamp,
    entry.meal,
    entry.description,
    entry.calories_kcal,
    entry.protein_g,
    "suggested_button",
  ].map(csvField).join(",")).join("\n");
  appendFileSync(file, `${rows}\n`);

  const calories = payload.entries.reduce<number | undefined>((total, entry) =>
    entry.calories_kcal === undefined ? total : (total ?? 0) + entry.calories_kcal,
  undefined);
  const protein = payload.entries.reduce<number | undefined>((total, entry) =>
    entry.protein_g === undefined ? total : (total ?? 0) + entry.protein_g,
  undefined);
  return {
    file,
    entryCount: payload.entries.length,
    ...(calories === undefined ? {} : { caloriesKcal: calories }),
    ...(protein === undefined ? {} : { proteinG: protein }),
  };
}
