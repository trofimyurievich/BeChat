import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {cardPages,makeCard,cardAnnouncement} from "../server/cards.mjs";

test("polls accept same-site cookieless submissions, count one choice and expire after 72 hours",async()=>{
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,chat,body);CREATE TABLE chats(id,owner,meta);CREATE TABLE amo_staff(login,name);INSERT INTO chats VALUES('chat','owner','{}');");
  const start=Date.UTC(2026,10,26,12);let time=start;
  const service=cardPages(db,{now:()=>time,origin:"https://example.org",secret:"synthetic-secret",
    readBody:async r=>Buffer.from(r.body),notify:()=>{},privateUser:()=>{throw Object.assign(Error("Сессия истекла"),{http:403});},canWrite:()=>{}});
  const card={...makeCard({kind:"poll",title:"<Какой день?>",items:["Среда","Четверг"]}),owner:"owner"};
  const id=randomUUID(),message={id,chat:"chat",at:new Date(start).toISOString(),side:"out",card,text:card.title};
  db.prepare("INSERT INTO messages VALUES(?,?,?)").run(id,"chat",JSON.stringify(message));
  const url=new URL("https://example.org/share/"+card.id);
  async function ask(method,headers={},form={}) {
    const res={headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(code,headers){this.code=code;Object.assign(this.headers,headers);},end(body){this.body=body;}};
    await service.serve({method,headers,body:new URLSearchParams(form).toString()},res,url);
    return res;
  }
  const page=await ask("GET");
  assert.equal(page.code,200);assert.match(page.body,/&lt;Какой день\?&gt;/);
  const proof=/name="form" value="([^"]+)"/.exec(page.body)[1];
  assert.equal((await ask("POST",{origin:"https://other.example"},{form:proof,item:"0"})).code,403);
  assert.equal((await ask("POST",{origin:"null"},{form:"bad",item:"0"})).code,403);
  for(const item of ["0","0","1"]) {
    const vote=await ask("POST",{origin:"null","sec-fetch-site":"same-origin"},{form:proof,item});
    assert.equal(vote.code,200);assert.match(vote.body,/Ваш голос учтён/);
  }
  const owner={login:"owner"}, mine=service.results(owner);
  assert.deepEqual(mine[0].items.map(i=>i.count),[0,1]);assert.equal(mine[0].total,1);
  assert.equal(service.results({login:"other"}).length,0);
  const cookie=page.headers["Set-Cookie"].split(";")[0];
  assert.equal((await ask("POST",{origin:url.origin,cookie},{form:proof,item:"0"})).code,303);
  assert.deepEqual(service.results(owner)[0].items.map(i=>i.count),[1,0]);
  assert.match(cardAnnouncement(card,"Вопрос",url.origin,"MAX"),/\[Пройти опрос\]\(https:\/\/example.org\/share\//);
  time=start+72*3600000;const ended=await ask("GET");
  assert.equal(ended.code,410);assert.match(ended.headers["Content-Type"],/html/);
  assert.equal(service.results(owner).length,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM card_answers").get().n,0);
  assert.equal(JSON.parse(db.prepare("SELECT body FROM messages").get().body).card,undefined);
  service.close();db.close();
});
