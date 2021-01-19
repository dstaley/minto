import KintoServer from "kinto-node-test-server";
import KintoClient from "kinto-http";
import { v4 } from "uuid";
import { minto, collection, create, update, list, del, sync } from "../src";

const { expect } = intern.getPlugin("chai");
intern.getPlugin("chai").should();
const { describe, it, before, beforeEach, after, afterEach } = intern.getPlugin(
  "interface.bdd"
);

const TEST_KINTO_SERVER =
  process.env.TEST_KINTO_SERVER || "http://0.0.0.0:8888/v1";
const KINTO_PROXY_SERVER = process.env.KINTO_PROXY_SERVER || TEST_KINTO_SERVER;

describe("Integration tests", () => {
  let server: KintoServer;

  before(async () => {
    let kintoConfigPath = __dirname + "/kinto.ini";
    if (process.env.SERVER && process.env.SERVER !== "master") {
      kintoConfigPath = `${__dirname}/kinto-${process.env.SERVER}.ini`;
    }
    server = new KintoServer(KINTO_PROXY_SERVER, { kintoConfigPath });
    await server.loadConfig(kintoConfigPath);
  });

  after(async () => {
    const logLines = (await server.logs()).split("\n");
    const serverDidCrash = logLines.some((l) => l.includes("Traceback"));
    if (serverDidCrash) {
      // Server errors have been encountered, raise to break the build
      const trace = logLines.join("\n");
      throw new Error(
        `Kinto server crashed while running the test suite.\n\n${trace}`
      );
    }
    return server.killAll();
  });

  describe("Synchronization", () => {
    let username: string, password: string, collectionName: string;

    before(async () => {
      await server.start({});
      username = v4();
      password = v4();
      collectionName = v4();

      const client = new KintoClient(TEST_KINTO_SERVER, {
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
      });

      const records = [
        { title: "First post" },
        { title: "Second post" },
        { title: "Third post" },
      ];

      for (const r of records) {
        await client
          .bucket("default")
          .collection(collectionName)
          .createRecord(r);
      }
    });

    after(() => server.stop());

    it("should pull remote records", async () => {
      const db = minto();
      const coll = collection(db, "default", collectionName);
      await sync(coll, {
        remote: TEST_KINTO_SERVER,
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
      });

      const pulledRecords = await list(coll);
      expect(pulledRecords.data.length).to.eql(3);
    });

    it("should push created records", async () => {
      const db = minto();
      const coll = collection(db, "default", collectionName);

      // Initial sync
      await sync(coll, {
        remote: TEST_KINTO_SERVER,
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
      });

      await create(coll, { title: "Fourth post" });
      // Push created record
      await sync(coll, {
        remote: TEST_KINTO_SERVER,
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
      });

      const client = new KintoClient(TEST_KINTO_SERVER, {
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
      });
      const remoteRecords = await client
        .bucket("default")
        .collection(collectionName)
        .listRecords();
      expect(remoteRecords.data.length).to.eql(4);
    });

    it("should report conflicts", async () => {
      const db = minto();
      const coll = collection(db, "default", collectionName);

      // Initial sync
      await sync(coll, {
        remote: TEST_KINTO_SERVER,
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
      });

      const createdRecord = await create(coll, { title: "Fourth post" });
      // Push created record
      await sync(coll, {
        remote: TEST_KINTO_SERVER,
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
      });

      const client = new KintoClient(TEST_KINTO_SERVER, {
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
      });
      // Modify record on server
      await client
        .bucket("default")
        .collection(collectionName)
        .updateRecord({
          ...createdRecord.data,
          title: "Fourth post - server modified",
        });

      // Modify record locally
      await update(coll, {
        ...createdRecord.data,
        title: "Fourth post - local modified",
      });

      // Sync
      const syncResults = await sync(coll, {
        remote: TEST_KINTO_SERVER,
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
      });

      expect(syncResults.conflicts.length).to.eql(1);
    });
  });
});
