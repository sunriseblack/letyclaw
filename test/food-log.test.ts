import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractFoodLogTrailers,
  saveFoodLogToken,
  loadFoodLogToken,
  claimFoodLogToken,
  unclaimFoodLogToken,
  commitFoodLogToken,
  pruneStaleFoodLogTokens,
  type FoodLogPayload,
} from "../lib.js";
import { appendFoodLog } from "../services/health-food-log.js";

const samplePayload: FoodLogPayload = {
  date: "2026-07-14",
  entries: [
    { meal: "Lunch", description: "Chicken rice bowl", calories_kcal: 650, protein_g: 55 },
    { meal: "Dinner", description: "Greek yogurt with berries", calories_kcal: 430, protein_g: 38 },
  ],
  label: "🍽 Log today's plan",
};

describe("food-log trailers", () => {
  it("strips a valid plan and preserves its exact structured meals", () => {
    const input = `Today's plan:\n<!--FOOD-LOG-START-->\n${JSON.stringify(samplePayload)}\n<!--FOOD-LOG-END-->`;
    const result = extractFoodLogTrailers(input);

    expect(result.clean).toBe("Today's plan:");
    expect(result.errors).toEqual([]);
    expect(result.payloads).toEqual([samplePayload]);
  });

  it("recovers a raw newline inside a meal description", () => {
    const input = `Meal\n<!--FOOD-LOG-START-->{"date":"2026-07-14","entries":[{"meal":"Lunch","description":"Chicken with rice,\nherbs and salad","calories_kcal":650}]}<!--FOOD-LOG-END-->`;
    const result = extractFoodLogTrailers(input);

    expect(result.errors).toEqual([]);
    expect(result.payloads[0]?.entries[0]?.description).toContain("herbs and salad");
  });

  it("rejects unsafe dates and leaves a visible recovery note", () => {
    const input = "Meal\n<!--FOOD-LOG-START-->{\"date\":\"../../etc/passwd\",\"entries\":[{\"meal\":\"Lunch\",\"description\":\"Chicken\"}]}<!--FOOD-LOG-END-->";
    const result = extractFoodLogTrailers(input);

    expect(result.payloads).toEqual([]);
    expect(result.errors).toEqual(["incomplete trailer (failed validation)"]);
    expect(result.clean).toContain("Log food button didn't render");
  });
});

describe("food-log token store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "letyclaw-food-token-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("claims a token exactly once and keeps a committed tombstone", () => {
    const token = saveFoodLogToken(dir, samplePayload, { topicId: 6 });
    expect(loadFoodLogToken(dir, token)?.date).toBe("2026-07-14");

    expect(claimFoodLogToken(dir, token)?.entries).toHaveLength(2);
    expect(claimFoodLogToken(dir, token)).toBeNull();
    expect(commitFoodLogToken(dir, token)).toBe(true);
    expect(claimFoodLogToken(dir, token)).toBeNull();
  });

  it("makes a failed local write retryable", () => {
    const token = saveFoodLogToken(dir, samplePayload, { topicId: 6 });
    expect(claimFoodLogToken(dir, token)).not.toBeNull();
    unclaimFoodLogToken(dir, token);
    expect(claimFoodLogToken(dir, token)).not.toBeNull();
  });

  it("prunes expired pending or committed tokens", () => {
    const pending = saveFoodLogToken(dir, samplePayload);
    const committed = saveFoodLogToken(dir, samplePayload);
    expect(claimFoodLogToken(dir, committed)).not.toBeNull();
    expect(commitFoodLogToken(dir, committed)).toBe(true);
    for (const file of [`${pending}.json`, `${committed}.committed`]) {
      const path = join(dir, file);
      const data = JSON.parse(readFileSync(path, "utf8")) as { createdAt: number };
      data.createdAt = Date.now() - 72 * 3_600_000;
      writeFileSync(path, JSON.stringify(data));
    }

    expect(pruneStaleFoodLogTokens(dir, 48)).toBe(2);
  });
});

describe("appendFoodLog", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "letyclaw-food-vault-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("writes analysis-friendly rows once, escaping meal text safely", () => {
    const payload: FoodLogPayload = {
      ...samplePayload,
      entries: [{
        meal: "Lunch",
        description: "Chicken, \"rice\" bowl\nwith salad",
        calories_kcal: 650,
        protein_g: 55,
      }],
    };
    const first = appendFoodLog(vault, payload, new Date("2026-07-14T12:34:56.000Z"));
    const second = appendFoodLog(vault, payload, new Date("2026-07-14T18:00:00.000Z"));
    const csv = readFileSync(first.file, "utf8");

    expect(first.file).toBe(join(vault, "health", "food", "2026-07.csv"));
    expect(first).toMatchObject({ entryCount: 1, caloriesKcal: 650, proteinG: 55 });
    expect(second.entryCount).toBe(1);
    expect(csv.match(/^date,logged_at,meal,description,calories_kcal,protein_g,source$/gm)).toHaveLength(1);
    expect(csv).toContain('"Chicken, ""rice"" bowl with salad"');
    expect(csv).toContain('"suggested_button"');
  });
});
