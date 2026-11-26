import {createHmac,randomUUID,timingSafeEqual} from "node:crypto";

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

const lifetime = 72*60*60*1000;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const humanTime = new Intl.DateTimeFormat("ru-RU",{dateStyle:"long",timeStyle:"short",timeZone:"Europe/Moscow"});

export function cardAnnouncement(card,text,origin,channel) {
  const url=origin+"/share/"+card.id;
  const label={poll:"Пройти опрос",tasks:"Открыть список задач",article:"Читать статью"}[card.kind];
  if(channel==="MAX") {
    const plain=text.replaceAll("[","［").replaceAll("]","］");
    return "**"+labels[card.kind]+" BeChat**\n\n"+plain+"\n\n──────────\n["+label+"]("+url+")";
  }
  return labels[card.kind]+" BeChat\n\n"+text+"\n\n──────────\n"+label+"\n"+url;
}
function layout(title,type,content) {
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#091642"><title>'+esc(title)+' · BeChat</title><link rel="icon" href="/bechat-mark.svg"><link rel="stylesheet" href="/share-card.css"></head><body><main><header class="mast"><div class="brand"><img src="/bechat-mark.svg" alt=""><strong>BeChat</strong><span>by BeQuick</span></div><small>'+esc(type)+'</small></header>'+content+'</main></body></html>';
}
function html(res,code,page) {
  res.writeHead(code,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"private, no-store","X-Robots-Tag":"noindex, nofollow, noarchive"});
  res.end(page);
}
export function cardPages(db,{readBody,origin,secret,privateUser,canWrite,notify,now=Date.now}) {
  const q=s=>db.prepare(s);
  db.exec(`CREATE INDEX IF NOT EXISTS bechat_cards ON messages(json_extract(body,'$.card.id')) WHERE json_extract(body,'$.card.id') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS bechat_poll_date ON messages(json_extract(body,'$.at')) WHERE json_extract(body,'$.card.kind')='poll';
    CREATE TABLE IF NOT EXISTS card_answers(card TEXT,actor TEXT,choice INTEGER,PRIMARY KEY(card,actor));`);
  const pollRows="SELECT m.id,m.chat,m.body,c.owner,c.meta FROM messages m JOIN chats c ON c.id=m.chat WHERE json_extract(m.body,'$.card.kind')='poll'";
  function prune(){
    const expired=q(pollRows+" AND json_extract(m.body,'$.at')<=?").all(new Date(now()-lifetime).toISOString());
    if(!expired.length)return;
    db.exec("BEGIN IMMEDIATE");
    try{
      for(const row of expired){
        const m=JSON.parse(row.body);
        q("DELETE FROM card_answers WHERE card=?").run(m.card.id);
        m.expiredPoll=m.card.id; delete m.card;
        m.text="Срок действия опроса истёк";
        q("UPDATE messages SET body=? WHERE id=?").run(JSON.stringify(m),row.id);
      }
      db.exec("COMMIT");
    }catch(e){db.exec("ROLLBACK");throw e;}
    for(const cid of new Set(expired.map(r=>r.chat)))notify(cid);
  }
  prune();
  const timer=setInterval(prune,30000);timer.unref();
  function results(user) {
    prune();
    const out=[];
    for(const row of q(pollRows+" ORDER BY json_extract(m.body,'$.at') DESC").all()) {
      const m=JSON.parse(row.body), card=m.card;
      const owner=card.owner || (JSON.parse(row.meta).accountId?row.owner:null);
      if(owner ? owner!==user.login : !m.author || q("SELECT COUNT(*) AS n FROM amo_staff WHERE name=?").get(m.author).n!==1 || user.name!==m.author)continue;
      const counts=q("SELECT choice,COUNT(*) AS n FROM card_answers WHERE card=? GROUP BY choice").all(card.id);
      const values=new Map(counts.map(v=>[v.choice,v.n]));
      out.push({id:card.id,title:card.title,at:m.at,until:Date.parse(m.at)+lifetime,total:counts.reduce((n,v)=>n+v.n,0),items:card.items.map((label,i)=>({label,count:values.get(i)||0}))});
    }
    return out;
  }
  function sign(id,actor,until) {
    return createHmac("sha256",secret).update(JSON.stringify(["card-vote",id,actor,until])).digest("base64url");
  }
  function proofActor(id,proof) {
    const [actor,exp,signature,...rest]=String(proof||"").split(".");
    if(rest.length || !uuid.test(actor||"") || !/^\d{13}$/.test(exp||"") || Number(exp)<=now() || Number(exp)>now()+lifetime || !/^[\w-]{43}$/.test(signature||""))return null;
    return timingSafeEqual(Buffer.from(sign(id,actor,Number(exp))),Buffer.from(signature))?actor:null;
  }
  async function serve(req,res,url) {
    const id=url.pathname.slice(7);
    try{
      if(!uuid.test(id))error(404,"Карточка недоступна");
      prune();
      const row=q("SELECT chat,body FROM messages WHERE json_extract(body,'$.card.id')=?").get(id);
      if(!row){
        if(q("SELECT 1 FROM messages WHERE json_extract(body,'$.expiredPoll')=? LIMIT 1").get(id))error(410,"Срок действия опроса истёк");
        error(404,"Карточка недоступна");
      }
      const m=JSON.parse(row.body),card=m.card;
      const staff=m.side==="note"?privateUser(id,url,row.chat):null;
      if(!staff && m.side!=="out")error(404,"Карточка недоступна");
      const match=/(?:^|;\s*)bechat-voter=([a-f\d-]+)(?:;|$)/i.exec(req.headers.cookie||"");
      const cookie=uuid.test(match?.[1]||"")?match[1]:null;
      let actor=cookie||randomUUID(),notice="";
      if(req.method==="POST"){
        if(staff)canWrite(staff);
        if(req.headers["sec-fetch-site"]==="cross-site" || (req.headers.origin && req.headers.origin!=="null" && req.headers.origin!==origin))
          error(403,"Откройте опрос по ссылке BeChat");
        const form=new URLSearchParams((await readBody(req,2048)).toString());
        const actorFromForm=proofActor(id,form.get("form"));
        if(!actorFromForm)error(403,"Обновите страницу голосования");
        if(card.kind==="poll" && Date.parse(m.at)+lifetime<=now()){prune();error(410,"Срок действия опроса истёк");}
        actor=cookie||actorFromForm;
        const value=form.get("item"),i=Number(value);
        if(!/^\d+$/.test(value||"") || !card.items || i>=card.items.length)error(400,"Выберите один из вариантов");
        const task=card.kind==="tasks",choice=task?(form.get("done")==="1"?1:0):i;
        const subject=task?String(i):String(staff?.uid||actor);
        q("INSERT INTO card_answers VALUES(?,?,?) ON CONFLICT(card,actor) DO UPDATE SET choice=excluded.choice").run(id,subject,choice);
        notify(row.chat);
        if(cookie){res.writeHead(303,{Location:url.pathname+url.search,"Cache-Control":"no-store"});return res.end();}
      }else if(!["GET","HEAD"].includes(req.method))error(405,"Метод недоступен");
      if(!cookie)res.setHeader("Set-Cookie","bechat-voter="+actor+"; Secure; HttpOnly; SameSite=Lax; Path=/share/; Max-Age=259200");
      const until=card.kind==="poll"?Date.parse(m.at)+lifetime:now()+lifetime;
      const proof=actor+"."+until+"."+sign(id,actor,until);
      const hidden='<input type="hidden" name="form" value="'+esc(proof)+'">';
      let content='<section class="sheet"><h1>'+esc(card.title)+'</h1>';
      if(card.kind==="poll"){
        const vote=q("SELECT choice FROM card_answers WHERE card=? AND actor=?").get(id,String(staff?.uid||actor));
        notice=vote?"Ваш голос учтён. Вы можете изменить ответ.":"Выберите один вариант ответа.";
        content+='<p class="guidance" role="status">'+notice+'</p><form method="post">'+hidden+'<fieldset><legend>Варианты ответа</legend>'+
          card.items.map((s,i)=>'<label class="option"><input type="radio" name="item" value="'+i+'" required '+(vote?.choice===i?'checked':'')+'><span>'+esc(s)+'</span></label>').join("")+
          '</fieldset><div class="actions"><button type="submit">'+(vote?'Изменить ответ':'Проголосовать')+'</button></div></form><footer>До '+esc(humanTime.format(until))+' МСК</footer>';
      }else if(card.kind==="tasks"){
        const answers=new Map(q("SELECT actor,choice FROM card_answers WHERE card=?").all(id).map(r=>[r.actor,r.choice]));
        content+=card.items.map((s,i)=>{const done=!!answers.get(String(i));return '<form method="post">'+hidden+'<input type="hidden" name="item" value="'+i+'"><input type="hidden" name="done" value="'+(done?0:1)+'"><button class="task" aria-pressed="'+done+'">'+(done?'☑':'☐')+' '+esc(s)+'</button></form>';}).join("");
      }else content+='<p class="article">'+esc(card.body)+'</p>';
      html(res,200,layout(card.title,labels[card.kind],content+'</section>'));
    }catch(e){
      const status=e.http||500,heading=e.http?e.message:"Не удалось открыть карточку";
      const detail=status===410?"Три дня с момента отправки прошли. Голосование завершено, ответы удалены.":status===404?"Проверьте ссылку в исходном сообщении.":"Вернитесь к опросу и повторите действие.";
      const again=uuid.test(id) && ![404,410].includes(status)?'<a class="retry" href="'+esc(url.pathname+url.search)+'">Открыть заново</a>':'';
      html(res,status,layout(heading,"BeChat",'<section class="sheet"><h1>'+esc(heading)+'</h1><p class="guidance">'+detail+'</p>'+again+'</section>'));
    }
  }
  return {serve,results,prune,close:()=>clearInterval(timer)};
}
