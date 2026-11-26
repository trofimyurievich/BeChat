"use strict";
const BeChatVoice = (() => {
  const play='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.8a1.5 1.5 0 0 1 2.3-1.2l12 7.2a1.4 1.4 0 0 1 0 2.4l-12 7.2A1.5 1.5 0 0 1 7 19.2Z"/></svg>';
  const pause='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></svg>';
  const clock=s=>Number.isFinite(s)?Math.floor(s/60).toString().padStart(2,"0")+":"+Math.floor(s%60).toString().padStart(2,"0"):"—:—";
  const fmtSize=n=>n>0?new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(n/1024)+" КБ":"";
  const isVoice=f=>f.kind==="audio" || ((f.kind==="file"||!f.kind) && /^(?:голосовое|voice(?:[\s_.-]|$))/i.test(f.name||"") && /\.(ogg|oga|opus|m4a|webm)$/i.test(f.name));
  const blobs=new Map(), waves=new Map(), texts=new Map(), visible=new Set(), loads=new Map();
  let audio=null, playingId="", owner="", generation=0, analysing=0, listened=new Set();
  const cardNodes=id=>[...document.querySelectorAll(".voice-player")].filter(el=>el.dataset.voice===id);
  const fileFor=id=>c()?.messages.flatMap(messageFiles).find(f=>f.id===id);
  function markup(f,incoming) {
    const progress='<svg viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true"><path/></svg>';
    return '<div class="voice-player" data-voice="'+esc(f.id)+'" data-incoming="'+Boolean(incoming)+'">'+
      '<button type="button" class="voice-play" aria-label="Воспроизвести голосовое">'+play+'</button>'+
      '<div class="voice-track"><div class="voice-wave">'+progress+progress+'<input type="range" min="0" max="1000" step="1" value="0" aria-label="Перемотать голосовое"></div>'+
      '<small><time>'+clock(f.duration>0?f.duration/1000:NaN)+'</time><span class="voice-size">'+(f.size?' · '+esc(fmtSize(f.size)):'')+'</span><i hidden title="Ещё не прослушано на этом устройстве"></i></small></div>'+
      '<button type="button" class="voice-text" title="Расшифровать на русском" aria-label="Расшифровать голосовое на русском" aria-expanded="false">→А</button>'+
      '<div class="voice-caption" aria-live="polite" hidden></div></div>';
  }
  function paint(el) {
    const id=el.dataset.voice, wave=waves.get(id), current=playingId===id && audio;
    const duration=current&&Number.isFinite(audio.duration)?audio.duration:wave?.seconds;
    const t=current?audio.currentTime:0, ratio=t>0&&duration?Math.min(t/duration,1):0;
    const playing=Boolean(current && !audio.paused);
    const button=el.querySelector(".voice-play");
    if(button.dataset.playing!==String(playing)){
      button.dataset.playing=String(playing);button.innerHTML=playing?pause:play;
      button.setAttribute("aria-label",playing?"Приостановить голосовое":"Воспроизвести голосовое");
    }
    const range=el.querySelector("input");
    range.value=String(Math.round(1000*ratio));
    range.setAttribute("aria-valuetext",clock(t)+(duration?" из "+clock(duration):""));
    el.style.setProperty("--voice-progress",(100*ratio)+"%");
    if(wave?.path && el.dataset.shape!=="ready"){
      for(const path of el.querySelectorAll(".voice-wave path"))path.setAttribute("d",wave.path);
      el.dataset.shape="ready";
    }
    if(duration || t)el.querySelector("time").textContent=clock(t>0?t:duration);
    if(wave?.size)el.querySelector(".voice-size").textContent=" · "+fmtSize(wave.size);
    el.querySelector("i").hidden=el.dataset.incoming!=="true" || listened.has(id);
    const caption=el.querySelector(".voice-caption"), text=texts.get(id);
    caption.hidden=!text?.open;
    caption.textContent=text?.open?text.value:"";
    el.querySelector(".voice-text").setAttribute("aria-expanded",String(!caption.hidden));
  }
  function update(id){for(const el of cardNodes(id))paint(el);}
  function remember(id) {
    if(listened.has(id))return;
    listened.add(id);
    if(listened.size>500)listened.delete(listened.values().next().value);
    try{localStorage.setItem("bechat-listened:"+owner,JSON.stringify([...listened]));}catch{}
  }
  function stop() {
    if(!audio)return;
    const old=playingId, player=audio;
    playingId="";audio=null;player.pause();
    const url=player.src;
    player.removeAttribute("src");player.load();
    if(url.startsWith("blob:"))URL.revokeObjectURL(url);
    update(old);
  }
  function clear() {
    ++generation;stop();observer.disconnect();visible.clear();loads.clear();blobs.clear();waves.clear();texts.clear();owner="";listened.clear();
  }
  function makePath(pcm){
    const samples=pcm.getChannelData(0), values=[], bars=64;
    for(let i=0;i<bars;i++){
      const start=Math.floor(i*samples.length/bars), end=Math.floor((i+1)*samples.length/bars);
      let total=0,n=0;
      for(let j=start;j<end;j+=Math.max(1,Math.floor((end-start)/700))){total+=samples[j]*samples[j];n++;}
      values.push(Math.sqrt(total/(n||1)));
    }
    const peak=Math.max(0.001,...values);
    return values.map((v,i)=>{const h=Math.max(1,Math.round(Math.pow(v/peak,0.75)*13));return "M"+(1+i*3.13).toFixed(2)+" "+(15-h)+"v"+(2*h);}).join("");
  }
  async function analyse(id,epoch) {
    const file=fileFor(id);
    if(!file || (file.size||0)>8*1024*1024){waves.set(id,{});return;}
    const initial={seconds:file.duration?file.duration/1000:undefined,size:file.size};
    waves.set(id,initial);
    const blob=await attachmentBlob(file);
    if(epoch!==generation || blob.size>8*1024*1024)return;
    blobs.set(id,Promise.resolve(blob));
    if(blobs.size>4)blobs.delete(blobs.keys().next().value);
    const Ctx=window.OfflineAudioContext||window.webkitOfflineAudioContext;
    if(!Ctx)return;
    const decoder=new Ctx(1,1,16000);
    const pcm=await decoder.decodeAudioData(await blob.arrayBuffer());
    if(epoch!==generation)return;
    waves.set(id,{seconds:pcm.duration,size:blob.size,path:makePath(pcm)});
    if(waves.size>300)waves.delete(waves.keys().next().value);
    update(id);
  }
  function drain() {
    for(const el of visible){
      if(analysing>=2)break;
      const id=el.dataset.voice;
      if(!el.isConnected){visible.delete(el);continue;}
      if(waves.has(id)||loads.has(id))continue;
      analysing++;
      const epoch=generation;
      const p=analyse(id,epoch).catch(()=>{}).finally(()=>{analysing--;if(loads.get(id)===p)loads.delete(id);drain();});
      loads.set(id,p);
    }
  }
  const observer=new IntersectionObserver(entries=>{
    for(const item of entries){if(item.isIntersecting)visible.add(item.target);else visible.delete(item.target);}
    drain();
  });
  function mount() {
    if(owner!==profile.crmUserId){
      clear();owner=profile.crmUserId;
      try{listened=new Set(JSON.parse(localStorage.getItem("bechat-listened:"+owner)||"[]"));}catch{}
    }
    observer.disconnect();visible.clear();
    if(playingId && !fileFor(playingId))stop();
    for(const el of document.querySelectorAll(".voice-player")){paint(el);observer.observe(el);}
  }
  async function playerFor(id) {
    if(playingId===id && audio)return audio;
    const file=fileFor(id);
    if(!file?.download)throw Error("Откройте запись ещё раз");
    const epoch=generation, chat=active;
    let source=blobs.get(id);
    if(!source){
      source=attachmentBlob(file).catch(error=>{blobs.delete(id);throw error;});
      blobs.set(id,source);
      if(blobs.size>4)blobs.delete(blobs.keys().next().value);
    }
    const blob=await source;
    if(epoch!==generation || chat!==active)return null;
    if(playingId===id && audio)return audio;
    stop();
    const player=new Audio(URL.createObjectURL(blob));
    audio=player;playingId=id;
    player.preload="auto";
    for(const name of ["loadedmetadata","timeupdate","play","pause","ended","durationchange"])player.addEventListener(name,()=>{
      if(audio!==player)return;
      if(name==="timeupdate" && player.currentTime>0.2)remember(id);
      if(name==="ended")remember(id);
      update(id);
    });
    player.addEventListener("error",()=>{if(audio===player){stop();toast("Не удалось воспроизвести голосовое");}});
    return player;
  }
  document.addEventListener("click",e=>{
    const el=e.target.closest(".voice-player"),button=e.target.closest("button");
    if(!el||!button)return;
    const id=el.dataset.voice;
    if(button.matches(".voice-play")){
      guarded(async()=>{const player=await playerFor(id);if(!player)return;if(player.paused)await player.play();else player.pause();});
    }else if(button.matches(".voice-text")){
      const entry=texts.get(id);
      if(entry){entry.open=!entry.open;update(id);return;}
      const epoch=generation;
      texts.set(id,{open:true,value:"Распознаём запись…"});update(id);
      api("voice-text/"+encodeURIComponent(id),"POST",{}).then(r=>{
        if(epoch===generation)texts.get(id).value=r.text||"Речь не распознана";
      }).catch(e=>{if(epoch===generation){texts.delete(id);toast(e.message);}})
        .finally(()=>{if(epoch===generation){update(id);}});
    }
  });
  document.addEventListener("input",e=>{
    if(!e.target.matches(".voice-wave input"))return;
    const el=e.target.closest(".voice-player"), id=el.dataset.voice, ratio=Number(e.target.value)/1000;
    guarded(async()=>{
      const player=await playerFor(id);
      if(!player)return;
      player.seekTo=ratio;
      const seek=()=>{if(Number.isFinite(player.duration)){player.currentTime=player.seekTo*player.duration;update(id);}};
      if(player.readyState)seek();else player.addEventListener("loadedmetadata",seek,{once:true});
    });
  });
  window.addEventListener("pagehide",stop);
  return {markup,isVoice,mount,clear,stop};
})();
