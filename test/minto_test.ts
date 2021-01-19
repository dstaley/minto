import { minto } from "../src";

const { expect } = intern.getPlugin("chai");
const { describe, it } = intern.getPlugin("interface.bdd");

describe("minto", () => {
  it("should create instance", () => {
    const db = minto();
    expect(db.api).to.eql(null);
  });
});
