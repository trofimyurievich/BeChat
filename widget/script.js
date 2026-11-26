define(["jquery"], function ($) {
  "use strict";
  return function BeChatWidget() {
    const self = this,
      ns = ".bechatWidget";
    const badge = '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#526db2" d="M19 12h18a7 7 0 0 1 7 7v12a7 7 0 0 1-6 7v6l-8-6H19a7 7 0 0 1-7-7V19a7 7 0 0 1 7-7Z"/><path fill="#afc2ff" d="M10 5h20a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H17L7 40v-8a8 8 0 0 1-5-7V13a8 8 0 0 1 8-8Z"/><g fill="#152951"><circle cx="11" cy="19" r="2.4"/><circle cx="20" cy="19" r="2.4"/><circle cx="29" cy="19" r="2.4"/></g></svg>';
    function widgetStyles(){
      if(document.getElementById("bechat-widget-style"))return;
      const sheet=document.createElement("style");sheet.id="bechat-widget-style";
      sheet.textContent=`.bechat-caption.card-widgets__widget__caption {position:relative;box-sizing:border-box;display:flex;align-items:center;min-height:36px;padding:0 30px 0 10px;background:#132543;color:#dfe7ff;cursor:pointer}
.bechat-caption .card-widgets__widget__caption__logo,.bechat-caption .card-widgets__widget__caption__logo_min {display:none!important}
.bechat-caption .bechat-badge {display:inline-flex;align-items:center;gap:9px;pointer-events:none;font:600 13px/1.2 system-ui,sans-serif;color:inherit}
.bechat-badge svg {width:25px;height:25px;flex:none}
.card-widgets__widget:has(>.bechat-caption)>.card-widgets__widget__body {padding:7px 8px;background:#0c1931}
.bechat-actions {display:grid;grid-template-columns:minmax(0,1fr) 34px;gap:6px}
.bechat-actions button {height:34px;display:grid;place-items:center;min-width:0;padding:0 4px;border:1px solid transparent;border-radius:5px;cursor:pointer;transition:background .15s,transform .15s}
.bechat-actions button:focus-visible {outline:2px solid #a6baff;outline-offset:2px}
.bechat-actions .bechat-open {background:#afc2ff;color:#112345;font:650 11px/1.2 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.025em}
.bechat-actions .bechat-open:hover {background:#ced9ff}
.bechat-actions .bechat-settings {background:#1b315d;border-color:#324d80;color:#c4d2ff}
.bechat-actions .bechat-settings:hover {background:#284477}
.bechat-settings svg {width:16px;height:16px}
.bechat-actions button:active {transform:translateY(1px)}
.bechat-history {box-sizing:border-box;clear:both;margin:7px 0;padding:8px 12px;border:1px solid #324565;border-radius:6px;background:#0e1c36;color:#e3ebff;font:13px/1.4 system-ui,sans-serif}
.bechat-history header {color:#b4c7f1;text-align:center;font-size:12px;font-weight:600}
.bechat-history>div {display:flex;margin:5px 0}
.bechat-history .out {justify-content:flex-end}
.bechat-history>div>div {max-width:78%;padding:6px 10px;border-radius:8px;background:#192a46;overflow-wrap:anywhere}
.bechat-history .out>div {background:#234479}
.bechat-history p {margin:2px 0;color:inherit;white-space:pre-wrap}
.bechat-history small {font-size:11px;color:#ccdaf6}
@media(prefers-reduced-motion:reduce){.bechat-actions button{transition:none}}`;
      document.head.append(sheet);
    }
    function dressCaption(){
      for(const caption of document.querySelectorAll(".bechat-caption")){
        if(caption.querySelector(".bechat-badge"))continue;
        const label=document.createElement("span");
        label.className="bechat-badge";label.innerHTML=badge+"<span>BeChat</span>";caption.append(label);
      }
    }
    function source(context) {
      let url;
      try {
        url = new URL(self.get_settings().service_url || "");
      } catch {
        return null;
      }
      if (url.protocol !== "https:" || url.username || url.password)
        return null;
      const target = new URL("/", url.origin);
      target.searchParams.set("embed", "1");
      const uid=String((window.AMOCRM||window.APP)?.constant("user")?.id||"");
      if (/^[1-9]\d*$/.test(uid)) target.searchParams.set("crmUser",uid);
      if (context) {
        const card = location.pathname.match(
          /^\/(leads|contacts)\/detail\/(\d+)/,
        );
        if (card) {
          target.searchParams.set("entity", card[1]);
          target.searchParams.set("entityId", card[2]);
        }
      }
      return target.href;
    }
    const frames = new Set();
    let feed, observer, panel, resizePanel, opener, panelPath, contactSignature = "", lastContacts = [], photosById = new Map();
    const normalized=value=>{
      let n=String(value||"").replace(/[^\d]/g,"");
      if (/^8\d{10}$/.test(n)) n="7"+n.slice(1);
      return "+"+n;
    };
    async function findCrmContact(phone) {
      const exact=[];
      let path=new URL("/api/v4/contacts",location.origin);
      path.search=new URLSearchParams({query:phone.slice(1),with:"leads",limit:"100"});
      while(path && exact.length<2) {
        const r=await fetch(path,{credentials:"same-origin",headers:{Accept:"application/json"}});
        if(r.status===204) break;
        if(!r.ok) throw Error("CRM unavailable");
        const data=await r.json();
        for(const c of data._embedded?.contacts||[]) {
          if((c.custom_fields_values||[]).some(f=>f.field_code==="PHONE" && f.values?.some(v=>normalized(v.value)===phone)))
            exact.push({id:String(c.id),leads:(c._embedded?.leads||[]).map(l=>String(l.id))});
        }
        const next=data._links?.next?.href;
        path=next ? new URL(next,location.origin) : null;
        if(path && (path.origin!==location.origin || path.pathname!=="/api/v4/contacts")) break;
      }
      return exact;
    }
    function contactsOnCard() {
      return [...document.querySelectorAll(".js-card-fields form.linked-form[action*='/contacts/']")].map(form=>({
        id:form.querySelector("input[name='ID']")?.value || "",
        phones:[...form.querySelectorAll(".control-phone__formatted")].map(input=>input.value).filter(Boolean)
      })).filter(x=>/^[1-9]\d*$/.test(x.id)).slice(0,50);
    }
    function requestPhotos(force=false) {
      if (!feed?.isConnected) return;
      const contacts=contactsOnCard(), key=JSON.stringify(contacts);
      if (!force && key===contactSignature) return;
      lastContacts=contacts;
      contactSignature=key;
      feed.contentWindow.postMessage({type:"bechat:contacts",contacts},new URL(feed.src).origin);
    }
    function putPhotos() {
      for (const form of document.querySelectorAll(".js-card-fields form.linked-form[action*='/contacts/']")) {
        const holder=form.querySelector(".linked-form__field-userpic_inner");
        if (!holder) continue;
        const id=form.querySelector("input[name='ID']")?.value;
        const photos=photosById.get(id)||[];
        const previous=holder.querySelector(".bechat-contact-photos");
        const key=photos.map(p=>p.channel+p.src).join("|");
        if (previous?.bechatKey===key) continue;
        previous?.remove();
        if (!photos.length) continue;
        const strip=document.createElement("span");
        strip.className="bechat-contact-photos";
        strip.bechatKey=key;
        strip.style.cssText="position:absolute;inset:0;display:flex;align-items:center;pointer-events:none;z-index:1";
        holder.style.position="relative";
        photos.forEach((p,index)=>{
          const img=document.createElement("img");
          img.src=p.src; img.title=p.channel; img.alt=p.channel;
          img.style.cssText="width:"+ (index?15:30)+"px;height:"+(index?15:30)+"px;object-fit:cover;border-radius:50%;"+(index?"margin:16px 0 0 -9px;":"");
          strip.append(img);
        });
        holder.append(strip);
      }
    }
    const authorizedFrames=new Map(), delegated=new Map();
    const currentUID=()=>String((window.AMOCRM||window.APP)?.constant("user")?.id||"");
    function onIdentity(event) {
      const message = event.data;
      if (panel && event.source===panel.querySelector("iframe")?.contentWindow &&
          event.origin===new URL(panel.querySelector("iframe").src).origin && message?.type==="bechat:panel:close") {leave();return;}
      if (feed?.isConnected && event.source === feed.contentWindow && event.origin === new URL(feed.src).origin) {
        if(message?.type==="bechat:feed:history" && message.lead===feed.dataset.lead && Array.isArray(message.items)){
          const seen=new Set();
          history=message.items.filter(m=>m && !seen.has(m.id) && seen.add(m.id) && Number.isFinite(Date.parse(m.at))).map(m=>({...m,when:civil(Date.parse(m.at))})).sort((a,b)=>a.when-b.when);
          scheduleHistory();
        }
        if (message?.type === "bechat:feed:size" && Number.isFinite(message.height))
          feed.style.height = Math.min(540, Math.max(64, Math.ceil(message.height))) + "px";
        if (message?.type === "bechat:feed:open") show();
        if (message?.type === "bechat:contacts:ready") requestPhotos(true);
        if (message?.type === "bechat:contacts:photos" && Array.isArray(message.items)) {
          photosById=new Map(message.items.filter(x=>lastContacts.some(c=>c.id===x.id)).map(x=>[
            x.id,(x.photos||[]).filter(p=>typeof p.src==="string" && p.src.length<36100 && /^data:image\/jpeg;base64,\/9j\//.test(p.src)).slice(0,4)
          ]));
          putPhotos();
        }
      }
      const originFrame=[...frames].find(el=>el.isConnected && el.contentWindow===event.source && event.origin===new URL(el.src).origin);
      if (originFrame===feed && originFrame && message?.type==="bechat:crm:find" && /^\+[1-9]\d{6,14}$/.test(message.phone||"")) {
        const source=event.source,dest=event.origin,phone=message.phone;
        findCrmContact(phone).then(matches=>source.postMessage({type:"bechat:crm:matches",phone,matches},dest))
          .catch(()=>source.postMessage({type:"bechat:crm:matches",phone,matches:null},dest));
        return;
      }
      if (originFrame && message?.type==="bechat:sso:active" && String(message.uid)===currentUID()) {
        authorizedFrames.set(originFrame,String(message.uid)); return;
      }
      if (originFrame && message?.type==="bechat:sso:delegated") {
        const p=delegated.get(message.nonce);
        if (p && p.source===originFrame) {
          clearTimeout(p.timer); delegated.delete(message.nonce);
          if(message.ticket) p.reply(message.ticket); else p.ordinary();
        }
        return;
      }
      if (
        message?.type !== "bechat:sso:ready" ||
        !/^[A-Za-z0-9_-]{43}$/.test(message.challenge || "") ||
        !/^[A-Za-z0-9_-]{43}$/.test(message.nonce || "")
      )
        return;
      let match;
      for (const el of frames) {
        if (!el.isConnected) {
          frames.delete(el);
          continue;
        }
        if (
          event.source === el.contentWindow &&
          event.origin === new URL(el.src).origin
        ) {
          match = el;
          break;
        }
      }
      if (!match) return;
      const dest = event.origin,
        reply = (ticket, detail) => {
          if (match.isConnected)
            event.source.postMessage(
              { type: "bechat:sso:result", nonce: message.nonce, ticket, message:detail },
              dest,
            );
        };
      function ordinary() {
        if (!match.isConnected) return;
        try {
        self
          .$authorizedAjax({
            url: dest + "/auth/widget",
            method: "POST",
            type: "POST",
            contentType: "application/json",
            dataType: "json",
            data: JSON.stringify({ challenge: message.challenge, allowResume:true }),
          })
          .done((r) => reply(r.ticket))
          .fail(xhr => reply(null, typeof xhr?.responseJSON?.error==="string" ? xhr.responseJSON.error.slice(0,160) : "Сервер не получил подтверждение входа от amoCRM."));
      } catch {
        reply(null);
        }
      }
      const donor=[...authorizedFrames].find(([el,uid])=>el!==match && el.isConnected && uid===currentUID() && new URL(el.src).origin===dest)?.[0];
      if (!donor) {ordinary(); return;}
      const timer=setTimeout(()=>{delegated.delete(message.nonce);ordinary();},2500);
      delegated.set(message.nonce,{source:donor,timer,reply,ordinary});
      donor.contentWindow.postMessage({type:"bechat:sso:delegate",nonce:message.nonce,challenge:message.challenge,uid:currentUID()},dest);
    }
    function frame(context, inline = false) {
      let src = source(context);
      if (!src)
        return $("<p>").text(
          "Укажите HTTPS-адрес сервера BeChat в настройках интеграции.",
        );
      if (inline) src += "&feed=1&timeline=1";
      const result = $("<iframe>", {
        src,
        title: inline ? "BeChat — сообщения сделки" : "BeChat — переписка",
        allow: inline ? "clipboard-write" : "clipboard-write; microphone",
        referrerpolicy: "no-referrer",
      }).css({
        width: "100%",
        height: "100%",
        border: 0,
        background: "#03051c",
      });
      frames.add(result[0]);
      return result;
    }
    let history=[], layoutFrame=0, blocks=new Map(), nativeTimes=new Map(), pendingTimes=new Set(), timeQueue=new Set(), readingTimes=false;
    const monthNames=["январ","феврал","март","апрел","ма","июн","июл","август","сентябр","октябр","ноябр","декабр"];
    const delivery={sent:"Отправлено",delivered:"Доставлено",read:"Прочитано",sending:"Отправляется",failed:"Ошибка отправки"};
    const tz=(()=>{const zone=(window.AMOCRM||window.APP)?.constant("account")?.timezone;
      try {return new Intl.DateTimeFormat("ru-RU",{timeZone:typeof zone==="string"?zone:undefined,hour12:false,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});}
      catch{return new Intl.DateTimeFormat("ru-RU",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});}})();
    function civil(at) {
      const parts=Object.fromEntries(tz.formatToParts(at).map(p=>[p.type,p.value]));
      return Date.UTC(+parts.year,parts.month-1,+parts.day,+parts.hour%24,+parts.minute,+parts.second)+at%1000;
    }
    function dayStart(value) {return Math.floor(value/86400000)*86400000;}
    function visibleTime(value, day) {
      const s=String(value||"").toLowerCase();
      const full=/(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?!\d)/.exec(s);
      const clock=/(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
      let date=full?Date.UTC(full[3].length===2?2000+Number(full[3]):+full[3],full[2]-1,+full[1]):null;
      if(date===null && /сегодня|вчера|позавчера/.test(s)) date=dayStart(civil(Date.now()))-(/позавчера/.test(s)?2:/вчера/.test(s)?1:0)*86400000;
      if(date===null && clock) date=day;
      return date==null?null:dayStart(date)+(clock?(+clock[1]*3600 + +clock[2]*60 + +(clock[3]||0))*1000:0);
    }
    function queueTime(id) {
      if(/^[0-9a-hjkmnp-tv-z]{26}$/i.test(id||"") && !nativeTimes.has(id) && !pendingTimes.has(id))timeQueue.add(id);
    }
    async function fetchTimes() {
      if(readingTimes || !timeQueue.size)return;
      readingTimes=true;
      const current=feed;
      try{
        while(timeQueue.size && current===feed && current?.isConnected) {
          const ids=[...timeQueue].slice(0,40), params=new URLSearchParams({limit:"100"});
          for(const id of ids){timeQueue.delete(id);pendingTimes.add(id);params.append("filter[id][]",id);}
          try{
            const r=await fetch("/api/v4/events?"+params,{credentials:"same-origin",headers:{Accept:"application/json"}});
            if(!r.ok || r.status===204)continue;
            const data=await r.json();
            if(current!==feed)break;
            for(const e of data._embedded?.events||[]) if(ids.includes(e.id) && e.created_at>0)nativeTimes.set(e.id,civil(e.created_at*1000));
            scheduleHistory();
          }catch{/* Displayed local event times remain available. */}
        }
      }finally{readingTimes=false;if(timeQueue.size && current!==feed)fetchTimes();}
    }
    function scheduleHistory() {
      if (!layoutFrame)layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;placeHistory();});
    }
    function resetHistory() {
      for(const b of blocks.values())b.node.remove();
      blocks.clear();history=[];timeQueue.clear();pendingTimes.clear();nativeTimes.clear();
    }
    function nativeStamp(node, day) {
      const date=node.querySelector(".js-feed-note__date,.card-task__date");
      const text=date?.textContent?.trim()||"", base=visibleTime(text,day);
      const id=node.dataset.id, exact=nativeTimes.get(id);
      queueTime(id);
      if(exact!=null && (base==null || (!text.includes(":") && dayStart(base)===dayStart(exact)) || Math.floor(base/60000)===Math.floor(exact/60000)))return exact;
      return base;
    }
    function anchors(list) {
      const result=[], entries=[...list.children].filter(e=>!e.classList.contains("bechat-history"));
      let day=null;
      for(let i=0;i<entries.length;i++){
        const node=entries[i];
        if(node.hasAttribute("data-point")){
          const point=node.dataset.point;
          day=visibleTime(point,null);
          if(day===null){
            const next=entries.slice(i+1).find(n=>n.matches(".feed-note-wrapper"));
            const following=next?nativeStamp(next,null):null;
            const month=monthNames.findIndex(m=>point.toLowerCase().startsWith(m));
            if(following!=null && month>=0)day=Date.UTC(new Date(following).getUTCFullYear(),month,1);
          }
          if(day!==null)result.push({at:day,node,marker:true});
        }else if(node.matches(".feed-note-wrapper")){
          const children=[...node.querySelectorAll(":scope > .js-grouped-subviews > .feed-note-wrapper")];
          if(children.length>1 && children.every(child=>child.getBoundingClientRect().height>0)){
            children.forEach((child,j)=>{const at=nativeStamp(child,day);if(at!==null)result.push({at,node:j?child:node});});
          }else{
            const at=nativeStamp(node,day)??day;
            if(at!==null)result.push({at,node});
          }
        }
      }
      fetchTimes();
      return result.sort((a,b)=>a.at-b.at || Number(b.marker||false)-Number(a.marker||false));
    }
    function blockNode(group, record) {
      const signature=JSON.stringify(group);
      if(record?.signature===signature)return record;
      const node=record?.node||document.createElement("article");
      node.className="bechat-history";
      node.dataset.day=new Date(group[0].when).toISOString().slice(0,10);
      node.dataset.first=group[0].at;node.dataset.last=group[group.length-1].at;
      node.replaceChildren();
      const header=document.createElement("header");
      header.textContent="["+group[0].channel+"] "+group[0].name;
      node.append(header);
      for(const m of group){
        const row=document.createElement("div"), bubble=document.createElement("div"), stamp=document.createElement("small"), body=document.createElement("p");
        row.className=m.side==="out"?"out":"in";
        const date=new Date(m.when);
        const label=new Intl.DateTimeFormat("ru-RU",{timeZone:"UTC",dateStyle:"short",timeStyle:"short"}).format(date);
        stamp.textContent=[label,m.author,m.side==="out"?delivery[m.status]:""].filter(Boolean).join(" · ");
        body.textContent=[m.text,...(m.files||[]).map(f=>"📎 "+f)].filter(Boolean).join("\n");
        bubble.append(stamp,body);row.append(bubble);node.append(row);
      }
      return {node,signature};
    }
    function placeHistory() {
      const list=feed?.parentElement?.querySelector(".notes-wrapper__notes.js-notes");
      if(!list || !history.length){for(const b of blocks.values())b.node.remove();blocks.clear();return;}
      const events=anchors(list);
      if(!events.length && list.querySelector(":scope > .feed-note-wrapper"))return;
      const more=feed.parentElement.querySelector(".js-feed-load-more");
      const floor=more && !more.classList.contains("hidden") && more.getBoundingClientRect().height && events.length?dayStart(events[0].at):-Infinity;
      const slots=new Map();
      let idx=0;
      for(const m of history){
        if(m.when<floor)continue;
        while(idx<events.length && events[idx].at<=m.when)idx++;
        const anchor=events[idx]?.node||null;
        let groups=slots.get(anchor);
        if(!groups){groups=[];slots.set(anchor,groups);}
        const group=groups.at(-1), prior=group?.at(-1);
        if(prior && prior.chat===m.chat && dayStart(prior.when)===dayStart(m.when) && m.when-prior.when<=1800000)group.push(m);
        else groups.push([m]);
      }
      const keep=new Set();
      for(const [anchor,groups] of slots) {
        const host=anchor?.parentElement||list;
        let next=anchor;
        for(let i=groups.length-1;i>=0;i--){
          const group=groups[i], key=group[0].id;
          const record=blockNode(group,blocks.get(key));
          blocks.set(key,record);keep.add(key);
          if(record.node.parentElement!==host || record.node.nextElementSibling!==next)host.insertBefore(record.node,next);
          next=record.node;
        }
      }
      for(const [key,record] of blocks)if(!keep.has(key)){record.node.remove();blocks.delete(key);}
    }
    function mountFeed() {
      dressCaption();
      const match = location.pathname.match(/^\/leads\/detail\/(\d+)/);
      const parent = match && document.querySelector(".js-card-feed .notes-wrapper__scroller-inner");
      if (feed && (!parent || feed.parentNode !== parent || feed.dataset.lead !== match[1])) {
        resetHistory();
        frames.delete(feed);
        feed.remove();
        feed = null;
      }
      if (panel && location.pathname!==panelPath) leave();
      if (feed) { requestPhotos(); putPhotos(); if(history.length)scheduleHistory(); }
      if (!parent || feed || !source(true)) return;
      contactSignature=""; photosById.clear();
      feed = frame(true, true)[0];
      feed.dataset.lead = match[1];
      feed.style.cssText = "display:block;width:100%;height:72px;border:0;margin:8px 0;color-scheme:dark";
      parent.insertBefore(feed, parent.querySelector(":scope > .notes-wrapper__online"));
    }
    function leave() {
      resizePanel?.disconnect();
      resizePanel=null;
      window.removeEventListener("resize",positionPanel);
      document.removeEventListener("keydown",escapePanel);
      if (panel) {
        authorizedFrames.delete(panel.querySelector("iframe"));
        frames.delete(panel.querySelector("iframe"));
        panel.remove();
        panel=null;
        if (opener?.isConnected) opener.focus({preventScroll:true});
      }
    }
    function escapePanel(event) {
      if (event.key==="Escape" && !event.defaultPrevented) leave();
    }
    function positionPanel() {
      if (!panel) return;
      const fields=document.querySelector(".js-card-fields")?.getBoundingClientRect();
      const timeline=document.querySelector(".js-card-feed")?.getBoundingClientRect();
      const top=Math.max(0,Math.round(fields?.top ?? timeline?.top ?? 0));
      const edge=Math.round(fields?.right ?? timeline?.left ?? 0);
      panel.style.top=top+"px";
      panel.style.left=(innerWidth-edge>=510 ? Math.max(0,edge) : 0)+"px";
    }
    function show(target) {
      const settings=target==="settings";
      if (panel && panelPath===location.pathname) {
        const frame=panel.querySelector("iframe");
        if(settings)frame.contentWindow.postMessage({type:"bechat:panel:settings"},new URL(frame.src).origin);
        frame.focus();return;
      }
      leave();
      opener=document.activeElement;
      panelPath=location.pathname;
      panel=document.createElement("section");
      panel.id="bechat-panel";
      panel.setAttribute("aria-label","Переписка BeChat");
      panel.style.cssText="position:fixed;right:0;bottom:0;z-index:10000;display:grid;grid-template-columns:minmax(0,1fr) 36px;grid-template-rows:minmax(0,1fr);align-items:start;background:#0c1732;overflow:hidden;box-sizing:border-box;border-left:1px solid #65769a";
      const close=document.createElement("button");
      close.type="button"; close.title="Закрыть переписку"; close.setAttribute("aria-label",close.title); close.textContent="×";
      close.style.cssText="grid-column:2;grid-row:1;align-self:start;justify-self:end;margin-top:12px;width:32px;height:32px;border:0;border-radius:12px 0 0 12px;background:#26498c;color:white;cursor:pointer;font:24px/1 system-ui";
      close.addEventListener("click",leave);
      const content=frame(true)[0];
      if(settings){const url=new URL(content.src);url.searchParams.set("open","settings");content.src=url.href;}
      content.style.cssText+=";grid-row:1;grid-column:1;min-width:0;display:block;box-sizing:border-box";
      panel.append(content,close);
      document.body.append(panel);
      positionPanel();
      resizePanel=new ResizeObserver(positionPanel);
      const fields=document.querySelector(".js-card-fields");
      if (fields) resizePanel.observe(fields);
      window.addEventListener("resize",positionPanel);
      document.addEventListener("keydown",escapePanel);
      close.focus({preventScroll:true});
    }
    this.callbacks = {
      render: function () {
        if (/^\/(leads|contacts)\/detail\/\d+/.test(location.pathname)) {
          widgetStyles();
          self.render_template({
            caption: { class_name: "bechat-caption", html: "BeChat · BeQuick" },
            body: "",
            render:
              '<div class="bechat-actions"><button type="button" class="bechat-open">Написать сообщение</button><button type="button" class="bechat-settings" title="Настройки BeChat" aria-label="Настройки BeChat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 7h7m4 0h7M3 17h11m4 0h3"/><circle cx="12" cy="7" r="2.2"/><circle cx="16" cy="17" r="2.2"/></svg></button></div>',
          });
        }
        return true;
      },
      init: function () {
        widgetStyles();dressCaption();
        window.addEventListener("message", onIdentity);
        if (location.pathname.startsWith("/leads/detail/")) {
          observer?.disconnect();
          observer = new MutationObserver(mountFeed);
          observer.observe(document.body, { childList: true, subtree: true,attributes:true,attributeFilter:["class","data-point"] });
          mountFeed();
        }
        return true;
      },
      bind_actions: function () {
        $(document)
          .off("click" + ns, ".bechat-open")
          .on("click" + ns, ".bechat-open", ()=>show())
          .off("click"+ns,".bechat-settings").on("click"+ns,".bechat-settings",()=>show("settings"));
        return true;
      },
      settings: function () {
        return true;
      },
      onSave: function () {
        return true;
      },
      advancedSettings: function () {
        $("#list_page_holder")
          .empty()
          .append(
            $("<div>", { class: "bechat-workspace" })
              .css({ height: "calc(100vh - 80px)", minHeight: 400 })
              .append(frame(false)),
          );
        return true;
      },
      destroy: function () {
        observer?.disconnect();
        document.querySelectorAll(".bechat-contact-photos").forEach(el=>el.remove());
        resetHistory();
        feed?.remove();
        feed = null;
        window.removeEventListener("message", onIdentity);
        for(const p of delegated.values()) clearTimeout(p.timer);
        delegated.clear(); authorizedFrames.clear(); frames.clear();
        $(document).off(ns);
        leave();
        $(".bechat-workspace").remove();
        return true;
      },
    };
    return this;
  };
});
