import { describe, it, expect } from "vitest";
import {
  extractBaseCardName,
  parseDecklist,
  parseGroupsText,
} from "../decklist";

describe("decklist parsing utils", () => {
  it("extractBaseCardName trims set codes and collector numbers", () => {
    expect(extractBaseCardName("Forest (MH3) 318")).toBe("Forest");
    expect(extractBaseCardName("Arcane Signet [M3C] 283")).toBe(
      "Arcane Signet",
    );
    expect(extractBaseCardName("Omo, Queen of Vesuva (M3C) 2 *F*")).toBe(
      "Omo, Queen of Vesuva",
    );
  });
  it("parseDecklist keeps Fallout Vault numbers with colon", () => {
    const text = "2 Vault 112: Sadistic Simulation";
    expect(parseDecklist(text)).toEqual([
      { name: "Vault 112: Sadistic Simulation", count: 2 },
    ]);
  });
  it("parseGroupsText handles headings, counts and ungrouped", () => {
    const txt = [
      "# Creatures",
      "2 Llanowar Elves",
      "Elvish Mystic",
      "#ungrouped",
      "3 Lightning Bolt",
    ].join("\n");
    const res = parseGroupsText(txt);
    expect(res).not.toBeNull();
    expect(res!.groups[0].name).toBe("Creatures");
    expect(res!.groups[0].cards).toEqual([
      "Llanowar Elves",
      "Llanowar Elves",
      "Elvish Mystic",
    ]);
    expect(res!.ungrouped).toEqual([
      "Lightning Bolt",
      "Lightning Bolt",
      "Lightning Bolt",
    ]);
  });
});
