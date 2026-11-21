import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function classify(value){
 const u=new URL(value); if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('URL HTTPS tidak valid');
 const h=u.hostname.toLowerCase().replace(/^www\./,'');let p;
 if(h==='instagram.com'&&/^\/(p|reel|reels)\/[^/]+/.test(u.pathname))p='Instagram';
 if((h==='tiktok.com'||h.endsWith('.tiktok.com'))&&(/\/video\/\d+/.test(u.pathname)||['vt.tiktok.com','vm.tiktok.com'].includes(h)))p='TikTok';
 if(['facebook.com','m.facebook.com','fb.watch'].includes(h)&&(/\/posts\/|\/videos\/|\/reel\/|story_fbid=|\/share\//.test(u.href)||h==='fb.watch'||u.pathname==='/watch/'))p='Facebook';
 if(['x.com','twitter.com','mobile.twitter.com'].includes(h)&&/\/status\/\d+/.test(u.pathname))p='X';
 if(!p)throw Error('Masukkan URL unggahan publik, bukan profil atau domain lain');
 u.hash=''; if(p!=='Facebook')u.search='';return {url:u.href,platform:p};
}
export function number(...vals){for(const v of vals){if(v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0)return Number(v)}return null}
export function normalize(x,p,url){
 const text=x.caption??x.text??x.fullText??'';
 return {url:x.webVideoUrl??x.url??x.postUrl??url,platform:p,caption:typeof text==='string'?text:'',account:x.ownerUsername??x.authorMeta?.name??x.user?.name??x.user?.username??'',v:number(x.videoViewCount,x.videoPlayCount,x.playCount,x.viewsCount,x.views),l:number(x.likesCount,x.diggCount,x.likes,x.reactionsCount),c:number(x.commentsCount,x.commentCount,x.comments),s:number(x.shareCount,x.sharesCount,x.shares),published:x.timestamp??x.createTimeISO??x.time??null,source:'Apify',time:new Date().toISOString()};
}
const jobs=new Map();let count=0,windowStart=Date.now();
const env=process.env;
const actors={'Instagram':'apify~instagram-scraper','TikTok':'clockworks~tiktok-scraper','Facebook':'apify~facebook-posts-scraper'};
function inputFor(p,url){return p==='Instagram'?{directUrls:[url],resultsType:'posts',resultsLimit:1}:p==='TikTok'?{postURLs:[url],resultsPerPage:1,scrapeRelatedVideos:false,shouldDownloadVideos:false,shouldDownloadCovers:false,shouldDownloadSlideshowImages:false,shouldDownloadAvatars:false,downloadSubtitlesOptions:'NEVER_DOWNLOAD_SUBTITLES'}:{startUrls:[{url}],resultsLimit:1,captionText:false}}
async function api(path,method='GET',body){const r=await fetch('https://api.apify.com/v2/'+path,{method,headers:{Authorization:'Bearer '+env.APIFY_TOKEN,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('Apify HTTP '+r.status+'; periksa token, kredit atau izin Actor di Console');return r.json()}
async function collect(id,p,url){const job=jobs.get(id);try{
 job.status='Mengambil data';
 const run=(await api('acts/'+actors[p]+'/runs?timeout=180&maxTotalChargeUsd=0.05','POST',inputFor(p,url))).data;
 job.run=run.id;
 let terminal=false;
 for(let i=0;i<65;i++){
  await new Promise(r=>setTimeout(r,4000));const r=(await api('actor-runs/'+run.id)).data;
  if(r.status==='SUCCEEDED'){
   const data=await api('datasets/'+r.defaultDatasetId+'/items?clean=true&limit=2');
   const x=data.find(x=>!x.error&&!x.errorDescription);
   if(!x)throw Error('Sumber tidak memberikan data unggahan. Periksa hasil run di Apify.');
   job.result=normalize(x,p,url);job.status='Selesai';terminal=true;break;
  }
  if(['FAILED','ABORTED','TIMED-OUT'].includes(r.status))throw Error('Pengambilan '+r.status+'; periksa run di Apify Console');
 }
 if(!terminal){try{await api('actor-runs/'+run.id+'/abort','POST')}catch{}throw Error('Batas tunggu habis; status run perlu diperiksa di Console')}
 }catch(e){job.status='Gagal';job.error=e.message}finally{job.finished=Date.now()}}
const server=http.createServer(async(req,res)=>{
 const origin=req.headers.origin;
 const own='http://'+req.headers.host;
 const allowed=(env.ALLOWED_ORIGIN||'').split(',').filter(Boolean);
 if(origin&&origin!==own&&!allowed.includes(origin)){res.writeHead(403);res.end('Origin ditolak');return}
 if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin')}
 res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Access-Key');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
 const path=new URL(req.url,'http://localhost').pathname;
 const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data))};
 try{
 if(path.startsWith('/api/')){
 const a=Buffer.from(req.headers['x-access-key']||''),b=Buffer.from(env.ACCESS_KEY||'');
 if(!b.length||a.length!==b.length||!timingSafeEqual(a,b)){json({error:'Kunci akses backend belum benar'},401);return}
 if(path==='/api/health'){json({configured:!!env.APIFY_TOKEN,platforms:Object.keys(actors)});return}
 if(path==='/api/start'&&req.method==='POST'){
  if(!env.APIFY_TOKEN){json({error:'APIFY_TOKEN belum dipasang di backend'},503);return}
  if(jobs.size>500){for(const [k,v]of jobs)if(v.finished&&Date.now()-v.finished>3600000)jobs.delete(k)}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>4000){json({error:'Input terlalu besar'},413);return}}
  const {url,platform}=classify(JSON.parse(body).url);
  if(!actors[platform]){json({error:'X belum diaktifkan dalam paket ini; gunakan impor JSON untuk data X'},422);return}
  if(Date.now()-windowStart>3600000){count=0;windowStart=Date.now()}
  if(count>=Number(env.MAX_URLS_PER_HOUR||30)){json({error:'Batas pengambilan per jam tercapai untuk menjaga kredit gratis'},429);return}
  if([...jobs.values()].filter(j=>!j.finished).length>=2){json({error:'Dua pengambilan masih berjalan; coba lagi setelah selesai'},429);return}
  count++;const id=randomUUID();jobs.set(id,{status:'Menunggu',created:Date.now()});collect(id,platform,url);json({id},202);return;
 }
 if(path.startsWith('/api/job/')){const j=jobs.get(path.split('/').pop());json(j||{error:'Pekerjaan tidak ditemukan'},j?200:404);return}
 json({error:'Endpoint tidak ditemukan'},404);return;
 }
 if(path==='/'||path==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(await readFile(new URL('./index.html',import.meta.url)));return}
 res.writeHead(404);res.end('Tidak ditemukan');
 }catch(e){json({error:e.message},400)}
});
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])server.listen(Number(env.PORT||8787),'0.0.0.0',()=>console.log('SIG aktif pada port '+(env.PORT||8787)));
