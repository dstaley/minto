import { minto, collection, create, update, list, del, sync } from "../../src";

const { expect } = intern.getPlugin("chai");
const { describe, it } = intern.getPlugin("interface.bdd");

describe("collection", () => {
  it("should create instance", () => {
    const db = minto();
    const articles = collection(db, "default", "articles");
    expect(articles.bucket).to.eql("default");
    expect(articles.name).to.eql("articles");
  });

  it("should create, read, update, and delete record", async () => {
    const db = minto();
    const articles = collection<{ id: string; title: string }>(
      db,
      "default",
      "articles"
    );

    // Create
    await create(articles, { title: "Test Article" });

    // Read
    const { data } = await list(articles);
    expect(data.length).to.eql(1);
    expect(data[0].title).to.eql("Test Article");

    // Update
    await update(articles, { ...data[0], title: "New Test Article" });

    const updatedArticles = await list(articles);
    expect(updatedArticles.data.length).to.eql(1);
    expect(updatedArticles.data[0].title).to.eql("New Test Article");

    // Delete
    await del(articles, data[0].id);

    const deletedArticles = await list(articles);
    expect(deletedArticles.data.length).to.eql(0);
  });

  it("syncs records from remote", async () => {
    const db = minto();
    const shipments = collection(db, "default", "shipments");
    await sync(shipments, {
      remote: "https://kinto.getunitrack.com/v1",
      headers: {
        Authorization: `Portier 8d24d1d44ff59225a0c66ef8123d932a7e27de2f1dcd799a963a11f098856a2f`,
      },
    });

    const { data } = await list(shipments);
    console.log({ data });
    expect(data.length).not.to.eql(0);
  });
});
