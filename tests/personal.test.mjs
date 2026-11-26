import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createPersonal } from "../server/personal.mjs";

test("pairing, private messages, revocation and shared-account isolation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bechat-personal-"));
  const db = new DatabaseSync(":memory:"),
    events = [],
    processes = [];
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const env = {
    BECHAT_DB: join(dir, "db"),
    PUBLIC_ORIGIN: "https://bechat.example",
    BECHAT_ACCOUNT_KEY: randomBytes(32).toString("base64"),
    TG_API_ID: "12",
    TG_API_HASH: "sample",
    VK_APP_ID: "123",
  };
  function launch() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.send = (msg) => child.stdout.write(JSON.stringify(msg) + "\n");
    child.stdin = new Writable({
      write(chunk, enc, done) {
        const req = JSON.parse(chunk);
        child.send({
          type: "result",
          request: req.request,
          value:
            req.op === "resolve"
              ? req.peer
              : req.op === "send"
                ? "remote-reply"
                : true,
        });
        done();
      },
    });
    child.kill = () => {
      child.stdout.end();
      child.emit("close", 0);
    };
    processes.push(child);
    return child;
  }
  const a = createPersonal(db, (e) => events.push(e), { env, launch });
  const own = { login: "amo:11" },
    other = { login: "amo:12" };
  await assert.rejects(
    a.connect(own, { channel: "Telegram", token: "not-accepted" }),
  );
  for (const channel of ["Telegram", "WhatsApp", "MAX", "ВКонтакте"]) {
    const list = await a.connect(own, { channel });
    const id = list.find((r) => r.channel === channel).id;
    const child = processes.at(-1);
    child.send({ type: "prompt", mode: "qr", image: "dGVzdA==" });
    assert.equal(
      a.list(other.login).find((r) => r.channel === channel).qr,
      undefined,
    );
    assert.equal(
      a.list(own.login).find((r) => r.channel === channel).status,
      "qr",
    );
    child.send({
      type: "message",
      peer: "123",
      remote: "too-early",
      text: "ignored",
    });
    assert.ok(!events.find((e) => e.remoteId === "too-early"));
    child.send({ type: "ready", identity: "111", label: "My profile" });
    child.send({
      type: "message",
      peer: "123",
      remote: "mid-1",
      outgoing: false,
      text: "hello",
    });
    const msg = events.at(-1);
    assert.equal(msg.accountId, id);
    assert.equal(msg.owner, own.login);
    assert.equal(msg.peer, id + ":123");
    assert.equal(a.pick(other.login, channel), null);
    assert.equal(await a.resolvePeer(id, "123"), "123");
    const chat = {
      owner: own.login,
      meta: JSON.stringify({ accountId: id, remotePeer: "123" }),
    };
    assert.equal(await a.send(chat, { text: "reply" }, null), "remote-reply");
    await assert.rejects(
      a.send({ ...chat, owner: other.login }, { text: "deny" }, null),
    );
    await assert.rejects(a.remove(other.login, id));
    await a.connect(other, { channel });
    const duplicate = processes.at(-1);
    duplicate.send({ type: "ready", identity: "111", label: "Duplicate" });
    await Promise.resolve();
    assert.equal(a.pick(other.login, channel), null);
    assert.equal(a.pick(own.login, channel), id);
    await a.remove(own.login, id);
    assert.equal(a.pick(own.login, channel), null);
    assert.equal(
      a.list(own.login).find((r) => r.channel === channel).status,
      "new",
    );
  }
});
