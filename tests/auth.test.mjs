import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID, createHash, createHmac } from "node:crypto";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { authConfig } from "../server/auth.mjs";

const crm = "https://lcns.amocrm.ru",
  origin = "https://bechat.onbequick.ru",
  client = randomUUID(),
  appKey = randomBytes(32).toString("hex");
const env = {
  AMO_SUBDOMAIN: "lcns",
  AMO_TENANT_ID: "501",
  AMO_CLIENT_ID: client,
  AMO_CLIENT_SECRET: appKey,
  BECHAT_FOUNDER_ID: "31",
  BECHAT_ADMIN_IDS: "32",
  BECHAT_OBSERVER_IDS: "34",
  BECHAT_ACCOUNT_KEY: randomBytes(32).toString("base64"),
  PUBLIC_ORIGIN: origin,
};
const rand = () => randomBytes(32).toString("base64url"),
  digest = (v) => createHash("sha256").update(v).digest("base64url");
const claims = (uid, extra = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: crm,
    aud: origin,
    client_uuid: client,
    account_id: 501,
    user_id: uid,
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 1800,
    ...extra,
  };
};
function jwt(payload) {
  const blob = [{ alg: "HS256", typ: "JWT" }, payload]
    .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
    .join(".");
  return (
    blob + "." + createHmac("sha256", appKey).update(blob).digest("base64url")
  );
}
test("configuration rejects overlapping privileged roles", () =>
  assert.throws(() => authConfig({ ...env, BECHAT_ADMIN_IDS: "31" })));
