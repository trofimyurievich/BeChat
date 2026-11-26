(() => {
  "use strict";
  const list=document.getElementById("chatlist"), wrap=list.parentElement;
  const track=wrap.querySelector(".chat-scroll"), thumb=track.firstElementChild;
  let height=0, range=0, travel=0, dragging=null, hideTimer=0, scheduled=0;
  function sync() {
    scheduled=0;
    range=list.scrollHeight-list.clientHeight;
    track.hidden=range<=0 || !list.clientHeight;
    if (track.hidden) return;
    height=Math.min(track.clientHeight,Math.max(24,track.clientHeight*list.clientHeight/list.scrollHeight));
    travel=track.clientHeight-height;
    thumb.style.height=height+"px";
    thumb.style.transform="translateY("+(range ? travel*list.scrollTop/range : 0)+"px)";
  }
  function schedule() {if(!scheduled) scheduled=requestAnimationFrame(sync);}
  list.addEventListener("scroll",()=>{
    schedule(); wrap.classList.add("scrolling"); clearTimeout(hideTimer);
    hideTimer=setTimeout(()=>wrap.classList.remove("scrolling"),650);
  },{passive:true});
  function move(y) {
    if(travel>0) list.scrollTop=Math.min(1,Math.max(0,(y-track.getBoundingClientRect().top-dragging.offset)/travel))*range;
  }
  track.addEventListener("pointerdown",e=>{
    if(e.button!==0 || dragging) return;
    sync();
    const y=e.clientY-thumb.getBoundingClientRect().top;
    dragging={id:e.pointerId,offset:y>=0 && y<=height ? y : height/2};
    track.setPointerCapture(e.pointerId);wrap.classList.add("dragging");
    move(e.clientY);e.preventDefault();
  });
  track.addEventListener("pointermove",e=>{if(dragging?.id===e.pointerId) move(e.clientY);});
  track.addEventListener("lostpointercapture",()=>{dragging=null;wrap.classList.remove("dragging");});
  track.addEventListener("pointerup",e=>{if(track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);});
  new ResizeObserver(schedule).observe(list);
  new MutationObserver(schedule).observe(list,{childList:true});
  schedule();
})();
