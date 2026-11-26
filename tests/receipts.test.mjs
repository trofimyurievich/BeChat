import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createReadReceipts} from "../server/receipts.mjs";

test("read positions survive late history and are scoped to the personal account",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE chats(id,channel,peer);CREATE TABLE messages(chat,remote,body)");
  const observed=[];
  const receipts=createReadReceipts(db,(m,status)=>observed.push([m.id,status]),()=>{});
  receipts.receive({channel:"Telegram",peer:"a:123",basis:"id",position:15});
  assert.equal(receipts.forMessage("Telegram","a:123","12"),"read");
  assert.equal(receipts.forMessage("Telegram","b:123","12"),undefined);
  receipts.receive({channel:"Telegram",peer:"a:123",basis:"id",position:4});
  assert.equal(receipts.forMessage("Telegram","a:123","12"),"read");
  db.prepare("INSERT INTO chats VALUES(?,?,?)").run("chat","WhatsApp","a:123");
  for(const side of ["in","out"])db.prepare("INSERT INTO messages VALUES(?,?,?)").run("chat","key",JSON.stringify({id:side,status:"sent",side}));
  const packet={channel:"WhatsApp",peer:"a:123",remoteId:"key"};
  receipts.receive({...packet,status:"read"});
  assert.deepEqual(observed,[["out","read"]]);
  receipts.receive({...packet,status:"delivered"});
  assert.equal(receipts.forMessage("WhatsApp","a:123","key"),"read");
  assert.deepEqual(observed,[["out","read"]]);
  db.close();
});
