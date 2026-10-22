/* ============================================================
   Cronograma Delegado — camada Google Drive
   Login Google, progresso em progresso.json, índice dos PDFs
   (indice.json), banco de teoria e questões (banco.json),
   leitor de PDF embutido, caderno de erros com repetição
   espaçada e ajuste automático do cronograma pelo desempenho.
   ============================================================ */
const GCID="1088575444167-6144t0qla665kk6askqpl8fg8qv59463.apps.googleusercontent.com";
const GSCOPE="https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
const GAPI="https://www.googleapis.com/drive/v3/files", GUP="https://www.googleapis.com/upload/drive/v3/files";
const DB_NAME="Delegado-DB", PROG_NAME="progresso.json", IDX_NAME="indice.json", BANCO_NAME="banco.json", APPTAG="cronograma-delegado";
let GTOK="",GEXP=0,GTC=null,GST="",GBUSY=false,GERR="";
let DRV={root:"",prog:"",files:null};
let INDICE={pdfs:{},topicos:{},filtros:{}};

function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
function lsSet(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function lsDel(k){try{localStorage.removeItem(k)}catch(e){}}
function hhmm(){return new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}

/* ---------- login ---------- */
function gReady(){return !!(window.google&&google.accounts&&google.accounts.oauth2)}
function gOn(){return !!GTOK&&Date.now()<GEXP-60000}
function gToken(){
  return new Promise((res,rej)=>{
    if(gOn())return res(GTOK);
    if(!gReady())return rej(new Error("o login do Google ainda não carregou; confira a internet e tente de novo"));
    if(!GTC)GTC=google.accounts.oauth2.initTokenClient({client_id:GCID,scope:GSCOPE,callback:()=>{}});
    GTC.callback=r=>{
      if(r.error)return rej(new Error(r.error_description||r.error));
      if(!google.accounts.oauth2.hasGrantedAllScopes(r,"https://www.googleapis.com/auth/drive.readonly","https://www.googleapis.com/auth/drive.file"))
        return rej(new Error("marque as duas permissões do Drive na tela do Google"));
      GTOK=r.access_token;GEXP=Date.now()+(r.expires_in||3600)*1000;lsSet("deleg-google","1");res(GTOK)};
    GTC.error_callback=e=>rej(new Error(e&&e.type==="popup_closed"?"login cancelado":"o navegador bloqueou a janela de login do Google"));
    GTC.requestAccessToken({prompt:lsGet("deleg-google")?"":"consent"});
  });
}
async function gfetch(url,opt){
  const t=await gToken();opt=opt||{};opt.headers=Object.assign({Authorization:"Bearer "+t},opt.headers||{});
  const r=await fetch(url,opt);
  if(r.status===401){GTOK="";throw new Error("a sessão do Google expirou; clique em Conectar")}
  if(!r.ok){let m="";try{m=(await r.json()).error.message}catch(e){}throw new Error("Drive "+r.status+(m?" · "+m:""))}
  return r;
}
async function gList(q,fields){
  let out=[],pt="";
  do{const u=GAPI+"?q="+encodeURIComponent(q)+"&fields="+encodeURIComponent("nextPageToken,files("+(fields||"id,name,mimeType,modifiedTime,size")+")")+"&pageSize=1000&spaces=drive"+(pt?"&pageToken="+pt:"");
    const j=await(await gfetch(u)).json();out=out.concat(j.files||[]);pt=j.nextPageToken}while(pt);
  return out;
}
async function gFolder(){
  if(DRV.root)return DRV.root;
  const f=await gList("name='"+DB_NAME+"' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  if(!f.length)throw new Error("não encontrei a pasta "+DB_NAME+" no seu Drive");
  DRV.root=f[0].id;return DRV.root;
}
async function gTree(){
  const root=await gFolder(),map={};
  const walk=async(id,pre)=>{const it=await gList("'"+id+"' in parents and trashed=false");
    for(const f of it){if(f.mimeType==="application/vnd.google-apps.folder")await walk(f.id,pre+f.name+"/");else map[pre+f.name]={id:f.id,mt:f.modifiedTime,sz:+f.size||0}}};
  await walk(root,"");DRV.files=map;return map;
}
async function gFileIn(name){
  const root=await gFolder();
  const f=await gList("name='"+name+"' and '"+root+"' in parents and trashed=false");
  return f.length?f[0]:null;
}
async function gUpload(id,meta,obj){
  const b="deleg"+Date.now().toString(36);
  const body="--"+b+"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"+JSON.stringify(meta||{})+"\r\n--"+b+"\r\nContent-Type: application/json\r\n\r\n"+JSON.stringify(obj)+"\r\n--"+b+"--";
  const r=await gfetch(GUP+(id?"/"+id:"")+"?uploadType=multipart&fields=id",{method:id?"PATCH":"POST",headers:{"Content-Type":"multipart/related; boundary="+b},body:body});
  return(await r.json()).id;
}

/* ---------- índice e banco ---------- */
function applyIndice(j){if(j&&j.pdfs){INDICE={pdfs:j.pdfs||{},topicos:j.topicos||{},filtros:j.filtros||{},niveis:j.niveis||{},gerado:j.gerado||""}}}
function applyBanco(j){
  if(!j)return;
  if(j.TEORIA)Object.assign(window.TEORIA,j.TEORIA);
  if(Array.isArray(j.QUESTOES)){const ids={};j.QUESTOES.forEach(q=>ids[q.id]=1);
    window.QUESTOES=window.QUESTOES.filter(q=>!ids[q.id]).concat(j.QUESTOES)}
}
async function gLoadJson(name,apply,cacheKey){
  const f=await gFileIn(name);if(!f)return false;
  const txt=await(await gfetch(GAPI+"/"+f.id+"?alt=media")).text();
  apply(JSON.parse(txt));lsSet(cacheKey,txt);return true;
}
function bootCache(){
  try{const a=lsGet("deleg-indice");if(a)applyIndice(JSON.parse(a))}catch(e){}
  try{const b=lsGet("deleg-banco");if(b)applyBanco(JSON.parse(b))}catch(e){}
}

/* ---------- progresso ---------- */
let GAGAIN=false;
async function gSync(){
  if(!gOn())return;
  if(GBUSY){GAGAIN=true;return}
  GBUSY=true;GAGAIN=false;GST="sincronizando…";
  try{
    await gFolder();
    if(!DRV.prog){
      const f=await gList("name='"+PROG_NAME+"' and trashed=false and appProperties has { key='app' and value='"+APPTAG+"' }");
      if(f.length)DRV.prog=f[0].id;
    }
    if(DRV.prog){
      const remote=await(await gfetch(GAPI+"/"+DRV.prog+"?alt=media")).json();
      if(remote&&remote.done){
        const rR=remote.resetAt||0,rL=STATE.resetAt||0;
        if(rR>rL){const v=STATE.view;for(const k in STATE)delete STATE[k];Object.assign(STATE,blankState(),remote,{view:v})}   /* outro aparelho zerou tudo depois */
        else if(rL>rR){}                                                                     /* este aparelho zerou: sobrescreve o Drive */
        else{const novo=(remote.updatedAt||0)>(STATE.updatedAt||0);Object.assign(STATE,novo?mergeState(STATE,remote):mergeState(remote,STATE))}
      }
      STATE.updatedAt=Date.now();await gUpload(DRV.prog,{},STATE);
    }else{
      STATE.updatedAt=Date.now();
      const meta={name:PROG_NAME,mimeType:"application/json",parents:[DRV.root],appProperties:{app:APPTAG}};
      try{DRV.prog=await gUpload(null,meta,STATE)}catch(e){delete meta.parents;DRV.prog=await gUpload(null,meta,STATE)}
    }
    const j=JSON.stringify(STATE);try{await window.storage.set("deleg-v1",j);await window.storage.set("deleg-v1-bak",j)}catch(e){}
    GST="salvo no Drive às "+hhmm();GERR="";lsSet("deleg-lastsync",String(STATE.updatedAt));
  }catch(e){GST="";GERR=e.message}
  GBUSY=false;render();
  if(GAGAIN)setTimeout(gSync,500);
}
async function gConnect(){
  try{await gToken()}catch(e){GERR=e.message;render();return}
  GST="conectado";GERR="";render();
  try{await gFolder();await gLoadJson(IDX_NAME,applyIndice,"deleg-indice");await gLoadJson(BANCO_NAME,applyBanco,"deleg-banco")}
  catch(e){GERR=e.message}
  await gSync();
}
function gOff(){if(GTOK&&gReady())try{google.accounts.oauth2.revoke(GTOK,()=>{})}catch(e){}GTOK="";GEXP=0;DRV={root:"",prog:"",files:null};lsDel("deleg-google");GST="";render()}

/* ---------- leitor de PDF ---------- */
const PDFJS_V="3.11.174",PDF_MAX=20;   /* PDFs guardados para abrir offline; os mais antigos saem */
let PDOC={id:"",doc:null},VW=null;
function loadPdfJs(){
  if(window.pdfjsLib)return Promise.resolve(window.pdfjsLib);
  return new Promise((res,rej)=>{const s=document.createElement("script");
    s.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/"+PDFJS_V+"/pdf.min.js";
    s.onload=()=>{pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/"+PDFJS_V+"/pdf.worker.min.js";res(pdfjsLib)};
    s.onerror=()=>rej(new Error("não consegui carregar o leitor de PDF"));document.head.appendChild(s)});
}
async function pdfBytes(f){
  const key="https://deleg.local/pdf/"+f.id+"/"+encodeURIComponent(f.mt||"");
  try{const c=await caches.open("deleg-pdf");const hit=await c.match(key);if(hit)return await hit.arrayBuffer()}catch(e){}
  const buf=await(await gfetch(GAPI+"/"+f.id+"?alt=media")).arrayBuffer();
  try{const c=await caches.open("deleg-pdf");
    for(const k of await c.keys())if(k.url.indexOf("/pdf/"+f.id+"/")>=0)await c.delete(k);
    await c.put(key,new Response(buf.slice(0),{headers:{"Content-Type":"application/pdf"}}));
    const ks=await c.keys();for(let i=0;i<ks.length-PDF_MAX;i++)await c.delete(ks[i])}catch(e){}
  return buf;
}
function refsOf(tk){return(INDICE.topicos&&INDICE.topicos[tk])||[]}
function refLabel(r){const p=INDICE.pdfs[r.pdf];return(p?p.titulo:r.pdf)+" · p. "+r.pag+(r.ate&&r.ate!==r.pag?"–"+r.ate:"")}
function openPdf(tk,i,blockId){
  const r=refsOf(tk)[i||0];if(!r)return;
  const tokP=gToken();                      /* pedido de login ainda dentro do clique */
  viewerShell(tk,r,blockId);
  (async()=>{
    try{
      await tokP;
      const P=INDICE.pdfs[r.pdf];if(!P)throw new Error("PDF "+r.pdf+" não consta do índice");
      if(!DRV.files)await gTree();
      const f=DRV.files[P.arq];if(!f)throw new Error("arquivo não encontrado no Drive: "+P.arq);
      vwMsg("carregando "+P.titulo+(f.sz?" · "+(f.sz/1048576).toFixed(1).replace(".",",")+" MB":"")+"…");
      const lib=await loadPdfJs();
      if(PDOC.id!==f.id){if(PDOC.doc)try{PDOC.doc.destroy()}catch(e){}PDOC={id:f.id,doc:await lib.getDocument({data:await pdfBytes(f)}).promise}}
      if(!VW)return;
      VW.doc=PDOC.doc;await vwBuild();
    }catch(e){vwMsg("Não deu para abrir: "+e.message,true)}
  })();
}
function viewerShell(tk,r,blockId){
  closeViewer();
  const el=document.createElement("div");el.className="pv";el.setAttribute("role","dialog");el.setAttribute("aria-modal","true");
  el.innerHTML='<div class="pv-h"><button class="pv-b" data-pv="x" aria-label="Fechar">✕</button><div class="pv-t"><b>'+esc(topName(tk))+'</b><span>'+esc(refLabel(r))+(r.secao?' · '+esc(r.secao):'')+'</span></div>'+
    '<span class="pv-n" id="pvN">—</span><button class="pv-b" data-pv="ini" title="Voltar ao início do trecho">⤒</button><button class="pv-b" data-pv="zm" title="Diminuir">A−</button><button class="pv-b" data-pv="zp" title="Aumentar">A+</button>'+
    (blockId?'<button class="pv-b pv-ok" data-pv="ok" title="Marcar o bloco como concluído">✓ concluir</button>':'')+'</div>'+
    '<div class="pv-s" id="pvS"><div class="pv-m" id="pvM">abrindo…</div></div>';
  document.body.appendChild(el);document.body.style.overflow="hidden";
  VW={el:el,box:el.querySelector("#pvS"),r:r,tk:tk,blockId:blockId,zoom:1,doc:null,io:null};
  el.addEventListener("click",e=>{const b=e.target.closest("[data-pv]");if(!b)return;const a=b.dataset.pv;
    if(a==="x")closeViewer();
    else if(a==="ini")vwGo(VW.r.pag);
    else if(a==="zm"||a==="zp"){VW.zoom=Math.max(.6,Math.min(2.4,VW.zoom+(a==="zp"?.2:-.2)));const p=vwCur();vwBuild(p)}
    else if(a==="ok"){if(VW.blockId){STATE.done[VW.blockId]=Date.now();save()}closeViewer();render()}});
  VW.onkey=e=>{if(e.key==="Escape")closeViewer()};document.addEventListener("keydown",VW.onkey);
}
function vwMsg(t,err){const m=VW&&VW.el.querySelector("#pvM");if(m){m.textContent=t;m.classList.toggle("err",!!err)}}
function closeViewer(){if(!VW)return;if(VW.io)VW.io.disconnect();document.removeEventListener("keydown",VW.onkey);VW.el.remove();VW=null;document.body.style.overflow=""}
function vwCur(){if(!VW)return 1;const pgs=VW.box.querySelectorAll(".pv-p"),top=VW.box.scrollTop+VW.box.clientHeight*.3;let c=1;pgs.forEach(p=>{if(p.offsetTop<=top)c=+p.dataset.p});return c}
function vwGo(p){const d=VW&&VW.box.querySelector('.pv-p[data-p="'+p+'"]');if(d)VW.box.scrollTop=d.offsetTop-8}
async function vwBuild(goto){
  const doc=VW.doc,box=VW.box,n=doc.numPages,r=VW.r;
  const W=Math.round(Math.min(box.clientWidth-16,940)*VW.zoom);
  const p1=await doc.getPage(Math.min(r.pag,n)),v1=p1.getViewport({scale:1}),H=Math.round(W*v1.height/v1.width);
  if(VW.io)VW.io.disconnect();
  let h="";for(let i=1;i<=n;i++){const inR=i>=r.pag&&i<=(r.ate||r.pag);
    h+='<div class="pv-p'+(inR?" in":"")+'" data-p="'+i+'" style="width:'+W+'px;height:'+H+'px"><span class="pv-pl">'+i+'</span></div>'}
  box.innerHTML=h;
  const draw=async div=>{
    if(div.dataset.st)return;div.dataset.st="1";
    try{const pg=await doc.getPage(+div.dataset.p),vp=pg.getViewport({scale:1}),dpr=Math.min(window.devicePixelRatio||1,2),s=W/vp.width,v=pg.getViewport({scale:s*dpr});
      const c=document.createElement("canvas");c.width=Math.round(v.width);c.height=Math.round(v.height);c.style.width=W+"px";c.style.height=Math.round(vp.height*s)+"px";
      div.style.height=c.style.height;
      await pg.render({canvasContext:c.getContext("2d"),viewport:v}).promise;
      if(div.dataset.st==="1"){div.appendChild(c);div.dataset.st="2"}
    }catch(e){div.dataset.st=""}
  };
  VW.io=new IntersectionObserver(es=>es.forEach(e=>{const d=e.target;
    if(e.isIntersecting)draw(d);else if(d.dataset.st){const c=d.querySelector("canvas");if(c){c.width=0;c.remove()}d.dataset.st=""}}),{root:box,rootMargin:"1400px 0px"});
  box.querySelectorAll(".pv-p").forEach(d=>VW.io.observe(d));
  vwGo(goto||r.pag);
  const upd=()=>{if(!VW)return;const c=vwCur();const nEl=VW.el.querySelector("#pvN");if(nEl)nEl.textContent="p. "+c+" / "+n;
    STATE.lido=STATE.lido||{};if((STATE.lido[VW.tk]||0)<c&&c<=(r.ate||r.pag)){STATE.lido[VW.tk]=c}};
  box.onscroll=()=>{clearTimeout(VW.st);VW.st=setTimeout(upd,120)};upd();
}

/* ---------- filtros do QConcursos ---------- */
/* Cada tópico aponta para os assuntos equivalentes da árvore do QConcursos (ids lidos dos filtros do próprio site).
   d = disciplinas, s = assuntos (o assunto-pai já inclui os filhos), q = palavra-chave quando o QC ainda não tem assunto próprio. */
const QCMAP={"PEN.p01":{"d":[9],"s":[16670,16668,16669]},"PEN.p02":{"d":[9],"s":[16672]},"PEN.p03":{"d":[9],"s":[16673,16671]},"PEN.p04":{"d":[9],"s":[16675,16677,16769,16680,16770,16681,16771,16772,16683,16682,16684]},"PEN.p05":{"d":[9],"s":[2216,3170,16773,16774,16775,16700,16778]},"PEN.p06":{"d":[9],"s":[16685,16686,16687,16688]},"PEN.p07":{"d":[9],"s":[16691]},"PEN.p08":{"d":[9],"s":[1134]},"PEN.p09":{"d":[9],"s":[128]},"PEN.p10":{"d":[9],"s":[17210,17215,17228,17234]},"PEN.p11":{"d":[9],"s":[16780,17232,17233,17246]},"PEN.p12":{"d":[9],"s":[17253,17258,17239]},"PEN.p13":{"d":[9],"s":[17271]},"PEN.p14":{"d":[9],"s":[17293]},"PEN.p15":{"d":[9],"s":[17298,17303,17310]},"PEN.p16":{"d":[9],"s":[17311,17317,17322,17323,17324]},"PEN.p17":{"d":[9],"s":[17326,17327,17328,17329,17330]},"PEN.p18":{"d":[9],"s":[17331,17332,17333,17334,17335,17336,17337,17338]},"PEN.p19":{"d":[9],"s":[17343]},"PEN.p20":{"d":[9],"s":[17383]},"PEN.p21":{"d":[9],"s":[17399,17400,17401,17402,17403,17404,17405,17406,17408,17409,17410,17411,17412,17413,17414,17415,17416,17417]},"PEN.p22":{"d":[9],"s":[17418,17419,17420,17421,23715,17423,17424,20769,17425,17427,17429,17422,30969,17430,17431,17432,17434,17436,17437,17438,17439,17440,17441,17442,17444,17446,17448,17450,17452]},"PEN.p23":{"d":[9],"s":[17374,17378,17454]},"PP.pp01":{"d":[10,53],"s":[18401,18556,18557,18678,18679,18680,20815]},"PP.pp02":{"d":[10],"s":[18681,18702]},"PP.pp03":{"d":[10],"s":[18711,19263,19278]},"PP.pp04":{"d":[10],"s":[17630,17613,17978,31442,31385]},"PP.pp05":{"d":[10,9],"s":[28114,6423,34750]},"PP.pp06":{"d":[10,9],"s":[150,17262]},"PP.pp07":{"d":[10],"s":[152]},"PP.pp08":{"d":[10],"s":[153,2555]},"PP.pp09":{"d":[10,530],"s":[20536,20537,20538,20539,17622,26170]},"PP.pp10":{"d":[10],"s":[20540,20541,20542]},"PP.pp11":{"d":[10],"s":[20543,20544,20545,20546,20547,20548]},"PP.pp12":{"d":[10],"s":[20549]},"PP.pp13":{"d":[10],"s":[903]},"PP.pp14":{"d":[10],"s":[5335,9317]},"PP.pp15":{"d":[10],"s":[20576,20577,20578,20581,7809]},"PP.pp16":{"d":[10],"s":[23513]},"PP.pp17":{"d":[10,53],"s":[20550,20926]},"PP.pp18":{"d":[10],"s":[4284,157,6683]},"PP.pp19":{"d":[10],"s":[1969,3834,161,162]},"PP.pp20":{"d":[10,3],"s":[1968,1973,20765]},"LPE.l01":{"d":[9],"s":[17457]},"LPE.l02":{"d":[10,9],"s":[20592,17457]},"LPE.l03":{"d":[10,53],"s":[23515,21704]},"LPE.l04":{"d":[9],"s":[1771]},"LPE.l05":{"d":[9],"s":[17455,17462]},"LPE.l06":{"d":[9],"s":[17456]},"LPE.l07":{"d":[9,10],"s":[34747,17302,23514]},"LPE.l08":{"d":[233],"s":[5302,21015,21020,21341,23783]},"LPE.l09":{"d":[9],"s":[17461]},"LPE.l10":{"d":[9,200],"s":[34749,18890]},"LPE.l11":{"d":[76],"s":[18545,18431]},"LPE.l12":{"d":[9],"s":[17463]},"LPE.l13":{"d":[9],"s":[17466]},"LPE.l14":{"d":[9,10],"s":[34750,6423,18901]},"LPE.l15":{"d":[53],"s":[20815,8476]},"LPE.l16":{"d":[9],"s":[17467]},"LPE.l17":{"d":[9],"s":[17324,30962,17334]},"LPE.l18":{"d":[534,579],"s":[17949,20909]},"LPE.l19":{"d":[53,9],"s":[23053,30963]},"LPE.l20":{"d":[10,53],"s":[7172,9436]},"LPE.l21":{"d":[9,10,53],"s":[],"q":"15.358"},"CON.c01":{"d":[3],"s":[18351,16325]},"CON.c02":{"d":[3],"s":[16265]},"CON.c03":{"d":[3],"s":[1418]},"CON.c04":{"d":[3],"s":[8827,49]},"CON.c05":{"d":[3],"s":[16294,16295,16296,16297,16298,1412]},"CON.c06":{"d":[3],"s":[16299,16301,16303,16300,16302,16304]},"CON.c07":{"d":[3],"s":[438,437]},"CON.c08":{"d":[3],"s":[1979]},"CON.c09":{"d":[3],"s":[806]},"CON.c10":{"d":[3],"s":[748,731]},"CON.c11":{"d":[3],"s":[16251]},"CON.c12":{"d":[3],"s":[16254,16255,751]},"CON.c13":{"d":[3],"s":[16256]},"CON.c14":{"d":[3],"s":[16257]},"ADM.a01":{"d":[2],"s":[15938,15940]},"ADM.a02":{"d":[2],"s":[775]},"ADM.a03":{"d":[2],"s":[16022]},"ADM.a04":{"d":[2],"s":[5]},"ADM.a05":{"d":[2,3],"s":[1269,16268]},"ADM.a06":{"d":[2],"s":[10]},"ADM.a07":{"d":[2],"s":[16073]},"ADM.a08":{"d":[2],"s":[27513,27522]},"ADM.a09":{"d":[2],"s":[11]},"ADM.a10":{"d":[2,53],"s":[12,22750]},"ADM.a11":{"d":[2],"s":[853,14]},"ADM.a12":{"d":[26],"s":[]},"DH.h01":{"d":[214],"s":[18760,18821]},"DH.h02":{"d":[214],"s":[18766,18774,18775,18776,18777,18780]},"DH.h03":{"d":[214],"s":[18792,18795]},"DH.h04":{"d":[53,214],"s":[27981,27125,18830]},"DH.h05":{"d":[214],"s":[18800,18785,18781,28043,18779]},"DH.h06":{"d":[214],"s":[19051,18826]},"DH.h07":{"d":[214],"s":[18778]},"ML.m01":{"d":[104,530],"s":[7627,12391,26163]},"ML.m02":{"d":[104],"s":[8082]},"ML.m03":{"d":[104],"s":[20282,9771,12390]},"ML.m04":{"d":[104,530],"s":[9768,26171]},"ML.m05":{"d":[104],"s":[5325]},"ML.m06":{"d":[104,530],"s":[9708,11383,25205,12727]},"ML.m07":{"d":[104],"s":[3940]},"ML.m08":{"d":[104],"s":[9795,9706]},"ML.m09":{"d":[530],"s":[24549,26164,26165,26166,26167,26170,26229]},"CRIM.r01":{"d":[554],"s":[19206]},"CRIM.r02":{"d":[554],"s":[19207]},"CRIM.r03":{"d":[554],"s":[19208]},"CRIM.r04":{"d":[554],"s":[19208,19210]},"CRIM.r05":{"d":[554],"s":[],"q":"vitimologia"},"CRIM.r06":{"d":[554],"s":[19211]},"CRIM.r07":{"d":[554],"s":[19209]}};
const QC_URL="https://www.qconcursos.com/questoes-de-concursos/questoes";
const QC_DELEGADO=169;                       /* cargo "Delegado de Polícia" no QC */
function qcUrl(tk,soDelegado,minhas){   /* minhas: "not_resolved" (padrão), "wrong" ou "all" */
  const m=QCMAP[tk];if(!m)return "";
  const p=m.d.map(x=>"discipline_ids[]="+x).concat(m.s.map(x=>"subject_ids[]="+x));
  if(m.q)p.push("q="+encodeURIComponent(m.q));
  p.push("exclude_nullified=true","exclude_outdated=true");
  if(soDelegado)p.push("job_ids[]="+QC_DELEGADO);
  p.push("my_questions="+(minhas||"not_resolved"));
  return QC_URL+"?"+p.join("&");
}
function qcChips(tk,tp){
  if(!QCMAP[tk])return "";
  return '<a class="chip-t" href="'+esc(qcUrl(tk,false))+'" target="_blank" rel="noopener" title="Questões do tema que você ainda não resolveu no QConcursos, sem anuladas e desatualizadas">🔎 QC · todas do tema</a>'+
         '<a class="chip-t" href="'+esc(qcUrl(tk,true))+'" target="_blank" rel="noopener" title="Só provas para Delegado de Polícia, ainda não resolvidas">🔎 QC · só Delegado</a>'+
         (tp==="rev"?'<a class="chip-t" href="'+esc(qcUrl(tk,false,"wrong"))+'" target="_blank" rel="noopener" title="Questões do tema que você errou no QConcursos">🔎 QC · que errei</a>':'');
}

/* ---------- caderno de erros (repetição espaçada) ---------- */
const SRS_INT=[1,3,7,15];
function srsAdd(id){STATE.srs=STATE.srs||{};STATE.srs[id]={st:0,ok:0,due:addD(today(),1),n:0,em:today()}}
function srsAnswer(id,ok){
  const s=STATE.srs[id];if(!s)return;s.n++;s.last=today();
  if(ok){s.ok++;s.st++;if(s.ok>=2){STATE.srsOut=STATE.srsOut||{};STATE.srsOut[id]=today();delete STATE.srs[id];return}s.due=addD(today(),SRS_INT[Math.min(s.st,SRS_INT.length-1)])}
  else{s.ok=0;s.st=0;s.due=addD(today(),1)}
}
function srsDue(){const t=today(),Q=window.QUESTOES||[];return Object.keys(STATE.srs||{}).filter(id=>STATE.srs[id].due<=t&&Q.some(q=>q.id===id)).sort((a,b)=>STATE.srs[a].due.localeCompare(STATE.srs[b].due))}
let CAD={i:0,r:null,all:false};
function viewCaderno(){
  const Q=window.QUESTOES||[],S=STATE.srs||{},ids=Object.keys(S).filter(id=>Q.some(q=>q.id===id)),due=srsDue(),out=Object.keys(STATE.srsOut||{}).length;
  let h='<div class="card"><h3>Caderno de erros · '+ids.length+' questão'+(ids.length===1?"":"ões")+'</h3>'+
    '<div class="rot"><div><b>para hoje</b>'+due.length+'</div><div><b>no caderno</b>'+ids.length+'</div><div><b>fixadas</b>'+out+'</div></div>'+
    '<p class="note">Cada questão errada entra aqui e volta em 1, 3, 7 e 15 dias. Errou de novo, o ciclo recomeça; acertou duas vezes seguidas, ela sai do caderno e conta como fixada.</p>'+
    (ids.length?'<div class="bar"><button class="btn pri" id="cadGo"'+(due.length?'':' disabled')+'>Revisar as '+due.length+' de hoje</button><button class="btn" id="cadAll">Revisar todas agora</button></div>':'')+'</div>';
  const fila=(CAD.q||[]).filter(id=>Q.some(q=>q.id===id));
  if(CAD.on&&CAD.i<fila.length){
    const id=fila[CAD.i],q=Q.find(x=>x.id===id),d=DISC[q.disc],r=CAD.r;   /* ordem fixada no início: respostas não embaralham a fila */
    h+='<div class="card qz" style="--dc:'+d.c+'"><div class="q-h"><span class="a-mat">'+esc(d.n)+' · revisão '+(CAD.i+1)+' de '+fila.length+'</span><span class="src">'+esc(topName(q.tk))+' · '+(S[id]?S[id].n:0)+' revisões · '+(S[id]?S[id].ok:0)+' acerto(s) seguido(s)</span></div>'+
      '<div class="q-e">'+esc(q.enun).replace(/\n/g,"<br>")+'</div><div class="q-alts">';
    "ABCDE".split("").forEach((L,j)=>{let cls="";if(r){if(L===q.gab)cls=" ok";else if(L===r)cls=" no"}
      h+='<button class="q-alt'+cls+'" data-cad="'+id+'|'+L+'"'+(r?" disabled":"")+'><b>'+L+'</b><span>'+esc(q.alts[j])+'</span></button>'});
    h+='</div>';
    if(r)h+='<div class="q-c'+(r===q.gab?" ok":" no")+'"><b>'+(r===q.gab?"Acertou.":"Errou de novo. Gabarito: "+q.gab+".")+'</b> '+cfm(esc(q.com))+(q.fonte?'<span class="src">Fundamento: '+cfm(esc(q.fonte))+'</span>':'')+
      '<div class="a-foot">'+(refsOf(q.tk).length?'<button class="chip-t" data-pdf="'+q.tk+'|0">📄 reler no PDF</button>':'')+(window.TEORIA[q.tk]?'<button class="chip-t" data-teo="'+q.tk+'">📖 teoria</button>':'')+'<button class="btn pri" id="cadNext" style="margin-left:auto">Próxima</button></div></div>';
    h+='</div>';
  }else if(CAD.on){h+='<div class="empty" style="margin-top:14px">Revisão concluída. Nada mais vence hoje.</div>'}
  if(ids.length){
    let l="";ids.sort((a,b)=>S[a].due.localeCompare(S[b].due)).forEach(id=>{const q=Q.find(x=>x.id===id);
      l+='<div class="mrow"><div class="mt"><span class="chip" style="background:'+DISC[q.disc].c+'">'+esc(DISC[q.disc].n)+'</span> '+esc(topName(q.tk))+'<div class="src">volta em '+fmt(S[id].due)+' · '+S[id].ok+' acerto(s) seguido(s) · errada em '+fmt(S[id].em||S[id].due)+'</div></div></div>'});
    h+='<div class="card"><h3>Fila do caderno</h3>'+l+'</div>';
  }else h+='<div class="empty" style="margin-top:14px">Nenhuma questão no caderno. As que você errar na aba Questões entram aqui automaticamente.</div>';
  return h;
}

/* ---------- desempenho e ajuste automático ---------- */
let BID=null;
function blockIdx(){if(BID)return BID;BID={};for(const d in PLAN)PLAN[d].forEach(t=>{BID[t.id]=t});return BID}
function perf(){
  const B=blockIdx(),Q=window.QUESTOES||[],disc={},tk={};
  const add=(o,k,h,t,d)=>{(o[k]=o[k]||[]).push({h:h,t:t,d:d})};
  (STATE.logs||[]).forEach(l=>{if(!DISC[l.disc]||!DISC[l.disc].q||l.task==="INEDITAS")return;add(disc,l.disc,l.hit,l.tot,l.d);
    const b=B[l.task];if(b&&b.tk)add(tk,b.tk,l.hit,l.tot,l.d)});
  Object.keys(STATE.qa||{}).forEach(id=>{const q=Q.find(x=>x.id===id),a=STATE.qa[id];if(!q||!a)return;add(disc,q.disc,a.ok,1,a.d);add(tk,q.tk,a.ok,1,a.d)});
  const sum=(arr,maxQ)=>{arr=arr.slice().sort((a,b)=>(a.d||"").localeCompare(b.d||""));let h=0,t=0;for(let i=arr.length-1;i>=0&&t<maxQ;i--){h+=arr[i].h;t+=arr[i].t}return{h:h,t:t,a:t?h/t:null}};
  const D={},T={};for(const k in disc)D[k]=sum(disc[k],80);for(const k in tk)T[k]=sum(tk[k],40);
  return{D:D,T:T};
}
const ADAPT_MIN=15,WEAK=.6,ATT=.7,STRONG=.75;
let ADAPT={weak:[],att:[],moved:0,until:""};
function adaptPlan(map){
  const tod=today(),P=perf(),until=addD(tod,28);
  const st=k=>{const x=P.D[k];return !x||x.t<ADAPT_MIN?"?":x.a<WEAK?"weak":x.a<ATT?"att":x.a>=STRONG?"strong":"ok"};
  const weak=Object.keys(DISC).filter(k=>DISC[k].q&&st(k)==="weak").sort((a,b)=>P.D[a].a-P.D[b].a);
  const att=Object.keys(DISC).filter(k=>DISC[k].q&&st(k)==="att");
  ADAPT={weak:weak,att:att,moved:0,until:until,P:P};
  const weakTopics=d=>{const done=Object.keys(P.T).filter(k=>k.indexOf(d+".")===0&&P.T[k].t>=4).sort((a,b)=>P.T[a].a-P.T[b].a);
    const ruins=done.filter(k=>P.T[k].a<ATT);
    const vistos=[];Object.keys(map).sort().forEach(day=>{if(day<tod)map[day].forEach(t=>{if(t.disc===d&&t.tk&&vistos.indexOf(t.tk)<0)vistos.push(t.tk)})});
    const outros=vistos.reverse().filter(k=>ruins.indexOf(k)<0&&!(P.T[k]&&P.T[k].a>=STRONG));
    return ruins.concat(outros).slice(0,Math.max(4,ruins.length));};
  const TK={};weak.forEach(d=>{TK[d]=weakTopics(d)});
  const cnt={},perWeek={};let rr=0;const donorN={};
  Object.keys(map).sort().forEach(day=>{
    if(day<tod||day>until)return;
    const wk=Math.floor((s2d(day)-s2d(START))/6048e5);
    map[day].forEach(t=>{
      if(STATE.done[t.id]||STATE.fz&&STATE.fz[t.id])return;
      if(t.id.indexOf("R.")===0&&(weak.length||att.length)){
        t.t="Revisão da semana com foco em "+weak.concat(att).map(k=>DISC[k].n).join(", ")+": caderno de erros, resumos e 15 questões dos tópicos de pior acerto";t.adapt=1;return}
      if(!weak.length||t.id.indexOf(".x")<0)return;
      let alvo=null;
      if(weak.indexOf(t.disc)>=0)alvo=t.disc;
      else if(st(t.disc)==="strong"){donorN[t.disc]=(donorN[t.disc]||0)+1;if(donorN[t.disc]%2===0)alvo=weak[rr++%weak.length]}
      if(!alvo)return;
      const kw=alvo+"|"+wk;if(alvo!==t.disc&&(perWeek[kw]||0)>=3)return;
      if(alvo!==t.disc)perWeek[kw]=(perWeek[kw]||0)+1;
      const L=TK[alvo],c=(cnt[alvo]=(cnt[alvo]||0)+1);const tkk=L.length?(c%2?L[0]:L[1+((c>>1)%Math.max(1,L.length-1))]||L[0]):null;
      const de=t.disc!==alvo?" (no lugar de "+DISC[t.disc].n+")":"";
      t.disc=alvo;t.tk=tkk||undefined;t.adapt=1;t.tp="rev";
      t.t="Reforço de "+DISC[alvo].n+(tkk?": "+topName(tkk):"")+de;
      const rf=tkk&&refsOf(tkk)[0];
      t.src=(rf?"Reler "+refLabel(rf)+" · ":"")+"refazer o caderno de erros do tópico + 15 questões do tema no QConcursos (🔎)";
      ADAPT.moved++;
    });
  });
}
function tasksByDay(){
  const map=tasksByDay0(),tod=today();
  for(const d in map)map[d].forEach(t=>{const z=STATE.fz&&STATE.fz[t.id];if(z)Object.assign(t,z,{adapt:1})});
  adaptPlan(map);
  const n=srsDue().length;
  if(n){const wd=s2d(tod).getDay(),ts=TIMES[wd]&&TIMES[wd][0]||"09:00";
    (map[tod]=map[tod]||[]).unshift({id:"SRS."+tod,disc:"REV",tp:"rev",t:"Caderno de erros: "+n+" questão"+(n===1?"":"ões")+" para revisar hoje",src:"Repetição espaçada · aba Caderno",min:Math.max(10,n*3),time:ts,date:tod,srs:1})}
  return map;
}
function freezeIfAdapted(id){
  const m=tasksByDay();for(const d in m){const t=m[d].find(x=>x.id===id);if(t&&t.adapt&&!t.srs){STATE.fz=STATE.fz||{};STATE.fz[id]={disc:t.disc,t:t.t,src:t.src,tk:t.tk,tp:t.tp}}}
}
function adaptCard(){
  const P=ADAPT.P||perf();let rows="";
  Object.keys(DISC).filter(k=>DISC[k].q).forEach(k=>{const x=P.D[k];
    const s=!x||x.t<ADAPT_MIN?"poucos dados ("+(x?x.t:0)+" de "+ADAPT_MIN+")":x.a<WEAK?"fraca: recebe reforço":x.a<ATT?"atenção: foco na revisão de domingo":x.a>=STRONG?"forte: pode ceder blocos de volume":"estável";
    rows+='<div class="stat"><span class="nm"><span class="dot" style="background:'+DISC[k].c+'"></span>'+esc(DISC[k].n)+'<span class="qt">'+s+'</span></span><span class="pc'+(x&&x.t?"":" none")+'">'+(x&&x.t?Math.round(x.a*100)+"%":"—")+'</span>'+
      '<span class="track"><span class="fill" style="width:'+(x&&x.t?Math.round(x.a*100):0)+'%;background:'+(x&&x.t?accColor(x.a):"transparent")+'"></span></span></div>'});
  const tw=Object.keys(P.T).filter(k=>P.T[k].t>=4).sort((a,b)=>P.T[a].a-P.T[b].a).slice(0,6);
  return '<div class="card'+(ADAPT.weak.length?" alert":"")+'"><h3>Ajuste automático do cronograma</h3>'+
    '<p class="note" style="margin-top:0">'+(ADAPT.weak.length?'Até '+fmt(ADAPT.until)+', <b>'+ADAPT.moved+' blocos</b> de volume foram redirecionados para '+ADAPT.weak.map(k=>DISC[k].n).join(", ")+'. Eles aparecem marcados com ↻ no cronograma e voltam ao normal quando o acerto passar de '+Math.round(WEAK*100)+'%.':'Nenhuma matéria abaixo de '+Math.round(WEAK*100)+'% de acerto. O cronograma segue o plano original.')+'</p>'+rows+
    '<p class="note">Base: últimas 80 questões de cada matéria (registros no ◎ e inéditas). Só entra no ajuste a matéria com pelo menos '+ADAPT_MIN+' questões. Matéria fraca recebe os próprios blocos de volume e metade dos blocos de volume das matérias fortes, até 3 por semana, sempre no tópico de pior acerto.</p>'+
    (tw.length?'<h3 style="margin-top:16px">Tópicos de pior acerto</h3>'+tw.map(k=>'<div class="mrow"><div class="mt">'+esc(topName(k))+'<div class="src">'+Math.round(P.T[k].a*100)+'% em '+P.T[k].t+' questões</div></div>'+(refsOf(k).length?'<button class="chip-t" data-pdf="'+k+'|0">📄 PDF</button>':'')+(QCMAP[k]?'<a class="chip-t" href="'+esc(qcUrl(k,false))+'" target="_blank" rel="noopener">🔎 QC</a>':'')+'</div>').join(""):'')+'</div>';
}

/* ---------- chips extras nos blocos ---------- */
function extraChips(t){
  let h="";
  if(t.adapt)h+='<span class="chip-t" title="Bloco ajustado pelo desempenho">↻ ajustado</span>';
  if(t.srs)return'<button class="chip-t" data-tab="cad">✎ revisar agora</button>';
  if(!t.tk)return h;
  const all=refsOf(t.tk).map((r,i)=>[r,i]);
  const want=t.tp==="quest"?(r=>r.tipo==="questoes"):t.tp==="rev"?(r=>r.tipo==="revisao"||!r.tipo):(r=>!r.tipo);
  let sel=all.filter(([r])=>want(r));if(!sel.length)sel=all;
  sel.forEach(([r,i])=>{h+='<button class="chip-t" data-pdf="'+t.tk+'|'+i+'|'+t.id+'" title="'+esc(r.secao||"")+'">'+(r.tipo==="questoes"?"✎ ":r.tipo==="revisao"?"↺ ":"📄 ")+esc(refLabel(r))+'</button>'});
  const nv=INDICE.niveis&&INDICE.niveis[t.tk];if(nv)h+='<button class="chip-t" data-nivel="'+t.tk+'" style="color:var(--ocre)">⚠ PDF parcial</button>';
  h+=qcChips(t.tk,t.tp);
  return h;
}

/* ---------- configurações ---------- */
function driveCard(){
  const on=gOn(),np=Object.keys(INDICE.pdfs||{}).length,nt=Object.keys(INDICE.topicos||{}).length;
  return '<div class="card'+(on?"":" alert")+'"><h3>Google Drive · banco de dados</h3>'+
    '<p class="note" style="margin-top:0">'+(on?'Conectado. Progresso, respostas e caderno de erros ficam em <b>'+PROG_NAME+'</b>, na pasta '+DB_NAME+'. '+(GST?'Estado: <b>'+esc(GST)+'</b>.':''):
      'Desconectado. Conecte uma vez por sessão para abrir os PDFs e salvar o progresso no Drive; o login dura cerca de 1 hora e é renovado no próximo clique.')+'</p>'+
    (GERR?'<p class="note" style="color:var(--carmim)">'+esc(GERR)+'</p>':'')+
    '<div class="bar">'+(on?'<button class="btn pri" id="gSyncNow">Sincronizar agora</button><button class="btn" id="gReload">Recarregar índice e banco</button><button class="btn warn" id="gOff">Desconectar</button>':'<button class="btn pri" id="gConn">Conectar Google Drive</button>')+'</div>'+
    '<p class="note">Índice: '+(np?np+' PDFs e '+nt+' tópicos mapeados'+(INDICE.gerado?' · gerado em '+esc(INDICE.gerado):''):'ainda não gerado')+'. Questões no banco: '+(window.QUESTOES||[]).length+'.</p></div>';
}
function gBanner(){
  if(gOn())return GERR?'<div class="card alert" style="padding:12px 16px"><p class="note" style="margin:0;color:var(--carmim)">'+esc(GERR)+'</p></div>':"";
  const pend=lsGet("deleg-google")&&(STATE.updatedAt||0)>(+lsGet("deleg-lastsync")||0);
  return '<div class="card'+(pend?" alert":"")+'" style="padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span class="note" style="margin:0;flex:1;min-width:180px">'+(GERR?'<b style="color:var(--carmim)">'+esc(GERR)+'.</b> ':'')+(pend?'<b>Há alterações salvas só neste aparelho.</b> Conecte para enviá-las ao Drive.':'Conecte o Google Drive para abrir os PDFs e salvar o progresso.')+'</span><button class="btn pri" id="gConn">Conectar Google Drive</button></div>';
}
/* ao voltar para a aba (outro aparelho pode ter salvo), busca o progresso no Drive */
let GVIS=0;
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&gOn()&&Date.now()-GVIS>30000){GVIS=Date.now();gSync().then(()=>render()).catch(()=>{})}});
function bindDrive(R){
  const $=s=>R.querySelector(s),$$=s=>R.querySelectorAll(s);
  $$("#gConn").forEach(b=>b.onclick=gConnect);
  if($("#gSyncNow"))$("#gSyncNow").onclick=()=>gSync();
  if($("#gOff"))$("#gOff").onclick=()=>{if(confirm("Desconectar o Google neste aparelho? O progresso continua salvo no Drive."))gOff()};
  if($("#gReload"))$("#gReload").onclick=async()=>{try{DRV.files=null;await gLoadJson(IDX_NAME,applyIndice,"deleg-indice");await gLoadJson(BANCO_NAME,applyBanco,"deleg-banco");GERR=""}catch(e){GERR=e.message}BID=null;render()};
  $$("[data-pdf]").forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();const[tk,i,bid]=b.dataset.pdf.split("|");openPdf(tk,+i||0,bid||"")});
  $$("[data-nivel]").forEach(b=>b.onclick=e=>{e.stopPropagation();alert(INDICE.niveis[b.dataset.nivel])});
  if($("#cadGo"))$("#cadGo").onclick=()=>{CAD={i:0,r:null,on:true,all:false,q:srsDue()};render()};
  if($("#cadAll"))$("#cadAll").onclick=()=>{const S=STATE.srs||{};CAD={i:0,r:null,on:true,all:true,q:Object.keys(S).filter(id=>(window.QUESTOES||[]).some(q=>q.id===id)).sort((a,b)=>S[a].due.localeCompare(S[b].due))};render()};
  $$("[data-cad]").forEach(b=>b.onclick=()=>{const[id,L]=b.dataset.cad.split("|"),q=(window.QUESTOES||[]).find(x=>x.id===id);if(!q||CAD.r)return;
    CAD.r=L;CAD.id=id;CAD.ok=L===q.gab;render()});
  if($("#cadNext"))$("#cadNext").onclick=()=>{if(CAD.id)srsAnswer(CAD.id,CAD.ok);CAD.i++;CAD.r=null;CAD.id=null;save();render();window.scrollTo({top:0})};
}
bootCache();
