import smsCore from "../dist/sms-core.js";

const crmId = id => /^[1-9]\d{0,15}$/.test(String(id));
export function telegramName(value) {
  let text=String(value||"").trim();
  const link=/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-z][a-z0-9_]{2,31})\/?$/i.exec(text);
  if(link)text=link[1];
  text=text.replace(/^@/,"").toLowerCase();
  return /^[a-z][a-z0-9_]{2,31}$/.test(text)?text:"";
}
function phone(value){try{return smsCore.normalize(value);}catch{return "";}}
function chatKeys(row) {
  const m=JSON.parse(row.meta),p=phone(m.phone||m.smsNumber) ||
    (row.channel==="WhatsApp" && /^\d+(?:(?::\d+)?@s\.whatsapp\.net)?$/.test(m.remotePeer||row.peer)?phone((m.remotePeer||row.peer).split(/[:@]/)[0]):"");
  const tg=row.channel==="Telegram"?telegramName(m.username):"";
  return [p,tg&&"tg:"+tg].filter(Boolean);
}
function contactKeys(c) {
  return new Set([...(Array.isArray(c.phones)?c.phones:[]).map(phone),
    ...(Array.isArray(c.usernames)?c.usernames:[]).map(telegramName).filter(Boolean).map(s=>"tg:"+s)].filter(Boolean));
}
export function crmLinks(db,signal) {
  const sql=s=>db.prepare(s);
  db.exec("CREATE TABLE IF NOT EXISTS crm_search_numbers(owner TEXT,lead TEXT,contact TEXT,phone TEXT,PRIMARY KEY(owner,lead,contact,phone));CREATE INDEX IF NOT EXISTS crm_search_key ON crm_search_numbers(owner,phone);CREATE TABLE IF NOT EXISTS crm_ambiguous_keys(owner TEXT,identity TEXT,PRIMARY KEY(owner,identity))");
  function reconcile(row) {
    const keys=JSON.stringify(chatKeys(row));
    const candidates=sql("SELECT lead,contact FROM crm_contact_numbers WHERE owner=? AND phone IN (SELECT value FROM json_each(?)) UNION SELECT lead,contact FROM crm_search_numbers WHERE owner=? AND phone IN (SELECT value FROM json_each(?))").all(row.owner,keys,row.owner,keys);
    const ambiguous=sql("SELECT 1 FROM crm_ambiguous_keys WHERE owner=? AND identity IN (SELECT value FROM json_each(?)) LIMIT 1").get(row.owner,keys);
    const people=new Set(candidates.filter(c=>crmId(c.contact)).map(c=>c.contact));
    const next=new Map();
    if(!ambiguous && people.size<=1){
      for(const c of candidates) next.set(c.lead+"/"+c.contact,c);
    }
    let changed=false;
    for(const old of sql("SELECT lead,contact FROM crm_chat_links WHERE owner=? AND chat=?").all(row.owner,row.id)){
      if(next.delete(old.lead+"/"+old.contact))continue;
      sql("DELETE FROM crm_chat_links WHERE owner=? AND chat=? AND lead=? AND contact=?").run(row.owner,row.id,old.lead,old.contact);changed=true;
    }
    for(const c of next.values()){sql("INSERT OR IGNORE INTO crm_chat_links VALUES(?,?,?,?)").run(row.owner,row.id,c.lead,c.contact);changed=true;}
    if(changed)signal(row.id);
  }
  function rows(owner){return sql("SELECT * FROM chats WHERE owner=?").all(owner);}
  function card(owner,lead,contacts,leadFields={}) {
    if(!crmId(lead))return;
    sql("DELETE FROM crm_contact_numbers WHERE owner=? AND lead=?").run(owner,lead);
    // A saved card is authoritative for the contacts and identifiers on that lead.
    sql("DELETE FROM crm_search_numbers WHERE owner=? AND lead=?").run(owner,lead);
    const valid=contacts.filter(c=>crmId(c?.id));
    const insert=sql("INSERT OR IGNORE INTO crm_contact_numbers VALUES(?,?,?,?)");
    for(const c of valid)for(const key of contactKeys(c))insert.run(owner,lead,String(c.id),key);
    for(const key of contactKeys(leadFields)){
      const contactsWithKey=valid.filter(c=>contactKeys(c).has(key));
      const source=contactsWithKey.length?contactsWithKey:valid.length===1?valid:[{id:"lead:"+lead}];
      for(const c of source)insert.run(owner,lead,String(c.id),key);
    }
    for(const row of rows(owner))reconcile(row);
  }
  function due(owner) {
    const checked=new Map(sql("SELECT phone,checked FROM crm_phone_checks WHERE owner=?").all(owner).map(v=>[v.phone,v.checked]));
    const keys=new Set(rows(owner).filter(r=>JSON.parse(r.meta).accountId).flatMap(chatKeys));
    return [...keys].filter(k=>(checked.get(k)||0)<Date.now()-86400000).sort((a,b)=>(checked.get(a)||0)-(checked.get(b)||0))[0]||null;
  }
  function search(owner,key,matches) {
    const all=rows(owner);if(!all.some(r=>chatKeys(r).includes(key)) || !Array.isArray(matches))return false;
    sql("INSERT OR REPLACE INTO crm_phone_checks VALUES(?,?,?)").run(owner,key,Date.now());
    sql("DELETE FROM crm_search_numbers WHERE owner=? AND phone=?").run(owner,key);
    sql("DELETE FROM crm_ambiguous_keys WHERE owner=? AND identity=?").run(owner,key);
    const people=new Set(matches.filter(c=>crmId(c?.id)).map(c=>String(c.id)));
    if(people.size>1)sql("INSERT INTO crm_ambiguous_keys VALUES(?,?)").run(owner,key);
    else for(const c of matches)if(crmId(c?.id) && Array.isArray(c.leads))for(const lead of c.leads.filter(crmId))
      sql("INSERT OR IGNORE INTO crm_search_numbers VALUES(?,?,?,?)").run(owner,String(lead),String(c.id),key);
    for(const r of all)if(chatKeys(r).includes(key))reconcile(r);
    return true;
  }
  function dealsFor(owner) {
    const byChat=new Map();
    for(const {chat,lead} of sql("SELECT DISTINCT chat,lead FROM crm_chat_links WHERE owner=? ORDER BY chat,length(lead) DESC,lead DESC").all(owner)){
      if(!crmId(lead))continue;
      if(!byChat.has(chat))byChat.set(chat,[]);
      byChat.get(chat).push(lead);
    }
    return byChat;
  }
  function unresolvedMaxNumbers(owner,lead,account) {
    const chats=sql("SELECT json_extract(meta,'$.phone') AS number FROM chats WHERE owner=? AND channel='MAX' AND json_extract(meta,'$.accountId')=?").all(owner,account);
    const known=new Set(chats.map(chat=>phone(chat.number)));
    if(!known.has(""))return [];
    return sql("SELECT DISTINCT phone FROM crm_contact_numbers WHERE owner=? AND lead=? AND phone LIKE '+%'").all(owner,lead).map(row=>row.phone).filter(number=>!known.has(number));
  }
  function verifiedMaxPeer(owner,account,number,peer) {
    if(!phone(number) || !peer)return;
    const row=sql("SELECT * FROM chats WHERE owner=? AND channel='MAX' AND json_extract(meta,'$.accountId')=? AND json_extract(meta,'$.remotePeer')=?").get(owner,account,String(peer));
    if(!row)return;
    const meta=JSON.parse(row.meta);
    if(meta.phone && phone(meta.phone)!==number)return;
    meta.phone=number;
    const data=JSON.stringify(meta);
    sql("UPDATE chats SET meta=? WHERE id=?").run(data,row.id);
    reconcile({...row,meta:data});
  }
  return {card,search,due,reconcile,dealsFor,unresolvedMaxNumbers,verifiedMaxPeer};
}
