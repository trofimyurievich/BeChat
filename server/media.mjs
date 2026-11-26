import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const stickers = new Set(JSON.parse(readFileSync(new URL("../dist/assets/animated-emoji.json",import.meta.url))).map(row=>row[0]));
const headers = {"User-Agent":"BeChat media library/1.1 (https://bechat.onbequick.ru)"};
const maximum = 8 * 1024 * 1024;
const fail = (http, message) => {throw Object.assign(new Error(message),{http});};
const cache = new Map();
const aliases = {кот:"cat",котик:"cat",кошка:"cat",собака:"dog",танец:"dance",сердце:"heart",привет:"wave",улыбка:"smile",цветы:"flowers",огонь:"fire"};

async function commons(params) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.search = new URLSearchParams({action:"query",format:"json",formatversion:"2",prop:"imageinfo",
    iiprop:"url|mime|size|extmetadata",iiurlwidth:"180",iiextmetadatafilter:"Artist|LicenseShortName",...params});
  const res = await fetch(url,{headers,redirect:"error",signal:AbortSignal.timeout(15000)});
  if (!res.ok) fail(502,"Wikimedia Commons временно недоступен");
  const value = await res.json();
  if (value.error) fail(502,"Поиск Wikimedia Commons временно недоступен");
  return value;
}

function item(page) {
  const f=page.imageinfo?.[0], license=f?.extmetadata?.LicenseShortName?.value;
  if (!f || f.mime!=="image/gif" || !f.size || f.size>maximum || f.width*f.height>4000000 ||
      !/^(?:CC (?:BY(?:-SA)? [\d.]+|Zero)|CC0(?: [\d.]+)?|Public domain)$/i.test(license||"")) return null;
  const safe = value=>{try {const u=new URL(value);return u.origin==="https://upload.wikimedia.org" && u.pathname.startsWith("/wikipedia/commons/");}catch{return false;}};
  if (!safe(f.url)) return null;
  const author=(f.extmetadata?.Artist?.value || "").replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim().slice(0,180);
  return {id:String(page.pageid),name:page.title.replace(/^File:/,""),thumb:safe(f.thumburl)?f.thumburl:f.url,
    url:f.url,attribution:[author,license,"https://commons.wikimedia.org/?curid="+page.pageid].filter(Boolean).join(" · ")};
}

export async function searchGifs(params) {
  const input=(params.get("q")||"cat").slice(0,100).trim();
  const q=aliases[input.toLowerCase()] || input;
  const offset=Math.min(9900,Math.max(0,parseInt(params.get("offset"),10)||0));
  const key=JSON.stringify([q,offset]), hit=cache.get(key);
  if (hit?.expires>Date.now()) return hit.value;
  const result=await commons({generator:"search",gsrsearch:q+" filemime:image/gif",gsrnamespace:"6",gsrlimit:"30",gsroffset:String(offset)});
  const items=(result.query?.pages||[]).sort((a,b)=>a.index-b.index).map(item).filter(Boolean);
  const value={items:items.map(({url,...publicItem})=>publicItem),next:result.continue?.gsroffset??null};
  if(cache.size>=150) cache.delete(cache.keys().next().value);
  cache.set(key,{value,expires:Date.now()+300000});
  return value;
}

export async function getAnimation(params) {
  const id=params.get("id");
  let url;
  if (params.get("type")==="sticker" && stickers.has(id)) url="https://fonts.gstatic.com/s/e/notoemoji/latest/"+id+"/512.gif";
  else if (params.get("type")==="gif" && /^[1-9]\d{0,11}$/.test(id||"")) {
    const data=await commons({pageids:id});
    url=item(data.query?.pages?.[0]||{})?.url;
  }
  if (!url) fail(404,"Анимация недоступна");
  const res=await fetch(url,{headers,redirect:"error",signal:AbortSignal.timeout(25000)});
  if (!res.ok || Number(res.headers.get("content-length"))>maximum) {await res.body?.cancel();fail(422,"Анимация недоступна или превышает 8 МБ");}
  let length=0; const chunks=[];
  for await(const chunk of res.body) {
    length+=chunk.length; if(length>maximum) fail(413,"Анимация превышает 8 МБ");
    chunks.push(chunk);
  }
  const bytes=Buffer.concat(chunks);
  if (!/^GIF8[79]a$/.test(bytes.toString("ascii",0,6))) fail(422,"Источник не предоставил GIF");
  return bytes;
}

let conversions=0;
export async function normalizeVoice(input) {
  if(input.length<12) fail(400,"Запись пустая");
  const format=input.subarray(0,4).toString()==="OggS"?"ogg":input.readUInt32BE(0)===0x1a45dfa3?"matroska":input.toString("ascii",4,8)==="ftyp"?"mov":null;
  if(!format) fail(400,"Формат записи не поддерживается");
  if(conversions>=3) fail(429,"Сервер обрабатывает записи. Повторите через несколько секунд");
  conversions++;
  try {
    const bytes=await new Promise((resolve,reject)=>{
      const child=spawn("ffmpeg",["-v","error","-nostdin","-protocol_whitelist","pipe","-f",format,"-i","pipe:0",
        "-map","0:a:0","-vn","-t","600","-ac","1","-ar","48000","-c:a","libopus","-b:a","32k","-f","ogg","pipe:1"],
        {stdio:["pipe","pipe","ignore"],timeout:30000,windowsHide:true});
      const chunks=[];
      child.stdin.on("error",()=>{});
      child.stdout.on("data",chunk=>chunks.push(chunk));
      child.on("error",reject);
      child.on("close",code=>code===0?resolve(Buffer.concat(chunks)):reject(Object.assign(new Error("Не удалось обработать запись"),{http:422})));
      child.stdin.end(input);
    });
    let offset=0, samples=0;
    while (offset+27<=bytes.length && bytes.toString("ascii",offset,offset+4)==="OggS") {
      const end=offset+27+bytes[offset+26];
      if(end>bytes.length) break;
      const granule=bytes.readBigInt64LE(offset+6); if(granule>0n) samples=Number(granule);
      offset=end+bytes.subarray(offset+27,end).reduce((a,b)=>a+b,0);
    }
    if(!samples) fail(422,"Запись пустая");
    return {bytes,duration:Math.round(samples/48)};
  } finally {conversions--;}
}

let transcribing=false;
const transcripts=new Map();
export async function voiceText(file, load) {
  if (transcripts.has(file)) return transcripts.get(file);
  if (transcribing) fail(429,"Распознаётся другая запись. Попробуйте через несколько секунд");
  transcribing=true;
  try {
    const bytes=await load();
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.env.BECHAT_PYTHON||"python3",["-m","personal.speech"],{
        stdio:["pipe","pipe","ignore"],timeout:120000,windowsHide:true,
        env:{...process.env,OPENBLAS_NUM_THREADS:"1",OMP_NUM_THREADS:"1"}});
      const parts=[];
      child.stdin.on("error",()=>{});
      child.on("error",reject);
      child.stdout.on("data",part=>parts.push(part));
      child.once("close",code=>{
        if(code!==0)return reject(Object.assign(Error("Не удалось распознать запись"),{http:422}));
        try{resolve(JSON.parse(Buffer.concat(parts).toString()));}catch(e){reject(e);}
      });
      child.stdin.end(bytes);
    });
    if(transcripts.size>=150)transcripts.delete(transcripts.keys().next().value);
    transcripts.set(file,result);
    return result;
  }finally{transcribing=false;}
}
