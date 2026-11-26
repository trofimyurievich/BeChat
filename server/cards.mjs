import {randomUUID} from "node:crypto";

const labels={poll:"Опрос",tasks:"Список задач",article:"Статья"};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const error=(http,message)=>{throw Object.assign(Error(message),{http});};
export function makeCard(input) {
  const kind=input?.kind,title=String(input?.title||"").trim().slice(0,180);
  if(!Object.hasOwn(labels,kind)||!title) error(400,"Введите заголовок");
  if(kind==="article") {
    const body=String(input.body||"").trim();
    if(!body || body.length>20000) error(400,"Введите текст статьи до 20 000 символов");
    return {id:randomUUID(),kind,title,body};
  }
  const items=Array.isArray(input.items)?input.items.map(s=>String(s).trim()).filter(Boolean):[];
  if(items.length<(kind==="poll"?2:1) || items.length>30 || items.some(s=>s.length>250)) error(400,"Проверьте пункты списка");
  return {id:randomUUID(),kind,title,items};
}
export function cardPages(db,{readBody,origin,privateUser,canWrite,notify}) {
  db.exec(`CREATE INDEX IF NOT EXISTS bechat_cards ON messages(json_extract(body,'$.card.id')) WHERE json_extract(body,'$.card.id') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS card_answers(card TEXT,actor TEXT,choice INTEGER,PRIMARY KEY(card,actor));`);
  return async function page(req,res,url) {
    const id=url.pathname.slice(7);
    const row=db.prepare("SELECT chat,body FROM messages WHERE json_extract(body,'$.card.id')=?").get(id);
    if(!row)error(404,"Страница не найдена");
    const m=JSON.parse(row.body),card=m.card;
    const staff=m.side==="note"?privateUser(id,url,row.chat):null;
    if(!staff && m.side!=="out")error(404,"Страница не найдена");
    const cookies=req.headers.cookie||"";
    const voter=/(?:^|; )bechat-voter=([a-f\d-]{36})(?:;|$)/.exec(cookies)?.[1];
    const actor=staff?.uid||voter||randomUUID();
    if(!voter && !staff) res.setHeader("Set-Cookie","bechat-voter="+actor+"; Secure; HttpOnly; SameSite=Lax; Path=/share/; Max-Age=31536000");
    if(req.method==="POST") {
      if(req.headers.origin!==origin || (!voter&&!staff))error(403,"Откройте карточку ещё раз");
      if(staff)canWrite(staff);
      const form=new URLSearchParams((await readBody(req,1024)).toString());
      const value=form.get("item"), i=Number(value);
      if(!/^\d+$/.test(value||"") || !card.items || i>=card.items.length)error(400,"Выберите пункт");
      const who=card.kind==="tasks"?String(i):actor;
      const choice=card.kind==="tasks"?(form.get("done")==="1"?1:0):i;
      db.prepare("INSERT INTO card_answers VALUES(?,?,?) ON CONFLICT(card,actor) DO UPDATE SET choice=excluded.choice").run(id,who,choice);
      notify(row.chat);res.writeHead(303,{Location:url.pathname+url.search});return res.end();
    }
    if(req.method!=="GET")error(405,"Метод не поддерживается");
    const answers=db.prepare("SELECT actor,choice FROM card_answers WHERE card=?").all(id);
    const options=(card.items||[]).map((s,i)=>{
      const done=answers.some(a=>a.actor===String(i)&&a.choice===1);
      const count=answers.filter(a=>a.choice===i).length;
      const text=card.kind==="tasks"?(done?"☑ ":"☐ ")+s:s+" · "+count;
      return '<form method="post"><input type="hidden" name="item" value="'+i+'"><input type="hidden" name="done" value="'+(done?0:1)+'"><button>'+esc(text)+'</button></form>';
    }).join("");
    res.setHeader("X-Robots-Tag","noindex, nofollow, noarchive");
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"private, no-store"});
    res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(card.title)+' · BeChat</title><style>html{color-scheme:light dark;font:16px/1.5 system-ui;background:#080e26;color:#e2e8ff}main{max-width:36rem;margin:8vh auto;padding:24px}small{color:#acbdfd}h1{line-height:1.2}p{white-space:pre-wrap}button{width:100%;padding:12px;margin:4px 0;text-align:left;border:1px solid #344676;border-radius:10px;background:#182959;color:inherit;cursor:pointer}button:hover{background:#233d7e}@media(prefers-color-scheme:light){html{background:#f4f6fc;color:#142347}button{background:#e5ebfa;border-color:#c7d2eb}small{color:#405891}button:hover{background:#cdd8f3}}</style><main><small>BeChat · '+labels[card.kind]+'</small><h1>'+esc(card.title)+'</h1>'+options+(card.body?'<p>'+esc(card.body)+'</p>':'')+'</main></html>');
  };
}