test("real HTTP server authenticates CRM employees in widget, web and iOS and isolates SMS configuration", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bechat-auth-"));
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const stub = join(dir, "provider.mjs");
  writeFileSync(
    stub,
    `globalThis.fetch=async(url,o={})=>{const u=new URL(url);if(u.origin!=="https://lcns.amocrm.ru")throw Error("Unexpected external destination");if(u.pathname==="/oauth2/access_token"){const v=JSON.parse(o.body);if(v.code!=="crm-code"||v.grant_type!=="authorization_code"||v.redirect_uri!=="https://bechat.onbequick.ru/auth/callback"||v.client_secret!==process.env.AMO_CLIENT_SECRET)return new Response(null,{status:403});return Response.json({access_token:"test-employee",refresh_token:"private-test"})}if(o.headers.Authorization!=="Bearer test-employee")return new Response(null,{status:401});if(u.pathname==="/api/v4/account")return Response.json({id:501,current_user_id:33});if(u.pathname==="/api/v4/users/33")return Response.json({id:33,name:"Тестовый сотрудник"});throw Error("Unknown endpoint")}`,
  );
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(stub).href, "server/main.mjs"],
    {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        ...env,
        BECHAT_DB: join(dir, "test.db"),
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("server exited");
    }),
  ]);
  const base = "http://127.0.0.1:" + port;
  const req = (path, method = "GET", body, headers = {}) =>
    fetch(base + path, {
      method,
      redirect: "manual",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ok = async (...args) => {
    const r = await req(...args);
    const result = await r.json();
    assert.equal(r.status, 200, JSON.stringify(result));
    return result;
  };
  const auth = (token) => ({ Authorization: "Bearer " + token });
  const widget = (uid, proof, custom = claims(uid), src = crm) =>
    req(
      "/auth/widget",
      "POST",
      { challenge: digest(proof) },
      { "X-Auth-Token": jwt(custom), Origin: src },
    );
  const exchange = (ticket, verifier, client) =>
    req("/auth/exchange", "POST", { ticket, verifier, client });
  assert.equal((await ok("/healthz")).version, "1.1.7");
  assert.equal((await req("/api/state")).status, 401);
  assert.equal((await req("/api/deal-timeline?lead=1")).status,401);
  assert.equal((await req("/api/voice-text/file","POST",{})).status,401);
  assert.ok((await ok("/assets/animated-emoji.json")).length>600);
  const html=await (await req("/")).text();
  assert.match(html,/data-build="[a-f0-9]+"/);
  for(const name of ["voice-player","attachments-menu","composer-media"]){
    assert.ok(html.includes(name+".js?build="));
    assert.equal((await req("/"+name+".js")).status,200);
  }
  assert.notEqual(
    (await req("/api/login", "POST", { login: "admin", password: "anything" }))
      .status,
    200,
  );
  assert.equal(
    (await widget(33, rand(), claims(33, { account_id: 502 }))).status,
    403,
  );
  assert.equal((await widget(33, rand(), claims(33, { exp: 10 }))).status, 401);
  assert.equal(
    (await widget(33, rand(), claims(33), "https://other.amocrm.ru")).status,
    403,
  );
  const accounts = {};
  for (const uid of [31, 32, 33, 34]) {
    const proof = rand(),
      p = claims(uid);
    const issued = await widget(uid, proof, p);
    assert.equal(issued.status, 200);
    const { ticket } = await issued.json();
    assert.equal((await widget(uid, proof, p)).status, 401);
    assert.equal((await exchange(ticket, rand(), "widget")).status, 401);
    assert.equal((await exchange(ticket, proof, "ios")).status, 401);
    const verified = await exchange(ticket, proof, "widget");
    assert.equal(verified.status, 200);
    accounts[uid] = (await verified.json()).token;
    assert.equal((await exchange(ticket, proof, "widget")).status, 401);
    const state = await ok("/api/state", "GET", undefined, auth(accounts[uid]));
    assert.equal(state.profile.crmUserId, String(uid));
    assert.equal(state.profile.founder, uid === 31);
    assert.equal(state.chats.length, 0);
    if (uid !== 31)
      assert.equal(
        (
          await req(
            "/api/sms",
            "POST",
            {
              op: "settings",
              active: "",
              kind: "long",
              transport: "https",
              inbound: true,
            },
            auth(accounts[uid]),
          )
        ).status,
        403,
      );
  }
  assert.equal(
    (
      await req(
        "/api/sms",
        "POST",
        {
          op: "settings",
          active: "",
          kind: "long",
          transport: "https",
          inbound: true,
        },
        auth(accounts[31]),
      )
    ).status,
    200,
  );
  const seed = new DatabaseSync(join(dir, "test.db"));
  const privateChat = randomUUID();
  const privateFile = randomUUID();
  seed
    .prepare("INSERT INTO chats VALUES(?,?,?,?,?)")
    .run(
      privateChat,
      "Telegram",
      "test-peer",
      "amo:501:33",
      JSON.stringify({
        name: "Personal chat",
        accountId: randomUUID(),
        remotePeer: "123",
      }),
    );
  seed
    .prepare("INSERT INTO files VALUES(?,?,?,?,?,?,?,?)")
    .run(
      privateFile,
      "amo:501:33",
      privateChat,
      "note.txt",
      "text/plain",
      2,
      null,
      Buffer.from("ok"),
    );
  seed.prepare("UPDATE chats SET meta=json_set(meta,'$.phone','+79990000001') WHERE id=?").run(privateChat);
  const insertMessage=seed.prepare("INSERT INTO messages VALUES(?,?,?,?)");
  const days=["2026-11-17T10:15:03.000Z","2026-11-13T13:12:55.000Z"];
  for(let i=0;i<255;i++){
    const id="fixture-"+i;
    insertMessage.run(id,privateChat,null,JSON.stringify({id,side:i===254?"note":"in",at:days[i%2],text:"fixture"}));
  }
  seed.close();
  const proof2=rand(), cachedClaims=claims(33);
  await widget(33,rand(),cachedClaims);
  const resumeData=await ok("/auth/widget","POST",{challenge:digest(proof2),allowResume:true},{"X-Auth-Token":jwt(cachedClaims),Origin:crm});
  const resumeBody={challenge:digest(proof2),assertion:resumeData.ticket};
  assert.equal((await req("/auth/widget-resume","POST",resumeBody,{Origin:origin})).status,401);
  assert.equal((await req("/auth/widget-resume","POST",resumeBody,{Origin:origin,...auth(accounts[31])})).status,403);
  const resumed=await ok("/auth/widget-resume","POST",resumeBody,{Origin:origin,...auth(accounts[33])});
  assert.equal((await exchange(resumed.ticket,proof2,"widget")).status,200);
  const next=await ok("/auth/widget-ticket","POST",{uid:33,challenge:digest(proof2)},{Origin:origin,...auth(accounts[33])});
  assert.equal((await exchange(next.ticket,rand(),"widget")).status,401);
  assert.equal((await exchange(next.ticket,proof2,"widget")).status,200);
  await ok("/api/contact-photos","POST",{lead:"999",contacts:[{id:"321",phones:["8 (999) 000-00-01"]}]},auth(accounts[33]));
  assert.equal((await ok("/api/state?entity=leads&entityId=999","GET",undefined,auth(accounts[33]))).chats[0].id,privateChat);
  assert.equal((await ok("/api/state?entity=leads&entityId=999","GET",undefined,auth(accounts[31]))).chats.length,0);
  const page=after=>ok("/api/deal-timeline?lead=999&after="+after,"GET",undefined,auth(accounts[33]));
  const first=await page(0), second=await page(first.next);
  assert.equal(first.items.length,250);
  assert.equal(second.items.length,4);
  assert.equal(second.next,null);
  assert.equal(new Set([...first.items,...second.items].map(m=>m.id)).size,254);
  assert.deepEqual(first.items.slice(0,2).map(m=>m.at),days);
  assert.equal((await ok("/api/deal-timeline?lead=999","GET",undefined,auth(accounts[31]))).items.length,0);
  const linkChat = uid => req("/api/deal-dialogs", "POST", {chat:privateChat,lead:"456"}, auth(accounts[uid]));
  assert.equal((await linkChat(31)).status, 404);
  assert.equal((await ok("/api/deal-dialogs","GET",undefined,auth(accounts[33])))[0].id, privateChat);
  assert.equal((await linkChat(33)).status, 200);
  assert.equal((await ok("/api/state?entity=leads&entityId=456","GET",undefined,auth(accounts[33]))).chats[0].id, privateChat);
  assert.equal((await ok("/api/state?entity=leads&entityId=457","GET",undefined,auth(accounts[33]))).chats.length, 0);
  assert.equal((await ok("/api/state?entity=leads&entityId=456","GET",undefined,auth(accounts[31]))).chats.length, 0);
  for (const uid of [31, 32, 33, 34]) {
    const view = await ok("/api/state", "GET", undefined, auth(accounts[uid]));
    assert.equal(
      view.chats.some((c) => c.id === privateChat),
      uid === 33,
    );
    assert.equal(
      (
        await req(
          "/api/files/" + privateFile,
          "GET",
          undefined,
          auth(accounts[uid]),
        )
      ).status,
      uid === 33 ? 200 : 404,
    );
  }
  for (const lane of ["web", "ios"]) {
    const verifier = rand(),
      nonce = rand(),
      start = await req(
        "/auth/start?" +
          new URLSearchParams({
            client: lane,
            challenge: digest(verifier),
            nonce,
          }),
      );
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.get("location"));
    assert.equal(authorization.origin, "https://www.amocrm.ru");
    assert.equal(authorization.searchParams.get("client_id"), client);
    const state = authorization.searchParams.get("state"),
      cookie = start.headers.get("set-cookie").split(";")[0],
      callback =
        "/auth/callback?code=crm-code&referer=lcns.amocrm.ru&state=" + state;
    assert.equal((await req(callback)).status, 401);
    const returned = await req(callback, "GET", undefined, { Cookie: cookie });
    assert.equal(returned.status, 302);
    const dest = new URL(returned.headers.get("location"));
    const params =
      lane === "ios"
        ? dest.searchParams
        : new URLSearchParams(dest.hash.slice(1));
    assert.equal(
      lane === "ios" ? dest.protocol : dest.origin,
      lane === "ios" ? "bechat-auth:" : origin,
    );
    assert.equal(params.get("nonce"), nonce);
    assert.ok(params.get("ticket"));
    assert.equal(
      (await req(callback, "GET", undefined, { Cookie: cookie })).status,
      401,
    );
    const verified = await exchange(params.get("ticket"), verifier, lane);
    assert.equal(verified.status, 200);
    const { token } = await verified.json();
    const profile = (await ok("/api/state", "GET", undefined, auth(token)))
      .profile;
    assert.equal(profile.crmUserId, "33");
    assert.equal(profile.name, "Тестовый сотрудник");
    assert.equal(profile.role, "Менеджер");
    await ok("/api/logout", "POST", {}, auth(token));
    assert.equal(
      (await req("/api/state", "GET", undefined, auth(token))).status,
      401,
    );
  }
});
