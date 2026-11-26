"use strict";
const BeChatMedia = (() => {
  let rec=null, panel=null, pickerChat="", sendingMedia=false, catalogue;
  const elapsed=ms=>Math.floor(ms/60000)+":"+String(Math.floor(ms/1000)%60).padStart(2,"0");
  function closePicker() {panel?.remove();panel=null;pickerChat="";document.querySelector("#dialog")?.classList.remove("media-docked");}
  function stopTracks(r) {r.stream?.getTracks().forEach(t=>t.stop());clearInterval(r.timer);}
  function discard() {
    const r=rec;
    if(!r) return;
    rec=null;
    if(r.recorder && r.recorder.state!=="inactive") r.recorder.stop();
    stopTracks(r); r.bar.remove(); if(r.url) URL.revokeObjectURL(r.url);
    $("#composer")?.classList.remove("recording");
  }
  function cancel() {discard();closePicker();}
  function allowed() {return !!c() && editable() && !note && c().channel!=="SMS";}
  function sync() {
    const sendButton=$('#composer [data-act="send"]'), mic=$("#composer .voice-mic");
    if(!sendButton || !mic) return;
    const voice=allowed() && !attachment && !($("#draft")?.value||"").trim();
    mic.hidden=!voice;sendButton.hidden=voice;
  }
  async function deliver(message) {
    if(sendingMedia || sending || !allowed() || active!==message.chat) throw Error("Сначала вернитесь в выбранный диалог");
    sendingMedia=true;
    try {
      if (!message.upload) {
        const res=await fetch("/api/files",{method:"POST",headers:{Authorization:"Bearer "+token,
          "Content-Type":"application/octet-stream","X-Filename":encodeURIComponent(message.name),"X-BeChat-Media":message.kind},body:message.blob});
        const value=await res.json();
        if(!res.ok) throw Error(value.error||"Не удалось загрузить вложение");
        message.upload={...value,kind:message.kind==="voice"?"audio":message.kind};
      }
      await api("chats/"+encodeURIComponent(message.chat)+"/messages","POST",{id:message.id,file:message.upload,text:message.caption||"",quote:message.quote||""});
      if(active===message.chat && reply===message.quote) reply=null;
    } finally {sendingMedia=false;}
  }
  async function submitRecording(r) {
    if(r!==rec || !r.message || sendingMedia) return;
    try {
      await deliver(r.message);discard();await refresh();render(active===r.chat);
    } catch(e) {if(rec===r) renderBar(r);toast(e.message);}
  }
  function renderBar(r) {
    r.bar.replaceChildren();
    const time=document.createElement("time"), label=document.createElement("span");
    time.textContent=elapsed(r.started ? (r.ended||Date.now())-r.started : 0);
    label.className="voice-hint";r.bar.append(time,label);
    label.textContent=r.message?"Голосовое":!r.started?"Разрешите доступ к микрофону":r.locked?"Запись закреплена":"← Отмена · ↑ Закрепить";
    if(r.message) {
      const audio=document.createElement("audio");
      audio.controls=true; audio.src=r.url;audio.setAttribute("aria-label","Прослушать запись");
      label.replaceWith(audio);
    }
    function button(title,iconName,action) {
      const el=document.createElement("button");
      el.className="icon";el.type="button";el.title=title;el.setAttribute("aria-label",title);el.innerHTML=icon(iconName);
      el.onclick=action;r.bar.append(el);
    }
    button("Отменить запись","trash",discard);
    if(r.locked && r.started && !r.ended) button("Остановить и прослушать","select",()=>finish(r,false));
    if(r.message || (r.locked && r.started && !r.ended)) button("Отправить голосовое","send",()=>r.message?submitRecording(r):finish(r,true));
  }
  function finish(r,sendNow) {
    if(r!==rec || !r.recorder || r.recorder.state!=="recording") return;
    r.sendNow=sendNow;r.ended=Date.now();r.recorder.stop();stopTracks(r);
  }
  async function start(button,event) {
    if(rec || sending || sendingMedia || !allowed()) return;
    if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {toast("Запись с микрофона недоступна в этом браузере");return;}
    closePicker();
    const r=rec={chat:active,quote:reply,bar:document.createElement("div"),locked:!event,x:event?.clientX,y:event?.clientY,pointer:event?.pointerId};
    r.bar.className="voice-strip";button.parentElement.append(r.bar);$("#composer").classList.add("recording");renderBar(r);
    if(event) button.setPointerCapture(event.pointerId);
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(rec!==r || active!==r.chat || !allowed()){stream.getTracks().forEach(t=>t.stop());return;}
      r.stream=stream;
      const type=["audio/webm;codecs=opus","audio/ogg;codecs=opus","audio/mp4"].find(t=>MediaRecorder.isTypeSupported(t));
      const recorder=r.recorder=new MediaRecorder(stream,{...(type?{mimeType:type}:{}),audioBitsPerSecond:32000});
      const chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      recorder.onerror=()=>{if(rec===r){discard();toast("Не удалось записать звук");}};
      recorder.onstop=()=>{
        stopTracks(r);
        if(rec!==r) return;
        if(active!==r.chat || !allowed()){discard();return;}
        const blob=new Blob(chunks,{type:recorder.mimeType});
        if(!blob.size || r.ended-r.started<250){discard();toast("Слишком короткая запись");return;}
        r.message={id:sid(),chat:r.chat,quote:r.quote,kind:"voice",name:"Голосовое сообщение",blob};
        r.url=URL.createObjectURL(blob);renderBar(r);
        if(r.sendNow) submitRecording(r);
      };
      recorder.start(250);r.started=Date.now();renderBar(r);
      r.timer=setInterval(()=>{if(rec!==r)return; r.bar.querySelector("time").textContent=elapsed(Date.now()-r.started);
        if(Date.now()-r.started>=599000) finish(r,false);},250);
    } catch(e) {if(rec===r){discard();toast(e.name==="NotAllowedError"?"Разрешите микрофон для BeChat в настройках браузера":"Микрофон недоступен");}}
  }
  function mount() {
    if(!allowed()) return;
    const box=$("#composer .composebox"), mic=document.createElement("button");
    mic.type="button";mic.className="icon send voice-mic";mic.innerHTML=icon("mic");
    mic.title="Удерживайте для записи. Нажмите для записи без удержания";
    mic.setAttribute("aria-label","Записать голосовое сообщение");
    mic.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();start(mic,e);};
    mic.onpointermove=e=>{
      const r=rec;if(!r || r.pointer!==e.pointerId || r.locked)return;
      if(r.x-e.clientX>65) discard();
      else if(r.y-e.clientY>50){r.locked=true;renderBar(r);}
    };
    mic.onpointerup=e=>{
      const r=rec;if(!r || r.pointer!==e.pointerId || r.locked)return;
      if(!r.started || Date.now()-r.started<300){r.locked=true;renderBar(r);}
      else finish(r,true);
    };
    mic.onpointercancel=()=>{if(rec && !rec.locked)discard();};
    mic.onclick=e=>{if(e.detail===0 && !rec)start(mic);};
    box.append(mic);sync();
  }
  const emojis=["🙂","👍","✨","🤝","💙","📎","🚀","🎉","👌","💬","✅","📅"];
  async function picker() {
    if(panel){closePicker();return;} if(rec || !allowed())return;
    const host=panel=document.createElement("section"), chat=pickerChat=active;
    host.className="animation-picker";host.setAttribute("aria-label","Эмодзи, GIF и стикеры");
    host.innerHTML='<header><button data-type="emoji">Эмодзи</button><button data-type="sticker">Стикеры</button><button data-type="gif">GIF</button><button class="icon dismiss" aria-label="Закрыть">×</button></header><input type="search" placeholder="Поиск GIF" aria-label="Поиск в библиотеке" maxlength="100"><div class="animation-grid"></div><footer><span role="status"></span><button class="next" hidden>Ещё</button></footer>';
    const target=$("#dialog");
    if(target.clientWidth>=660) {target.classList.add("media-docked");target.append(host);} else $("#composer .composewrap").append(host);
    const input=host.querySelector("input"), grid=host.querySelector(".animation-grid"), status=host.querySelector('[role="status"]'), more=host.querySelector(".next");
    let type="gif", generation=0, next=null, timer=0, picking=false, pending=null;
    async function choose(item,button) {
      if(picking || chat!==active)return;
      if(type==="emoji") {
        const draft=$("#draft");draft.setRangeText(item.name,draft.selectionStart,draft.selectionEnd,"end");
        draft.dispatchEvent(new Event("input",{bubbles:true}));closePicker();draft.focus();return;
      }
      picking=true;button.disabled=true;status.textContent="Отправляем…";
      try {
        const key=type+":"+item.id;
        if(pending?.key!==key) {
          const res=await fetch("/api/library/file?"+new URLSearchParams({type,id:item.id}),{headers:{Authorization:"Bearer "+token}});
          if(!res.ok)throw Error("Не удалось загрузить анимацию");
          pending={key,id:sid(),chat,quote:reply,kind:type,blob:await res.blob(),name:item.name.replace(/\.gif$/i,"")+".gif",caption:item.attribution||""};
        }
        if(host!==panel || chat!==active || !allowed()) return;
        await deliver(pending);closePicker();await refresh();render(active===chat);
      } catch(e){status.textContent=e.message;button.disabled=false;}finally{picking=false;}
    }
    async function list(append=false) {
      const gen=++generation, q=input.value.trim().toLocaleLowerCase(), offset=append?next:0;
      if(!append)grid.replaceChildren();
      more.hidden=true;status.textContent="Загружаем…";
      try {
        let result,credit;
        if(type==="gif"){result=await api("library?"+new URLSearchParams({q,offset}));credit="Wikimedia Commons";}
        else if(type==="sticker"){
          catalogue ||= fetch("/assets/animated-emoji.json").then(r=>{if(!r.ok)throw Error();return r.json();}).catch(e=>{catalogue=null;throw e;});
          const all=(await catalogue).filter(row=>row.slice(1).join(" ").toLocaleLowerCase().includes(q));
          result={items:all.slice(offset,offset+36).map(([id,glyph,name])=>({id,name,glyph,thumb:"https://fonts.gstatic.com/s/e/notoemoji/latest/"+id+"/512.webp"})),next:offset+36<all.length?offset+36:null};
          credit="Google Noto Emoji · CC BY 4.0";
        }else{result={items:emojis.map(name=>({name})),next:null};credit="";}
        if(gen!==generation || panel!==host)return;
        for(const item of result.items){
          const b=document.createElement("button");b.type="button";b.title=item.name;b.setAttribute("aria-label",item.name);
          b.textContent=item.glyph||item.name;
          if(item.thumb){const img=new Image();img.loading="lazy";img.alt=item.name;img.referrerPolicy="no-referrer";img.src=item.thumb;b.replaceChildren(img);img.onerror=()=>{b.textContent=item.glyph||item.name;};}
          b.onclick=()=>choose(item,b);grid.append(b);
        }
        next=result.next;more.hidden=next==null;
        status.textContent=grid.childElementCount?credit:"Ничего не найдено";
      }catch{if(gen===generation && host===panel){status.textContent="Библиотека недоступна";more.hidden=false;next=offset;}}
    }
    function select(value){type=value;input.value="";input.hidden=type==="emoji";input.placeholder=type==="gif"?"Поиск GIF":"Поиск стикеров";
      for(const b of host.querySelectorAll("[data-type]"))b.setAttribute("aria-pressed",String(b.dataset.type===type));list();if(!input.hidden)input.focus();}
    host.querySelector(".dismiss").onclick=closePicker;
    for(const b of host.querySelectorAll("[data-type]"))b.onclick=()=>select(b.dataset.type);
    input.oninput=()=>{generation++;clearTimeout(timer);timer=setTimeout(()=>list(),220);};
    more.onclick=()=>list(true);select("gif");
  }
  document.addEventListener("pointerdown",e=>{if(panel&&!panel.contains(e.target)&&!e.target.closest('[data-act="emoji"]'))closePicker();});
  document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(rec)discard();if(panel)closePicker();}});
  window.addEventListener("pagehide",cancel);
  document.addEventListener("visibilitychange",()=>{if(document.hidden && rec && !rec.ended)discard();});
  return {mount,sync,cancel,picker,preserve:(id,isNote)=>!isNote&&((rec && rec.chat===id)||(panel && pickerChat===id))};
})();
