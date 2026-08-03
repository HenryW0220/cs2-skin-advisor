import { describe, expect, it } from "vitest";
import { deriveLinkageGroup, displayGroupName, isDerivedGroup } from "./item-metadata-groups";

describe("deriveLinkageGroup", () => {
  it("印花按赛事胶囊分组", () => {
    expect(deriveLinkageGroup("Sticker | Aurora (Holo) | Austin 2025")).toBe("capsule:Austin 2025");
    expect(deriveLinkageGroup("Sticker | 9z Team (Holo) | Antwerp 2022")).toBe(
      "capsule:Antwerp 2022"
    );
  });

  it("探员按所属组织分组", () => {
    expect(deriveLinkageGroup("Col. Mangos Dabisi | Guerrilla Warfare")).toBe(
      "agentgroup:Guerrilla Warfare"
    );
    expect(deriveLinkageGroup("Cmdr. Mae 'Dead Cold' Jamison | SWAT")).toBe("agentgroup:SWAT");
  });

  it("皮肤一律返回 null，不覆盖真实收藏品", () => {
    expect(deriveLinkageGroup("AK-47 | Redline (Field-Tested)")).toBeNull();
    expect(deriveLinkageGroup("AWP | Dragon Lore (Factory New)")).toBeNull();
    // StatTrak/纪念品前缀同样是皮肤
    expect(deriveLinkageGroup("StatTrak™ AK-47 | Redline (Field-Tested)")).toBeNull();
    expect(deriveLinkageGroup("Souvenir AWP | Dragon Lore (Factory New)")).toBeNull();
  });

  it("分不出结构的名字返回 null 而不是瞎猜", () => {
    expect(deriveLinkageGroup("Sticker | Katowice 2014")).toBeNull(); // 只有两段，没有赛事段
    expect(deriveLinkageGroup("Chroma Case")).toBeNull();
  });
});

describe("isDerivedGroup", () => {
  it("认得出推导分组和真实收藏品", () => {
    expect(isDerivedGroup("capsule:Austin 2025")).toBe(true);
    expect(isDerivedGroup("agentgroup:SWAT")).toBe(true);
    expect(isDerivedGroup("野火收藏品")).toBe(false);
    expect(isDerivedGroup(null)).toBe(false);
    expect(isDerivedGroup(undefined)).toBe(false);
  });

  // 前缀存在的意义就是防这个：万一有收藏品跟探员组织重名，不加前缀会凭空并成一个假分组
  it("同名的收藏品和探员组织不会被当成同一组", () => {
    expect(deriveLinkageGroup("Some Agent | SWAT")).toBe("agentgroup:SWAT");
    expect(isDerivedGroup("SWAT")).toBe(false);
  });
});

describe("displayGroupName", () => {
  it("界面文案去掉前缀", () => {
    expect(displayGroupName("capsule:Austin 2025")).toBe("Austin 2025");
    expect(displayGroupName("agentgroup:SWAT")).toBe("SWAT");
    expect(displayGroupName("野火收藏品")).toBe("野火收藏品");
  });
});
