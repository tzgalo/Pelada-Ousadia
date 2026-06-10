// ══════════════════════════════════════════
//  PELADA APP  —  app.js
//  3 times de 6 · Segunda 21h · Quadra Ousadia
// ══════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let db = null;

// ── APP STATE ────────────────────────────
const D = {
  curUser: null,       // { id, nome, isAdmin, isGuest, foto }
  jogadores: [],       // Array of player objects
  sorteio: null,       // Current/last sorteio
  presenca: null,      // Current presenca object
  peladasHist: [],     // Past peladas
  config: {            // Configurable values
    valorPelada: 20,
    multaDesistencia: 20,
    multaAviso3h: 5,
    multaAtraso: 2,
    aleatoriedade: 15,
    pixKey: '139.356.776-26',
    local: 'Quadra Ousadia\nR. Dr. Furtado de Menezes',
    horario: '21:00 às 22:30',
    diaSemana: 'Segunda-feira'
  },
  restricoes: [],      // [{ tipo:'nunca'|'sempre', a, b, permanent }]
  comunicados: [],     // Announcements
  unsubs: []           // Firestore unsubscribes
};

// ── CONSTANTS ───────────────────────────
const EMOJIS = ['🔥','👑','💀','🎯','⚽','😂','👏','💪','🌈','💩'];
const TIME_COLORS = ['#e05252','#4caf7d','#5b9cf6','#f0922b'];

// ── UTILS ───────────────────────────────
function initials(n) { return (n||'?').split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase(); }
function fmt2(n) { return (n||0).toFixed(2); }
function fmt4(n) { return (n||0).toFixed(4); }
function fmtDate(d) { if(!d) return ''; const dt = d.toDate ? d.toDate() : new Date(d); return dt.toLocaleDateString('pt-BR'); }
function fmtMoney(v) { return 'R$\u00a0'+Number(v||0).toFixed(2).replace('.',','); }
function genId() { return 'p'+Date.now()+Math.floor(Math.random()*1000); }

function toast(msg, dur=2500) {
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  const t = document.createElement('div'); t.className='toast'; t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), dur);
}

function closeModals() { document.querySelectorAll('.modal-overlay').forEach(m=>m.remove()); }

function modal(html, cls='') {
  closeModals();
  const ov = document.createElement('div'); ov.className='modal-overlay';
  ov.innerHTML=`<div class="modal-box ${cls}">${html}</div>`;
  ov.addEventListener('click', e => { if(e.target===ov) closeModals(); });
  document.body.appendChild(ov);
}

function confirm(msg, onYes, yesLabel='CONFIRMAR', yesClass='btn-gold') {
  modal(`<div class="modal-title">Confirmar</div><p style="color:var(--text2);font-size:13px;margin-bottom:16px">${msg}</p>
    <button class="btn ${yesClass}" onclick="window._confirmYes()">${yesLabel}</button>
    <button class="btn btn-outline mt8" onclick="closeModals()">Cancelar</button>`,'centered');
  window._confirmYes = () => { closeModals(); onYes(); };
}

// Fuzzy match
function fuzzy(a, b) {
  a = (a||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  b = (b||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(a===b) return 1;
  if(a.includes(b)||b.includes(a)) return 0.8;
  let m=0, j=0;
  for(let i=0;i<a.length&&j<b.length;i++) if(a[i]===b[j]){m++;j++;}
  return (2*m)/(a.length+b.length);
}
function findJogador(nome) {
  let best=null, bestScore=0;
  for(const j of D.jogadores) {
    const s = fuzzy(nome, j.nome);
    if(s>bestScore){bestScore=s;best=j;}
  }
  return bestScore>=0.6 ? best : null;
}

// 5th business day calc
function get5DiaUtil(year, month) {
  const feriados = ['01-01','21-04','01-05','07-09','12-10','02-11','15-11','20-11','25-12'];
  let count=0, day=1;
  while(count<5) {
    const d = new Date(year, month-1, day);
    const dow = d.getDay();
    const key = String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
    if(dow!==0&&dow!==6&&!feriados.includes(key)) count++;
    if(count<5) day++;
  }
  return new Date(year, month-1, day);
}
function getProximoPrazo() {
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const m=hoje.getMonth()+1, y=hoje.getFullYear();
  let prazo = get5DiaUtil(y,m);
  if(hoje>prazo) prazo = get5DiaUtil(m===12?y+1:y, m===12?1:m+1);
  return prazo;
}

// ── HASH ────────────────────────────────
async function hashStr(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ── FIRESTORE HELPERS ───────────────────
async function fbGet(path) { try { const r=await getDoc(doc(db,...path.split('/'))); return r.exists()?r.data():null; } catch(e){return null;} }
async function fbSet(path, data) { try { await setDoc(doc(db,...path.split('/')), data, {merge:true}); return true; } catch(e){console.error(e);return false;} }
async function fbDel(path) { try { await deleteDoc(doc(db,...path.split('/'))); return true; } catch(e){return false;} }
function fbListen(path, cb) {
  const ref = path.includes('/') ? doc(db,...path.split('/')) : collection(db,path);
  const unsub = onSnapshot(ref, snap => {
    if(snap.docs) cb(snap.docs.map(d=>({id:d.id,...d.data()})));
    else cb(snap.exists()?{id:snap.id,...snap.data()}:null);
  });
  D.unsubs.push(unsub);
  return unsub;
}

// ── SETUP SCREEN ────────────────────────
function showSetup() {
  document.getElementById('login-screen').innerHTML = `
    <div class="login-logo">PELADA</div>
    <div class="login-sub">Configurar Firebase</div>
    <div class="login-card">
      <p style="color:var(--text2);font-size:12px;margin-bottom:16px;line-height:1.6">
        Para sincronizar dados entre todos os jogadores, conecte ao Firebase.<br>
        Crie um projeto gratuito em <strong style="color:var(--gold)">console.firebase.google.com</strong>
      </p>
      ${['apiKey','authDomain','projectId','storageBucket','messagingSenderId','appId'].map(k=>`
        <div class="input-wrap"><label>${k}</label><input type="text" id="fb-${k}" placeholder="${k}"/></div>
      `).join('')}
      <button class="btn btn-gold mt8" onclick="saveFirebase()">SALVAR E CONECTAR</button>
      <button class="btn btn-outline mt8" style="margin-top:8px" onclick="useLocal()">USAR SEM FIREBASE</button>
    </div>`;
}

function saveFirebase() {
  const cfg = {};
  ['apiKey','authDomain','projectId','storageBucket','messagingSenderId','appId'].forEach(k=>{
    cfg[k]=document.getElementById('fb-'+k).value.trim();
  });
  if(!cfg.apiKey||!cfg.projectId){toast('Preencha pelo menos apiKey e projectId');return;}
  localStorage.setItem('pelada_fb', JSON.stringify(cfg));
  location.reload();
}

function useLocal() {
  localStorage.setItem('pelada_fb','local');
  location.reload();
}

// ── LOCAL STORAGE FALLBACK ───────────────
const LS = {
  get(k){ try{return JSON.parse(localStorage.getItem('pelada_'+k));}catch{return null;}},
  set(k,v){ localStorage.setItem('pelada_'+k,JSON.stringify(v)); },
  del(k){ localStorage.removeItem('pelada_'+k); }
};

// ── BOOT ────────────────────────────────
async function boot() {
  // Always load from localStorage first
  D.jogadores   = LS.get('jogadores')||[];
  D.sorteio     = LS.get('sorteio');
  D.presenca    = LS.get('presenca');
  D.peladasHist = LS.get('peladasHist')||[];
  D.config      = {...D.config,...(LS.get('config')||{})};
  D.restricoes  = LS.get('restricoes')||[];
  D.comunicados = LS.get('comunicados')||[];

  // Try Firebase if configured
  const fbStore = localStorage.getItem('pelada_fb');
  if(fbStore && fbStore !== 'local') {
    try {
      const savedCfg = JSON.parse(fbStore);
      if(savedCfg && savedCfg.apiKey) {
        const a = initializeApp(savedCfg, 'main');
        db = getFirestore(a);
        startListeners();
      }
    } catch(e) { console.log('Firebase not configured, using local storage'); }
  }

  // Restore session
  const sess = LS.get('user');
  if(sess && !sess.isGuest) {
    D.curUser = sess;
    showApp();
  } else {
    showLogin();
  }
}

function startListeners() {
  if(!db) return;
  fbListen('jogadores', list => { D.jogadores=list; if(D.curUser) renderCurrent(); });
  fbListen('config/main', data => { if(data) D.config={...D.config,...data}; });
  fbListen('sorteio/current', data => { D.sorteio=data; if(D.curUser) renderHome(); });
  fbListen('presenca/current', data => { D.presenca=data; if(D.curUser) renderHome(); });
  fbListen('peladas', list => { D.peladasHist=list.sort((a,b)=>b.data?.localeCompare?.(a.data)||0); if(D.curUser) renderCurrent(); });
  fbListen('restricoes', list => { D.restricoes=list; });
  fbListen('comunicados', list => { D.comunicados=list.sort((a,b)=>(b.ts||0)-(a.ts||0)); if(D.curUser) renderHome(); });
}

// ── LOGIN ───────────────────────────────
function showLogin() { document.getElementById('login-screen').style.display='flex'; }

let loginStage = 'nome'; // nome | senha | nova-senha
let loginJogador = null;

function loginStep() {
  const nome = document.getElementById('login-name').value.trim();
  if(!nome) { showErr('login-name-err','Digite seu nome'); return; }
  hideErr('login-name-err');

  if(loginStage==='nome') {
    const j = findJogador(nome);
    loginJogador = j;
    if(j) {
      if(j.senhaHash) {
        loginStage='senha';
        document.getElementById('login-pass-wrap').style.display='block';
        document.getElementById('login-pass-label').textContent='Senha';
        document.getElementById('login-name').disabled=true;
        document.querySelector('#loginCard .btn-gold').textContent='ENTRAR';
      } else {
        // First time — set password
        loginStage='nova-senha';
        document.getElementById('login-pass-wrap').style.display='block';
        document.getElementById('login-pass-label').textContent='Criar senha';
        document.getElementById('login-name').disabled=true;
        document.querySelector('#loginCard .btn-gold').textContent='CRIAR SENHA E ENTRAR';
      }
    } else {
      // Guest
      entrarComo({ id: 'guest_'+Date.now(), nome, isAdmin:false, isGuest:true });
    }
  } else if(loginStage==='senha') {
    const pass = document.getElementById('login-pass').value;
    hashStr(pass).then(h => {
      if(h===loginJogador.senhaHash) {
        entrarComo({id:loginJogador.id, nome:loginJogador.nome, isAdmin:isAdmin(loginJogador.id), isGuest:false, foto:loginJogador.foto||null});
      } else {
        showErr('login-pass-err','Senha incorreta');
        document.getElementById('login-pass').value='';
        document.getElementById('login-pass').focus();
      }
    });
  } else if(loginStage==='nova-senha') {
    const pass = document.getElementById('login-pass').value;
    if(pass.length<4){showErr('login-pass-err','Mínimo 4 caracteres');return;}
    hashStr(pass).then(async h => {
      await saveJogador({...loginJogador, senhaHash:h});
      entrarComo({id:loginJogador.id, nome:loginJogador.nome, isAdmin:isAdmin(loginJogador.id), isGuest:false, foto:loginJogador.foto||null});
    });
  }
}

function entrarSemConta() {
  entrarComo({ id:'visitor_'+Date.now(), nome:'Visitante', isAdmin:false, isGuest:true });
}

function entrarComo(u) {
  D.curUser = u;
  if(!u.isGuest) LS.set('user', u);
  document.getElementById('login-screen').style.display='none';
  showApp();
}

function isAdmin(id) {
  const cfg = LS.get('admins')||[];
  if(db) {
    // Will be refreshed by listener
    const j = D.jogadores.find(x=>x.id===id);
    return j?.isAdmin||false;
  }
  return cfg.includes(id);
}

function showErr(id, msg) { const el=document.getElementById(id); if(el){el.textContent=msg;el.style.display='block';} }
function hideErr(id) { const el=document.getElementById(id); if(el)el.style.display='none'; }

// ── SHOW APP ────────────────────────────
function showApp() {
  if(!db) { startListeners(); }
  // Update header
  const u = D.curUser;
  const isAdm = u && !u.isGuest && isAdminUser();
  document.getElementById('topbar').style.display='flex';
  document.getElementById('nav').style.display='flex';
  document.getElementById('screen').style.display='block';
  const av = document.getElementById('header-avatar');
  if(u?.foto) av.innerHTML=`<img src="${u.foto}"/>`; else av.textContent=initials(u?.nome||'?');
  document.getElementById('header-name').textContent = u?.nome||'—';
  // FM buttons
  const isRegistered = u && !u.isGuest;
  document.getElementById('fm-foto').style.display = isRegistered?'flex':'none';
  document.getElementById('fm-senha').style.display = isRegistered?'flex':'none';
  goTab('home');
}

function isAdminUser() {
  if(!D.curUser||D.curUser.isGuest) return false;
  const j = D.jogadores.find(x=>x.id===D.curUser.id);
  return j?.isAdmin||false;
}

// ── NAVIGATION ──────────────────────────
let curTab = 'home';
function goTab(tab) {
  curTab = tab;
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  const btn = document.getElementById('nav-'+tab);
  if(btn) btn.classList.add('active');
  closeModals(); hideFloatMenu();
  renderTab(tab);
}
function renderTab(tab) {
  const s = document.getElementById('screen');
  if(tab==='home') renderHome();
  else if(tab==='jogadores') renderJogadores();
  else if(tab==='ranking') renderRanking();
  else if(tab==='financas') renderFinancas();
  else if(tab==='opcoes') renderOpcoes();
}
function renderCurrent() { renderTab(curTab); }

// ── FLOAT MENU ──────────────────────────
function toggleFloatMenu() {
  const fm = document.getElementById('float-menu');
  fm.style.display = fm.style.display==='none' ? 'block' : 'none';
}
function hideFloatMenu() { document.getElementById('float-menu').style.display='none'; }
document.addEventListener('click', e => {
  if(!e.target.closest('.user-btn')&&!e.target.closest('#float-menu')) hideFloatMenu();
});

function verPerfil() {
  hideFloatMenu();
  if(!D.curUser||D.curUser.isGuest) {
    modal(`<div class="modal-title">🚫 Não cadastrado</div>
      <p style="color:var(--text2);font-size:13px">Você não está cadastrado como jogador. Peça ao admin para te cadastrar.</p>
      <button class="btn btn-outline mt8" onclick="closeModals()">OK</button>`,'centered');
    return;
  }
  const j = D.jogadores.find(x=>x.id===D.curUser.id);
  if(!j) { modal(`<div class="modal-title">🚫 Jogador não cadastrado</div><p style="color:var(--text2);font-size:13px">Seu nome não corresponde a um jogador cadastrado.</p><button class="btn btn-outline mt8" onclick="closeModals()">OK</button>`,'centered'); return; }
  abrirPerfil(j.id);
}

function sairDaConta() {
  hideFloatMenu();
  LS.del('user');
  D.curUser = null;
  location.reload();
}

async function abrirUploadFoto() {
  hideFloatMenu();
  const j = D.jogadores.find(x=>x.id===D.curUser?.id);
  if(!j) return;
  const input = document.createElement('input'); input.type='file'; input.accept='image/*';
  input.onchange = async () => {
    const file = input.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = async e => {
      const img = new Image(); img.src=e.target.result;
      img.onload = async () => {
        const canvas=document.createElement('canvas'); canvas.width=canvas.height=200;
        const ctx=canvas.getContext('2d');
        const s=Math.min(img.width,img.height);
        ctx.drawImage(img,(img.width-s)/2,(img.height-s)/2,s,s,0,0,200,200);
        const b64=canvas.toDataURL('image/jpeg',.7);
        await saveJogador({...j, foto:b64});
        D.curUser={...D.curUser,foto:b64}; LS.set('user',D.curUser);
        const av=document.getElementById('header-avatar'); av.innerHTML=`<img src="${b64}"/>`;
        toast('Foto atualizada ✓');
      };
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function abrirMudarSenha() {
  hideFloatMenu();
  modal(`<div class="modal-title">🔑 Mudar Senha</div>
    <div class="input-wrap"><label>Senha atual</label><input type="password" id="mp-atual" placeholder="••••"/></div>
    <div class="input-wrap"><label>Nova senha</label><input type="password" id="mp-nova" placeholder="••••"/></div>
    <div class="input-wrap"><label>Confirmar nova senha</label><input type="password" id="mp-conf" placeholder="••••"/></div>
    <div id="mp-err" style="font-size:11px;color:var(--red);margin-bottom:8px;display:none"></div>
    <button class="btn btn-gold" onclick="confirmarMudarSenha()">SALVAR</button>
    <button class="btn btn-outline mt8" onclick="closeModals()">Cancelar</button>`);
}
async function confirmarMudarSenha() {
  const j = D.jogadores.find(x=>x.id===D.curUser?.id); if(!j) return;
  const atual=document.getElementById('mp-atual').value;
  const nova=document.getElementById('mp-nova').value;
  const conf=document.getElementById('mp-conf').value;
  const err=document.getElementById('mp-err');
  const h = await hashStr(atual);
  if(j.senhaHash&&h!==j.senhaHash){err.textContent='Senha atual incorreta';err.style.display='block';return;}
  if(nova.length<4){err.textContent='Mínimo 4 caracteres';err.style.display='block';return;}
  if(nova!==conf){err.textContent='Senhas não conferem';err.style.display='block';return;}
  const nh=await hashStr(nova);
  await saveJogador({...j,senhaHash:nh});
  closeModals(); toast('Senha alterada ✓');
}

// ── SAVE HELPERS ────────────────────────
async function saveJogador(j) {
  D.jogadores = D.jogadores.map(x=>x.id===j.id?j:x);
  if(!D.jogadores.find(x=>x.id===j.id)) D.jogadores.push(j);
  if(db) await fbSet('jogadores/'+j.id, j);
  else LS.set('jogadores', D.jogadores);
}
async function delJogador(id) {
  D.jogadores = D.jogadores.filter(x=>x.id!==id);
  if(db) await fbDel('jogadores/'+id);
  else LS.set('jogadores', D.jogadores);
}
async function saveSorteio(s) {
  D.sorteio = s;
  if(db) await fbSet('sorteio/current', s);
  else LS.set('sorteio', s);
}
async function savePresenca(p) {
  D.presenca = p;
  if(db) await fbSet('presenca/current', p);
  else LS.set('presenca', p);
}
async function saveConfig(c) {
  D.config = {...D.config,...c};
  if(db) await fbSet('config/main', D.config);
  else LS.set('config', D.config);
}
async function addPelada(p) {
  if(db) await addDoc(collection(db,'peladas'), p);
  else { D.peladasHist.push({id:genId(),...p}); LS.set('peladasHist',D.peladasHist); }
}
async function updatePelada(id, data) {
  D.peladasHist = D.peladasHist.map(x=>x.id===id?{...x,...data}:x);
  if(db) await fbSet('peladas/'+id, data);
  else LS.set('peladasHist', D.peladasHist);
}
async function delPelada(id) {
  D.peladasHist = D.peladasHist.filter(x=>x.id!==id);
  if(db) await fbDel('peladas/'+id);
  else LS.set('peladasHist', D.peladasHist);
}

// ══════════════════════════════════════════
//  HOME TAB
// ══════════════════════════════════════════
function renderHome() {
  const s = document.getElementById('screen');
  const isAdm = isAdminUser();
  let html = '';

  // Comunicados
  if(D.comunicados.length) {
    html += D.comunicados.slice(0,3).map(c=>`
      <div class="announce-card" style="margin:12px 12px 0">
        <div class="announce-title">📢 ${escHtml(c.titulo)}</div>
        <div class="announce-body">${escHtml(c.corpo)}</div>
        <div class="announce-meta">${c.autor} · ${c.data||''}${isAdm?` <span class="gold-text" style="cursor:pointer" onclick="delComunicado('${c.id}')">✕ remover</span>`:''}</div>
      </div>`).join('');
  }

  // Admin controls
  if(isAdm) {
    html += `<div style="padding:12px 12px 0;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-gold btn-sm" onclick="iniciarFlow()" style="flex:1">⚽ SORTEAR TIMES</button>
      <button class="btn btn-outline btn-sm" onclick="novoComunicado()" style="flex:1">📢 COMUNICADO</button>
    </div>`;
  }

  // Presença / Times
  html += renderPresencaSection();

  // Peladas anteriores
  html += renderPeladasSection();

  s.innerHTML = html;
}

function renderPresencaSection() {
  const isAdm = isAdminUser();
  const p = D.presenca;
  const s = D.sorteio;
  let html = `<div class="section-header">LISTA DA SEMANA</div>`;

  if(!p && !s) {
    html += `<div class="card"><div class="empty" style="padding:20px 0">Nenhuma pelada agendada ainda.</div></div>`;
    return html;
  }

  // Show times if sorteio confirmed
  if(s && s.status==='confirmado' && s.times) {
    html += `<div class="card">`;
    html += `<div class="flex-between mb8">
      <div class="card-title" style="margin:0">TIMES</div>
      ${isAdm?`<button class="btn btn-outline btn-sm" onclick="editarTimes()">✏️ Editar</button>`:''}
    </div>`;
    const keys = Object.keys(s.times).sort();
    html += keys.map((k,i)=>`
      <div class="team-card">
        <div class="team-label" style="color:${TIME_COLORS[i]||'var(--gold)'}">TIME ${i+1}</div>
        ${(s.times[k]||[]).map(nome=>{
          const jg=D.jogadores.find(x=>x.nome===nome||x.id===nome);
          const av=jg?.foto?`<img src="${jg.foto}"/>`:initials(jg?.nome||nome);
          return `<div class="team-player"><div class="player-avatar sm">${av}</div><span>${escHtml(jg?.nome||nome)}</span></div>`;
        }).join('')}
      </div>`).join('');
    if(isAdm) html += `<button class="btn btn-red btn-sm mt8" onclick="cancelarSorteio()">✕ Cancelar sorteio</button>`;
    html += '</div>';
  }

  // Presence list
  if(p) {
    const confirmados = p.confirmados || [];
    const espera = p.espera || [];
    const total = confirmados.length;
    const duracao = total >= 20 ? '11:30 às 13:30' : D.config.horario;
    const prazoAvulso = getProximoSabado12h();

    // Desc text
    const dataStr = p.data || getProximaSegunda();
    const descText = `Pelada — ${dataStr}\n${D.config.local}\n${duracao}\nPix: ${D.config.pixKey}`;

    html += `<div class="card">
      <div class="flex-between" style="margin-bottom:10px">
        <div class="card-title" style="margin:0">PRESENÇA</div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="badge ${total>=15?'badge-green':'badge-gray'}">${total}/15${total>=20?'+':''}</span>
          ${isAdm?`<button class="btn btn-outline btn-sm" onclick="gerenciarPresenca()">⚙️</button>`:''}
        </div>
      </div>
      <div class="presence-desc">${escHtml(descText)}</div>`;

    if(confirmados.length) {
      const sorted = [...confirmados].sort((a,b)=>a.nome?.localeCompare(b.nome)||0);
      html += sorted.map((c,i)=>{
        const jg = D.jogadores.find(x=>x.id===c.id||x.nome===c.nome);
        const isAvulso = jg?.tipo==='avulso';
        const pagou = c.pagou;
        return `<div class="presence-name">
          <span class="presence-num">${i+1}.</span>
          <span>${escHtml(c.nome)}</span>
          ${isAvulso&&!pagou?`<span class="espera-tag">💰 pendente</span>`:''}
          ${isAdm&&isAvulso&&!pagou?`<button class="btn btn-green btn-sm" style="padding:2px 8px;font-size:10px;margin-left:auto" onclick="darBaixaPresenca('${c.id||c.nome}')">Pago</button>`:''}
        </div>`;
      }).join('');
    }

    if(espera.length) {
      html += `<div style="margin-top:8px;font-size:11px;color:var(--text3);letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px">Lista de espera</div>`;
      html += espera.map((c,i)=>`
        <div class="presence-name">
          <span class="presence-num">${i+1}.</span>
          <span style="color:var(--text3)">${escHtml(c.nome)}</span>
          <span class="espera-tag">espera</span>
        </div>`).join('');
    }

    // Confirm button for current user
    const cur = D.curUser;
    if(cur && !cur.isGuest) {
      const jg = D.jogadores.find(x=>x.id===cur.id);
      if(jg) {
        const jaConfirmou = confirmados.find(x=>x.id===cur.id)||espera.find(x=>x.id===cur.id);
        const inadimplente = jogadorInadimplente(jg);
        if(!p.aberta) {
          // closed
        } else if(inadimplente&&inadimplente!=='mensalidade') {
          html += `<button class="btn btn-red w100 mt8" style="pointer-events:none;opacity:.7" disabled>⚠️ HÁ DÉBITOS EM ABERTO</button>`;
        } else if(jaConfirmou) {
          const naEspera = espera.find(x=>x.id===cur.id);
          html += `<button class="btn btn-outline w100 mt8" style="color:var(--red);border-color:var(--red)" onclick="desmarcarPresenca()">
            ${naEspera?'✕ Sair da espera':'✕ DESMARCAR'}</button>`;
        } else {
          html += `<button class="btn btn-gold w100 mt8" onclick="confirmarPresenca()">✓ CONFIRMAR PRESENÇA</button>`;
        }
      }
    }

    html += '</div>';
  }

  return html;
}

function renderPeladasSection() {
  // Collect all unique dates from players' history
  const datesSet = new Set();
  D.jogadores.forEach(j=>(j.domingos||[]).forEach(d=>datesSet.add(d.data)));
  D.peladasHist.forEach(p=>p.data&&datesSet.add(p.data));
  const dates = [...datesSet].sort().reverse().slice(0,20);

  if(!dates.length) return '';
  const isAdm = isAdminUser();
  let html = `<div class="section-header">PELADAS ANTERIORES</div>`;

  html += dates.map(data=>{
    const p = D.peladasHist.find(x=>x.data===data);
    const jogNaData = D.jogadores.filter(j=>(j.domingos||[]).some(d=>d.data===data));
    const mvp = p?.mvp;
    const label = p?.cancelada ? '<span class="badge badge-red">Cancelada</span>' : '';
    const mvpJog = mvp ? D.jogadores.find(x=>x.id===mvp||x.nome===mvp) : null;
    return `<div class="card" style="cursor:pointer" onclick="abrirPelada('${data}')">
      <div class="flex-between">
        <div>
          <div style="font-weight:700;font-size:13px">${data} ${label}</div>
          <div class="small mt8">${jogNaData.length} jogador${jogNaData.length!==1?'es':''}</div>
        </div>
        <div style="text-align:right">
          ${mvpJog?`<div style="font-size:11px;color:var(--gold)">⭐ MVP: ${escHtml(mvpJog.nome)}</div>`:''}
          ${isAdm?`<button class="btn btn-outline btn-sm" style="margin-top:4px;color:var(--red);border-color:var(--red)" onclick="event.stopPropagation();confirmarDelPelada('${data}')">🗑️</button>`:''}
        </div>
      </div>
    </div>`;
  }).join('');

  return html;
}

// ══════════════════════════════════════════
//  PLAYERS TAB
// ══════════════════════════════════════════
function renderJogadores() {
  const s = document.getElementById('screen');
  const isAdm = isAdminUser();
  let html = '';

  if(isAdm) {
    html += `<div style="padding:12px 12px 0"><button class="btn btn-gold" onclick="abrirCadJogador()">+ CADASTRAR JOGADOR</button></div>`;
  }

  if(!D.jogadores.length) {
    html += `<div class="empty">Nenhum jogador cadastrado.</div>`;
  } else {
    html += `<div class="section-header">JOGADORES (${D.jogadores.length})</div>`;
    const sorted = [...D.jogadores].sort((a,b)=>a.nome?.localeCompare(b.nome));
    html += `<div class="card">` + sorted.map(j=>{
      const isMe = D.curUser?.id===j.id;
      const av = j.foto?`<img src="${j.foto}"/>`:initials(j.nome);
      const debito = getTotalDebito(j);
      return `<div class="player-row" onclick="abrirPerfil('${j.id}')" style="cursor:pointer">
        <div class="player-avatar" style="${isMe?'border-color:var(--blue)':''}">${av}</div>
        <div class="player-info">
          <div class="player-name">${escHtml(j.nome)}${j.isAdmin?' <span class="badge badge-gold">ADM</span>':''}</div>
          <div class="player-sub">${j.tipo==='avulso'?'Avulso':'Fixo'} · ${(j.domingos||[]).length} jogo${(j.domingos||[]).length!==1?'s':''}</div>
        </div>
        <div style="text-align:right">
          <div class="mono" style="font-size:13px;color:var(--gold)">${fmt2(calcIF(j))}</div>
          ${debito>0?`<div class="small" style="color:var(--red)">-${fmtMoney(debito)}</div>`:''}
        </div>
      </div>`;
    }).join('') + `</div>`;
  }
  s.innerHTML = html;
}

// ══════════════════════════════════════════
//  RANKING TAB
// ══════════════════════════════════════════
function renderRanking() {
  const s = document.getElementById('screen');
  const ranked = [...D.jogadores]
    .map(j=>({...j, if_val:calcIF(j)}))
    .sort((a,b)=>b.if_val-a.if_val);

  let html = `<div class="section-header">RANKING GERAL</div><div class="card">`;
  if(!ranked.length) { html += `<div class="empty">Sem jogadores ainda.</div>`; }
  else {
    html += ranked.map((j,i)=>{
      const pos = i+1;
      const posClass = pos===1?'gold':pos===2?'silver':pos===3?'bronze':'';
      const posEmoji = pos===1?'🥇':pos===2?'🥈':pos===3?'🥉':'';
      const av = j.foto?`<img src="${j.foto}"/>`:initials(j.nome);
      return `<div class="rank-row" onclick="abrirPerfil('${j.id}')" style="cursor:pointer">
        <div class="rank-pos ${posClass}">${posEmoji||pos}</div>
        <div class="player-avatar sm">${av}</div>
        <div class="player-info">
          <div class="player-name">${escHtml(j.nome)}</div>
          <div class="player-sub">${(j.domingos||[]).length} jogo${(j.domingos||[]).length!==1?'s':''}</div>
        </div>
        <div class="rank-score">${fmt2(j.if_val)}</div>
      </div>`;
    }).join('');
  }
  html += '</div>';
  s.innerHTML = html;
}

// ══════════════════════════════════════════
//  FINANCES TAB
// ══════════════════════════════════════════
function renderFinancas() {
  const s = document.getElementById('screen');
  const isAdm = isAdminUser();
  const prazo = getProximoPrazo();
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const passouPrazo = hoje > prazo;
  let html = '';

  // Admin value config button
  if(isAdm) {
    html += `<div style="padding:12px 12px 4px;display:flex;justify-content:flex-end">
      <button class="btn btn-outline btn-sm" onclick="abrirConfigValores()">⚙️ Valores</button>
    </div>`;
  }

  // Payment info
  html += `<div class="card">
    <div class="card-title">PAGAMENTOS</div>
    <div style="font-size:13px;color:var(--text2);line-height:1.8">
      <div>Valor por pelada: <strong class="gold-text">${fmtMoney(D.config.valorPelada)}</strong></div>
      <div>Prazo: <strong style="color:${passouPrazo?'var(--red)':'var(--green)'}">até ${prazo.toLocaleDateString('pt-BR')}</strong></div>
      <div>Atraso: <strong class="red-text">+${fmtMoney(D.config.multaAtraso)}/semana</strong></div>
      <div style="margin-top:8px;font-size:11px;color:var(--text3)">Pix: CPF ${D.config.pixKey}</div>
    </div>
  </div>`;

  // Players with debts
  const comDebito = D.jogadores
    .map(j=>({...j,debito:getTotalDebito(j)}))
    .sort((a,b)=>b.debito-a.debito);

  const devendo = comDebito.filter(j=>j.debito>0);
  const emDia = comDebito.filter(j=>j.debito<=0);

  if(devendo.length) {
    html += `<div class="section-header">EM DÉBITO</div><div class="card">`;
    html += devendo.map(j=>renderDebitoRow(j, isAdm)).join('');
    html += '</div>';
  }
  if(emDia.length) {
    html += `<div class="section-header">EM DIA</div><div class="card">`;
    html += emDia.map(j=>`
      <div class="debt-row">
        <div class="flex-row gap8">
          <div class="player-avatar sm">${j.foto?`<img src="${j.foto}"/>`:initials(j.nome)}</div>
          <span class="player-name">${escHtml(j.nome)}</span>
        </div>
        <span class="badge badge-green">✓ Em dia</span>
      </div>`).join('');
    html += '</div>';
  }

  s.innerHTML = html;
}

function renderDebitoRow(j, isAdm) {
  const debitos = (j.debitos||[]).filter(d=>!d.pago);
  return `<div class="debt-row" style="flex-wrap:wrap;gap:6px">
    <div class="flex-row gap8" style="flex:1">
      <div class="player-avatar sm">${j.foto?`<img src="${j.foto}"/>`:initials(j.nome)}</div>
      <div>
        <div class="player-name">${escHtml(j.nome)}</div>
        ${debitos.map(d=>`<div class="small">${escHtml(d.desc)} — ${fmtMoney(d.valor)} (${d.data||'—'})</div>`).join('')}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
      <span class="debt-amount red-text">${fmtMoney(j.debito)}</span>
      ${isAdm?`
        <div style="display:flex;gap:4px">
          <button class="btn btn-green btn-sm" style="padding:4px 8px;font-size:10px" onclick="darBaixaDebito('${j.id}')">💰 Dar baixa</button>
          <button class="btn btn-outline btn-sm" style="padding:4px 8px;font-size:10px" onclick="addDebito('${j.id}')">+ Débito</button>
        </div>`:''}
    </div>
  </div>`;
}

// ══════════════════════════════════════════
//  OPTIONS TAB
// ══════════════════════════════════════════
function renderOpcoes() {
  const s = document.getElementById('screen');
  const isAdm = isAdminUser();
  let html = `<div class="card"><div class="card-title">OPÇÕES</div>`;

  if(isAdm) {
    html += `<button class="btn btn-outline w100 mb" onclick="abrirRestricoesModal()">🚫 Restrições de time</button>`;
    html += `<div class="input-wrap mt12">
      <label>Aleatoriedade do sorteio (${D.config.aleatoriedade}%)</label>
      <input type="range" min="0" max="30" value="${D.config.aleatoriedade}" oninput="this.previousElementSibling.textContent='Aleatoriedade do sorteio ('+this.value+'%)';saveConfig({aleatoriedade:+this.value})"/>
    </div>`;
  } else {
    html += `<div style="font-size:12px;color:var(--text3)">Aleatoriedade: ${D.config.aleatoriedade}%</div>`;
  }

  html += `<div class="divider"></div>
    <button class="btn btn-outline w100 mt8" onclick="verRegras()">📋 Regulamento</button>`;

  if(isAdm) {
    html += `<div class="divider"></div><div class="section-header" style="padding:0;margin-bottom:8px">ADMINS</div>`;
    const admins = D.jogadores.filter(j=>j.isAdmin);
    html += admins.map(j=>`<div class="flex-between" style="padding:6px 0">
      <span class="player-name">${escHtml(j.nome)}</span>
      <button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="toggleAdmin('${j.id}',false)">Remover</button>
    </div>`).join('');
    const naoAdmins = D.jogadores.filter(j=>!j.isAdmin);
    if(naoAdmins.length) {
      html += `<div class="input-wrap mt8"><label>Promover admin</label><select id="promo-sel">
        <option value="">Selecionar...</option>
        ${naoAdmins.map(j=>`<option value="${j.id}">${escHtml(j.nome)}</option>`).join('')}
      </select></div>
      <button class="btn btn-outline btn-sm" onclick="promoverAdmin()">Promover</button>`;
    }
  }

  html += '</div>';
  s.innerHTML = html;
}

function abrirRestricoesModal() {
  const isAdm = isAdminUser();
  const r = D.restricoes;
  let html = `<div class="modal-title">🚫 Restrições</div>`;

  if(r.length) {
    html += r.map(x=>`<div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:12px">${x.tipo==='nunca'?'🚫':'🤝'} ${escHtml(x.a)} & ${escHtml(x.b)} ${x.permanent?'(perm.)':'(próx.)'}</span>
      ${isAdm?`<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="delRestricao('${x.id}')">✕</button>`:''}
    </div>`).join('');
  } else { html += `<div class="small" style="margin-bottom:12px">Nenhuma restrição definida.</div>`; }

  if(isAdm) {
    html += `<div class="divider"></div><div class="input-wrap"><label>Tipo</label>
      <select id="r-tipo"><option value="nunca">🚫 Nunca juntos</option><option value="sempre">🤝 Sempre juntos</option></select>
    </div>
    <div class="input-wrap"><label>Jogador A</label><select id="r-a"><option value="">—</option>
      ${D.jogadores.map(j=>`<option value="${j.nome}">${escHtml(j.nome)}</option>`).join('')}</select>
    </div>
    <div class="input-wrap"><label>Jogador B</label><select id="r-b"><option value="">—</option>
      ${D.jogadores.map(j=>`<option value="${j.nome}">${escHtml(j.nome)}</option>`).join('')}</select>
    </div>
    <div class="input-wrap"><label>Duração</label>
      <select id="r-perm"><option value="0">Só próxima pelada</option><option value="1">Permanente</option></select>
    </div>
    <button class="btn btn-gold" onclick="addRestricao()">ADICIONAR</button>`;
  }
  html += `<button class="btn btn-outline mt8" onclick="closeModals()">Fechar</button>`;
  modal(html);
}

async function addRestricao() {
  const tipo=document.getElementById('r-tipo').value;
  const a=document.getElementById('r-a').value;
  const b=document.getElementById('r-b').value;
  const perm=document.getElementById('r-perm').value==='1';
  if(!a||!b||a===b){toast('Selecione dois jogadores diferentes');return;}
  const id=genId();
  const r={id,tipo,a,b,permanent:perm};
  D.restricoes.push(r);
  if(db) await fbSet('restricoes/'+id,r); else LS.set('restricoes',D.restricoes);
  closeModals(); toast('Restrição adicionada');
}
async function delRestricao(id) {
  D.restricoes=D.restricoes.filter(x=>x.id!==id);
  if(db) await fbDel('restricoes/'+id); else LS.set('restricoes',D.restricoes);
  closeModals(); abrirRestricoesModal();
}

async function toggleAdmin(id, make) {
  const j=D.jogadores.find(x=>x.id===id); if(!j) return;
  await saveJogador({...j,isAdmin:make===undefined?!j.isAdmin:make});
  toast((make||!j.isAdmin)?'Admin adicionado':'Admin removido'); renderOpcoes();
}
async function promoverAdmin() {
  const id=document.getElementById('promo-sel')?.value; if(!id) return;
  await toggleAdmin(id,true);
}

function verRegras() {
  modal(`<div class="modal-title">📋 REGULAMENTO</div>
    <div style="font-size:12px;color:var(--text2);line-height:1.9">
      <strong class="gold-text">1. Desistência (1h30):</strong> Quem tirar o nome com menos de 1h30 para o início paga o valor integral, caso não haja substituto.<br><br>
      <strong class="gold-text">2. Desistência (3h):</strong> Retirar o nome com 3h ou menos, sem substituto, gera multa extra de R$5,00.<br><br>
      <strong class="gold-text">3. Substituto:</strong> Se houver substituto confirmado, o jogador que saiu não paga multa.<br><br>
      <strong class="gold-text">4. Chuva:</strong> A pelada acontece com chuva. Só cancela se ≥70% decidirem não jogar.<br><br>
      <strong class="gold-text">5. Convidados:</strong> Jogadores de fora são responsabilidade de quem trouxe. Se não pagar em 1 semana, quem trouxe assume.<br><br>
      <strong class="gold-text">6. Pênalti:</strong> Só em mão ou falta clara em chance de gol, com decisão unânime. Outras faltas viram lateral.<br><br>
      <strong class="gold-text">7. Laterais/Escanteios:</strong> Todos cobrados com a mão. Se pediu falta, o lance para.<br><br>
      <strong class="gold-text">8. Pagamento:</strong> Prazo de 4 dias após a pelada. Atraso: +R$2,00/semana.<br><br>
      <strong class="gold-text">9. Pelada:</strong> R$280 (quadra) ÷ número de jogadores. Com sobra, acumula para refrigerantes mensais.<br><br>
      <strong class="gold-text">10. 1ª partida:</strong> 10 min, sem limite de gol, pelos 2 primeiros times completos a chegar.<br><br>
      <strong class="gold-text">11. Demais partidas:</strong> 7 min ou 2 gols, o que ocorrer primeiro.<br><br>
      <em class="small">Estando na lista, você concorda com todas as regras.</em>
    </div>
    <button class="btn btn-outline mt8" onclick="closeModals()">Fechar</button>`);
}

// ══════════════════════════════════════════
//  PLAYER PROFILE
// ══════════════════════════════════════════
function abrirPerfil(id) {
  const j = D.jogadores.find(x=>x.id===id); if(!j) return;
  const isAdm = isAdminUser();
  const isMe = D.curUser?.id===id;
  const n = (j.domingos||[]).length;
  const if_val = calcIF(j);
  const stats = getStats(j);

  let html = `<div class="modal-title">${escHtml(j.nome)}</div>`;

  // Avatar
  const av = j.foto?`<img src="${j.foto}"/>`:initials(j.nome);
  html += `<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
    <div class="player-avatar" style="width:56px;height:56px;font-size:20px">${av}</div>
    <div>
      <div style="font-size:18px;font-weight:700">${escHtml(j.nome)}</div>
      <div class="small">${j.tipo==='avulso'?'Avulso':'Fixo'} · ${n} jogo${n!==1?'s':''}</div>
      ${j.isAdmin?'<span class="badge badge-gold">ADMIN</span>':''}
    </div>
  </div>`;

  // Rating
  html += `<div class="stat-grid" style="margin-bottom:16px">
    <div class="stat-box"><div class="val">${fmt2(if_val)}</div><div class="lbl">Rating</div></div>
    <div class="stat-box"><div class="val">${stats.gols}</div><div class="lbl">Gols</div></div>
    <div class="stat-box"><div class="val">${stats.assists}</div><div class="lbl">Assists</div></div>
    <div class="stat-box"><div class="val">${stats.vitorias}</div><div class="lbl">Vitórias</div></div>
    <div class="stat-box"><div class="val">${n}</div><div class="lbl">Jogos</div></div>
    <div class="stat-box"><div class="val">${fmt2(j.nota||5)}</div><div class="lbl">Nota</div></div>
  </div>`;

  // Admin actions
  if(isAdm && !isMe) {
    html += `<div class="divider"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0">
      <button class="btn btn-outline btn-sm" onclick="editarNota('${j.id}')">✏️ Nota (${fmt2(j.nota||5)})</button>
      <button class="btn btn-outline btn-sm" onclick="toggleAdmin('${j.id}')">
        ${j.isAdmin?'⬇️ Rem. admin':'⬆️ Dar admin'}</button>
      <button class="btn btn-outline btn-sm" onclick="addDebito('${j.id}')">+ Débito</button>
      <button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="confirmarDelJog('${j.id}')">🗑️ Remover</button>
    </div>`;
  }

  // Domingos history
  if((j.domingos||[]).length) {
    html += `<div class="divider"></div><div style="font-family:'Bebas Neue';font-size:14px;letter-spacing:1.5px;color:var(--text3);margin-bottom:8px">HISTÓRICO</div>`;
    html += [...(j.domingos||[])].reverse().map(d=>`
      <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-size:12px;font-weight:600">${d.data}</div>
          <div class="small">⚽${d.gols} 🅰️${d.assists} 🏆${d.vitorias}</div>
        </div>
        ${renderReacoes(d.data, j.id)}
        ${isAdm?`<button class="btn btn-outline btn-sm" style="color:var(--red);margin-left:4px" onclick="delDomingo('${j.id}','${d.data}')">✕</button>`:''}
      </div>`).join('');
  }

  html += `<button class="btn btn-outline mt8" onclick="closeModals()">Fechar</button>`;
  modal(html);
}

function renderReacoes(data, jogadorId) {
  const key = `${data}_${jogadorId}`;
  const curId = D.curUser?.id;
  const pelada = D.peladasHist.find(p=>p.data===data);
  const reacoes = pelada?.reacoes?.[key] || {};
  if(!Object.keys(reacoes).length && !curId) return '';
  let html = `<div class="reactions-row" style="flex:1;justify-content:center">`;
  EMOJIS.forEach(e=>{
    const quem = reacoes[e]||[];
    const mine = quem.includes(curId);
    if(quem.length||curId) {
      html += `<div class="reaction-btn ${mine?'mine':''}" onclick="toggleReacao('${data}','${jogadorId}','${e}')">
        ${e} <span class="cnt">${quem.length||''}</span>
      </div>`;
    }
  });
  return html + '</div>';
}

async function toggleReacao(data, jogadorId, emoji) {
  if(!D.curUser||D.curUser.isGuest) return;
  const pelada = D.peladasHist.find(p=>p.data===data);
  if(!pelada) return;
  const key = `${data}_${jogadorId}`;
  const reacoes = pelada.reacoes||{};
  const quem = reacoes[key]?.[emoji]||[];
  const uid = D.curUser.id;
  if(quem.includes(uid)) reacoes[key] = {...(reacoes[key]||{}), [emoji]: quem.filter(x=>x!==uid)};
  else reacoes[key] = {...(reacoes[key]||{}), [emoji]: [...quem, uid]};
  await updatePelada(pelada.id, {reacoes});
  closeModals(); abrirPelada(data);
}

function editarNota(id) {
  const j = D.jogadores.find(x=>x.id===id); if(!j) return;
  modal(`<div class="modal-title">✏️ Nota Opinativa</div>
    <div class="input-wrap"><label>Nota (0–10)</label>
      <input type="number" id="nota-val" min="0" max="10" step="0.1" value="${j.nota||5}"/>
    </div>
    <button class="btn btn-gold" onclick="salvarNota('${id}')">SALVAR</button>
    <button class="btn btn-outline mt8" onclick="closeModals()">Cancelar</button>`,'centered');
}
async function salvarNota(id) {
  const v = parseFloat(document.getElementById('nota-val').value);
  if(isNaN(v)||v<0||v>10){toast('Nota deve ser entre 0 e 10');return;}
  const j=D.jogadores.find(x=>x.id===id); if(!j) return;
  await saveJogador({...j,nota:Math.round(v*10)/10});
  closeModals(); toast('Nota salva ✓');
}

async function confirmarDelJog(id) {
  confirm('Remover este jogador? Isso apagará todo o histórico dele.', async()=>{
    await delJogador(id); toast('Jogador removido'); closeModals(); renderJogadores();
  }, 'REMOVER', 'btn-red');
}

async function delDomingo(jogId, data) {
  const j=D.jogadores.find(x=>x.id===jogId); if(!j) return;
  modal(`<div class="modal-title">🗑️ Remover domingo</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:16px">Remover registro de <strong>${data}</strong>?</p>
    <button class="btn btn-red" onclick="delDomingo1('${jogId}','${data}')">Remover só de ${escHtml(j.nome)}</button>
    <button class="btn btn-outline mt8" style="color:var(--red)" onclick="delDomingoTodos('${data}')">⚠️ Remover de TODOS</button>
    <button class="btn btn-outline mt8" onclick="closeModals()">Cancelar</button>`,'centered');
}
async function delDomingo1(id, data) {
  const j=D.jogadores.find(x=>x.id===id); if(!j) return;
  await saveJogador({...j, domingos:(j.domingos||[]).filter(d=>d.data!==data)});
  closeModals(); toast('Removido'); abrirPerfil(id);
}
async function delDomingoTodos(data) {
  for(const j of D.jogadores) {
    const novos=(j.domingos||[]).filter(d=>d.data!==data);
    if(novos.length!==(j.domingos||[]).length) await saveJogador({...j,domingos:novos});
  }
  closeModals(); toast('Removido de todos ✓');
}

// ══════════════════════════════════════════
//  CADASTRO DE JOGADOR
// ══════════════════════════════════════════
function abrirCadJogador(editId) {
  const j = editId ? D.jogadores.find(x=>x.id===editId) : null;
  modal(`<div class="modal-title">${j?'✏️ Editar':'+ Novo'} Jogador</div>
    <div class="input-wrap"><label>Nome</label>
      <input type="text" id="cad-nome" value="${escHtml(j?.nome||'')}" placeholder="Nome do jogador" autocapitalize="words"/></div>
    <div class="input-wrap"><label>Nota opinativa (0–10)</label>
      <input type="number" id="cad-nota" min="0" max="10" step="0.1" value="${j?.nota||5}"/></div>
    <div class="input-wrap"><label>Tipo</label>
      <select id="cad-tipo">
        <option value="fixo" ${j?.tipo!=='avulso'?'selected':''}>Fixo</option>
        <option value="avulso" ${j?.tipo==='avulso'?'selected':''}>Avulso</option>
      </select></div>
    <button class="btn btn-gold" onclick="salvarCadJogador('${editId||''}')">SALVAR</button>
    <button class="btn btn-outline mt8" onclick="closeModals()">Cancelar</button>`);
}

async function salvarCadJogador(editId) {
  const nome=document.getElementById('cad-nome').value.trim();
  const nota=parseFloat(document.getElementById('cad-nota').value)||5;
  const tipo=document.getElementById('cad-tipo').value;
  if(!nome){toast('Digite um nome');return;}
  const id=editId||genId();
  const existing = D.jogadores.find(x=>x.id===editId);
  const j={...(existing||{}), id, nome, nota:Math.round(nota*10)/10, tipo, domingos:existing?.domingos||[], debitos:existing?.debitos||[]};
  await saveJogador(j);
  closeModals(); toast(editId?'Salvo ✓':'Jogador cadastrado ✓'); renderJogadores();
}

// ══════════════════════════════════════════
//  FLOW — SORTEIO
// ══════════════════════════════════════════
let flowState = {};

function iniciarFlow() {
  // Check if there's a confirmed presence list
  const p = D.presenca;
  const confirmados = p?.confirmados||[];

  flowState = { step: 'data', presentes: confirmados.map(c=>c.id||c.nome), usandoLista: confirmados.length>=15 };
  abrirFlow('NOVA PELADA');
  renderFlow();
}

function abrirFlow(title) {
  document.getElementById('flow-title').textContent = title;
  document.getElementById('flow-screen').classList.add('open');
}

function fecharFlow() {
  document.getElementById('flow-screen').classList.remove('open');
  flowState = {};
}

function renderFlow() {
  const fc = document.getElementById('flow-content');
  const st = flowState.step;
  if(st==='data') renderFlowData(fc);
  else if(st==='sel') renderFlowSel(fc);
  else if(st==='times') renderFlowTimes(fc);
  else if(st==='partida') renderFlowPartida(fc);
  else if(st==='stats') renderFlowStats(fc);
  else if(st==='mvp') renderFlowMvp(fc);
  else if(st==='saving') fc.innerHTML=`<div class="empty">Salvando...<br><br>⏳</div>`;
}

function renderFlowData(fc) {
  const hoje = new Date();
  const dateStr = hoje.toLocaleDateString('pt-BR');
  fc.innerHTML = `<div class="card-title">DATA DA PELADA</div>
    <div class="input-wrap"><label>Data</label>
      <input type="text" id="fl-data" value="${dateStr}" placeholder="dd/mm/aaaa"/></div>
    <button class="btn btn-gold mt8" onclick="confirmarData()">CONTINUAR →</button>
    <button class="btn btn-outline mt8" onclick="fecharFlow()">Cancelar</button>`;
}

function confirmarData() {
  const data = document.getElementById('fl-data').value.trim();
  if(!data){toast('Informe a data');return;}
  flowState.data = data;
  if(flowState.usandoLista && flowState.presentes.length===15||flowState.presentes.length===20) {
    // Go straight to sort
    flowState.step='times';
    flowState.timesN = flowState.presentes.length===20?4:3;
    sortearTimes();
  } else {
    flowState.step='sel';
  }
  renderFlow();
}

function renderFlowSel(fc) {
  const all = [...D.jogadores].sort((a,b)=>a.nome?.localeCompare(b.nome));
  const sel = new Set(flowState.presentes||[]);
  const n = sel.size;
  const validSort = n===10||n===15||n===20;
  const validReg = n>0&&!validSort;

  let html=`<div class="card-title">SELECIONAR PRESENTES (${n})</div>
    <div style="max-height:55vh;overflow-y:auto;margin-bottom:12px">`;
  html += all.map(j=>{
    const checked=sel.has(j.id)||sel.has(j.nome);
    return `<div class="check-row" onclick="toggleSel('${j.id}')">
      <div class="check-box" id="chk-${j.id}" style="${checked?'background:var(--gold);border-color:var(--gold)':''}"></div>
      <div class="player-avatar sm">${j.foto?`<img src="${j.foto}"/>`:initials(j.nome)}</div>
      <span class="player-name">${escHtml(j.nome)}</span>
    </div>`;
  }).join('');
  html+=`</div>
    <button class="btn btn-gold" ${validSort?'':'disabled'} onclick="confirmarSel()">
      ⚽ SORTEAR TIMES ${validSort?`(${n} jogadores)`:`(precisa 10, 15 ou 20)`}
    </button>
    <button class="btn btn-outline mt8" ${validReg?'':'disabled'} onclick="registrarSemTimes()">
      📋 REGISTRAR SEM TIMES
    </button>
    <button class="btn btn-outline mt8" onclick="fecharFlow()">Cancelar</button>`;
  fc.innerHTML=html;
}

function toggleSel(id) {
  const sel = new Set(flowState.presentes||[]);
  if(sel.has(id)) sel.delete(id); else sel.add(id);
  flowState.presentes = [...sel];
  renderFlow();
}

function confirmarSel() {
  const n=flowState.presentes.length;
  flowState.timesN = n===20?4:n===15?3:2;
  flowState.step='times';
  sortearTimes();
  renderFlow();
}

function registrarSemTimes() {
  flowState.step='partida';
  flowState.semTimes=true;
  flowState.times=null;
  renderFlow();
}

function sortearTimes() {
  const ids=flowState.presentes;
  const nTimes=flowState.timesN||3;
  const jogs=ids.map(id=>D.jogadores.find(x=>x.id===id||x.nome===id)).filter(Boolean);
  const ranked=[...jogs].sort((a,b)=>calcIF(b)-calcIF(a));

  // Add noise
  const noise=D.config.aleatoriedade/100;
  const noisy=ranked.map(j=>({...j,_if:calcIF(j)*(1+(Math.random()*2-1)*noise)}));
  noisy.sort((a,b)=>b._if-a._if);

  // Apply restrictions
  const times=Array.from({length:nTimes},()=>[]);
  const order=[]; // snake
  for(let r=0;r<Math.ceil(noisy.length/nTimes);r++) {
    const row=Array.from({length:nTimes},(_,i)=>i);
    order.push(...(r%2===0?row:[...row].reverse()));
  }
  const placed=new Set();
  const playerList=[...noisy];

  order.slice(0,playerList.length).forEach((t,i)=>{
    if(playerList[i]) { times[t].push(playerList[i].nome||playerList[i].id); }
  });

  // Apply "sempre juntos" — swap if needed
  D.restricoes.filter(r=>r.tipo==='sempre').forEach(r=>{
    const ta=times.findIndex(t=>t.includes(r.a));
    const tb=times.findIndex(t=>t.includes(r.b));
    if(ta!==-1&&tb!==-1&&ta!==tb) {
      // Swap r.b to r.a's team (swap with someone)
      const idx=times[ta].length-1;
      const victm=times[ta][idx];
      times[ta]=times[ta].filter(x=>x!==victm);
      times[ta].push(r.b);
      times[tb]=times[tb].filter(x=>x!==r.b);
      times[tb].push(victm);
    }
  });

  // Apply "nunca juntos"
  D.restricoes.filter(r=>r.tipo==='nunca').forEach(r=>{
    const ta=times.findIndex(t=>t.includes(r.a));
    const tb=times.findIndex(t=>t.includes(r.b));
    if(ta===tb&&ta!==-1) {
      // Move r.b to a different team
      const alt=(ta+1)%nTimes;
      times[ta]=times[ta].filter(x=>x!==r.b);
      times[alt].push(r.b);
    }
  });

  const timesObj={};
  times.forEach((t,i)=>timesObj['time'+(i+1)]=t);
  flowState.times=timesObj;
}

function renderFlowTimes(fc) {
  const t=flowState.times;
  if(!t){fc.innerHTML=`<div class="empty">Erro no sorteio.</div>`;return;}
  let html=`<div class="card-title">TIMES SORTEADOS</div>`;
  Object.keys(t).sort().forEach((k,i)=>{
    html+=`<div class="team-card" style="border-color:${TIME_COLORS[i]||'var(--border2)'}">
      <div class="team-label" style="color:${TIME_COLORS[i]||'var(--gold)'}">TIME ${i+1}</div>
      ${(t[k]||[]).map(n=>`<div class="team-player">
        ${(()=>{const j=D.jogadores.find(x=>x.nome===n||x.id===n);return j?.foto?`<div class="player-avatar sm"><img src="${j.foto}"/></div>`:`<div class="player-avatar sm">${initials(j?.nome||n)}</div>`;})()}
        <span>${escHtml(D.jogadores.find(x=>x.nome===n||x.id===n)?.nome||n)}</span>
      </div>`).join('')}
    </div>`;
  });
  html+=`<div class="flex-row mt8 gap8">
    <button class="btn btn-outline" onclick="sortearTimes();renderFlow()" style="flex:1">🔀 Resortear</button>
    <button class="btn btn-gold" onclick="confirmarTimes()" style="flex:1">✓ CONFIRMAR</button>
  </div>
  <button class="btn btn-outline mt8 w100" onclick="fecharFlow()">Cancelar</button>`;
  fc.innerHTML=html;
}

async function confirmarTimes() {
  const s={status:'confirmado',times:flowState.times,data:flowState.data,ts:Date.now()};
  await saveSorteio(s);
  flowState.step='partida';
  renderFlow();
}

function renderFlowPartida(fc) {
  fc.innerHTML=`<div class="card-title">PARTIDA EM ANDAMENTO</div>
    <div style="text-align:center;font-size:48px;margin:24px 0">⚽</div>
    <div style="text-align:center;color:var(--text2);font-size:13px;margin-bottom:24px">${flowState.data}</div>
    <button class="btn btn-gold" onclick="flowState.step='stats';renderFlow()">✓ FINALIZAR E INSERIR STATS</button>
    <button class="btn btn-red mt8 w100" onclick="cancelarFlowPartida()">✕ CANCELAR PELADA</button>`;
}

async function cancelarFlowPartida() {
  confirm('Cancelar esta pelada? O sorteio será apagado.', async()=>{
    await saveSorteio({status:'cancelado',ts:Date.now()});
    await savePresenca(null);
    fecharFlow(); renderHome();
  },'CANCELAR PELADA','btn-red');
}

// STATS COLLECTION
let statsIdx=0;
let statsPresentes=[];
let statsCur={};

function renderFlowStats(fc) {
  const presentes=flowState.presentes||[];
  if(!statsPresentes.length) {
    statsPresentes = presentes.map(id=>D.jogadores.find(x=>x.id===id||x.nome===id)).filter(Boolean);
    statsIdx=0; statsCur={};
  }
  if(statsIdx>=statsPresentes.length) {
    salvarStats();
    return;
  }
  const j=statsPresentes[statsIdx];
  const timeNum=getTimeNum(j);
  const av=j.foto?`<img src="${j.foto}"/>`:initials(j.nome);
  fc.innerHTML=`<div class="flex-between" style="margin-bottom:16px">
    <div class="card-title" style="margin:0">${statsIdx+1}/${statsPresentes.length}</div>
    <div class="small">${timeNum?`Time ${timeNum}`:''}</div>
  </div>
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
    <div class="player-avatar" style="width:48px;height:48px;font-size:18px">${av}</div>
    <div class="player-name" style="font-size:16px">${escHtml(j.nome)}</div>
  </div>
  <div class="stat-grid" style="margin-bottom:20px">
    ${['gols','assists','vitorias'].map(k=>`
    <div class="stat-box">
      <div class="val" id="st-${k}">${statsCur[j.id]?.[k]||0}</div>
      <div class="lbl">${k==='gols'?'Gols':k==='assists'?'Assists':'Vitórias'}</div>
      <div style="display:flex;justify-content:center;gap:8px;margin-top:8px">
        <button onclick="changeVal('${j.id}','${k}',-1)" style="background:var(--bg);border:1px solid var(--border2);color:var(--text);border-radius:6px;width:32px;height:32px;font-size:18px;cursor:pointer">−</button>
        <button onclick="changeVal('${j.id}','${k}',1)" style="background:var(--gold);border:none;color:#000;border-radius:6px;width:32px;height:32px;font-size:18px;cursor:pointer;font-weight:700">+</button>
      </div>
    </div>`).join('')}
  </div>
  <button class="btn btn-gold" onclick="proxStats()">PRÓXIMO →</button>
  ${statsIdx>0?`<button class="btn btn-outline mt8 w100" onclick="statsIdx--;renderFlow()">← Anterior</button>`:''}`;
}

function changeVal(id, key, delta) {
  if(!statsCur[id]) statsCur[id]={gols:0,assists:0,vitorias:0};
  statsCur[id][key]=Math.max(0,(statsCur[id][key]||0)+delta);
  document.getElementById('st-'+key).textContent=statsCur[id][key];
}

function proxStats() {
  const j=statsPresentes[statsIdx];
  if(!statsCur[j.id]) statsCur[j.id]={gols:0,assists:0,vitorias:0};
  statsIdx++;
  if(statsIdx>=statsPresentes.length) {
    flowState.step='saving'; renderFlow();
    salvarStats();
  } else renderFlow();
}

function getTimeNum(j) {
  if(!flowState.times) return null;
  const keys=Object.keys(flowState.times).sort();
  for(let i=0;i<keys.length;i++) {
    if((flowState.times[keys[i]]||[]).some(n=>n===j.nome||n===j.id)) return i+1;
  }
  return null;
}

let _saving=false;
async function salvarStats() {
  if(_saving) return; _saving=true;
  const data=flowState.data;

  for(const j of statsPresentes) {
    const st=statsCur[j.id]||{gols:0,assists:0,vitorias:0};
    const novoDomingo={data, gols:st.gols, assists:st.assists, vitorias:st.vitorias};
    const domingos=[...(j.domingos||[])];
    // Avoid duplicate
    if(!domingos.find(d=>d.data===data)) domingos.push(novoDomingo);
    await saveJogador({...j, domingos});
  }

  // Save to peladasHist
  const existente=D.peladasHist.find(x=>x.data===data);
  if(!existente) {
    await addPelada({data, times:flowState.times||null, jogadores:statsPresentes.map(j=>j.id), mvp:null, votacao:{status:'aberta',votos:{}}, reacoes:{}});
  }

  // Clear presenca
  await savePresenca({...D.presenca, aberta:false});
  _saving=false;
  flowState.step='mvp';
  statsPresentes=[];statsCur={};statsIdx=0;
  renderFlow();
}

function renderFlowMvp(fc) {
  const data=flowState.data;
  const pelada=D.peladasHist.find(p=>p.data===data);
  const votos=pelada?.votacao?.votos||{};
  const status=pelada?.votacao?.status||'aberta';
  const curId=D.curUser?.id;
  const jeuVotou=curId&&Object.keys(votos).includes(curId);

  let html=`<div class="card-title">⭐ VOTAÇÃO MVP</div>
    <div class="small" style="margin-bottom:12px">${status==='aberta'?'Escolha o destaque da pelada:':'Votação encerrada.'}</div>`;

  if(status==='aberta'&&!jeuVotou) {
    html+=statsPresentes.length?
      (()=>{ const lst=[...D.jogadores].filter(j=>statsPresentes.some(x=>x.id===j.id)); return lst.map(j=>`
        <button class="btn btn-outline w100 mt8" onclick="votarMvp('${j.id}','${data}')">
          ${escHtml(j.nome)}</button>`).join(''); })()
      :`<div class="small">Carregando...</div>`;
  } else if(jeuVotou) {
    html+=`<div class="small green-text">✓ Você votou!</div>`;
  }

  // Contagem
  const contagem={};
  Object.values(votos).forEach(id=>contagem[id]=(contagem[id]||0)+1);
  const sorted=Object.entries(contagem).sort((a,b)=>b[1]-a[1]);
  if(sorted.length) {
    html+=`<div class="divider"></div>`;
    sorted.forEach(([id,n])=>{
      const j=D.jogadores.find(x=>x.id===id);
      html+=`<div class="flex-between" style="padding:6px 0"><span>${escHtml(j?.nome||id)}</span><span class="gold-text mono">${n} voto${n!==1?'s':''}</span></div>`;
    });
  }

  if(isAdminUser()) {
    html+=`<button class="btn btn-red mt8 w100" onclick="encerrarMvp('${data}')">⚡ ENCERRAR VOTAÇÃO</button>`;
  }
  html+=`<button class="btn btn-gold mt8 w100" onclick="fecharFlow();renderHome()">CONCLUIR ✓</button>`;
  fc.innerHTML=html;
}

async function votarMvp(jogId, data) {
  const p=D.peladasHist.find(x=>x.data===data); if(!p||!D.curUser) return;
  const votos={...p.votacao?.votos,[D.curUser.id]:jogId};
  await updatePelada(p.id,{votacao:{...p.votacao,votos}});
  renderFlow();
}

async function encerrarMvp(data) {
  const p=D.peladasHist.find(x=>x.data===data); if(!p) return;
  const votos=p.votacao?.votos||{};
  const contagem={};
  Object.values(votos).forEach(id=>contagem[id]=(contagem[id]||0)+1);
  const mvpId=Object.entries(contagem).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  await updatePelada(p.id,{mvp:mvpId,votacao:{...p.votacao,status:'encerrada'}});
  // Open presenca for next week
  await savePresenca({aberta:true, confirmados:[], espera:[], data:getProximaSegunda()});
  renderFlow(); toast('MVP definido! Lista de presença aberta ✓');
}

// ══════════════════════════════════════════
//  PRESENCE MANAGEMENT
// ══════════════════════════════════════════
async function confirmarPresenca() {
  const cur=D.curUser; if(!cur||cur.isGuest) return;
  const j=D.jogadores.find(x=>x.id===cur.id); if(!j) return;

  // Check inadimplência
  const inad=jogadorInadimplente(j);
  if(inad&&inad!=='mensalidade') { toast('Há débitos em aberto'); return; }

  let p=D.presenca||{aberta:true,confirmados:[],espera:[],data:getProximaSegunda()};
  const confirmados=p.confirmados||[];
  const espera=p.espera||[];
  const total=confirmados.length;
  const maxVagas=total>=20?20:15;

  const jaEsta=confirmados.find(x=>x.id===cur.id)||espera.find(x=>x.id===cur.id);
  if(jaEsta){toast('Você já está confirmado');return;}

  const entry={id:cur.id,nome:j.nome,pagou:j.tipo!=='avulso',ts:Date.now()};

  if(total<maxVagas) {
    p.confirmados=[...confirmados,entry];
    // Generate debt for avulso
    if(j.tipo==='avulso') {
      const dbt={id:genId(),desc:`Pelada ${p.data||''}`,valor:D.config.valorPelada,data:p.data||getProximaSegunda(),pago:false};
      await saveJogador({...j,debitos:[...(j.debitos||[]),dbt]});
    }
  } else {
    p.espera=[...espera,entry];
  }

  await savePresenca(p);
  toast('Presença confirmada ✓'); renderHome();
}

async function desmarcarPresenca() {
  const cur=D.curUser; if(!cur) return;
  const p=D.presenca; if(!p) return;

  const agora=Date.now();
  const pelada=new Date(); // approximate
  const horario=D.config.horario?.split('às')[0]?.trim()||'21:00';
  const [h,m]=(horario+'').split(':').map(Number);
  const pelHoje=new Date(); pelHoje.setHours(h,m,0,0);
  const diff=(pelHoje.getTime()-agora)/1000/60; // minutes

  const j=D.jogadores.find(x=>x.id===cur.id);
  let multa=0, descMulta='';
  if(diff<90&&diff>=0) { multa=D.config.multaDesistencia; descMulta='Desistência <1h30'; }
  else if(diff<180&&diff>=0) { multa=D.config.multaAviso3h; descMulta='Desistência <3h'; }

  const confirmados=(p.confirmados||[]).filter(x=>x.id!==cur.id);
  const espera=(p.espera||[]).filter(x=>x.id!==cur.id);

  // Promote from espera
  if(espera.length&&confirmados.length<15) {
    const prox=espera[0];
    confirmados.push(prox);
    espera.splice(0,1);
  }

  await savePresenca({...p,confirmados,espera});

  if(multa>0&&j) {
    const dbt={id:genId(),desc:descMulta,valor:multa,data:new Date().toLocaleDateString('pt-BR'),pago:false};
    await saveJogador({...j,debitos:[...(j.debitos||[]),dbt]});
    toast(`Presença removida. Multa de ${fmtMoney(multa)} aplicada.`,4000);
  } else {
    toast('Presença removida');
  }
  renderHome();
}

async function darBaixaPresenca(idOuNome) {
  const p=D.presenca; if(!p) return;
  const conf=[...(p.confirmados||[])];
  const idx=conf.findIndex(x=>x.id===idOuNome||x.nome===idOuNome);
  if(idx===-1) return;
  conf[idx]={...conf[idx],pagou:true};
  await savePresenca({...p,confirmados:conf});

  // Mark debt as paid
  const j=D.jogadores.find(x=>x.id===idOuNome||x.nome===idOuNome);
  if(j){
    const debitos=(j.debitos||[]).map(d=>!d.pago&&d.desc.startsWith('Pelada')?{...d,pago:true}:d);
    await saveJogador({...j,debitos});
  }
  toast('Pagamento registrado ✓'); renderHome();
}

function gerenciarPresenca() {
  const p=D.presenca||{confirmados:[],espera:[],data:getProximaSegunda()};
  const todos=[...D.jogadores].sort((a,b)=>a.nome?.localeCompare(b.nome));
  let html=`<div class="modal-title">⚙️ Gerenciar Presença</div>
    <div class="input-wrap"><label>Data</label><input type="text" id="gp-data" value="${p.data||''}"/></div>
    <div class="input-wrap"><label>Local</label><input type="text" id="gp-local" value="${D.config.local?.split('\n')[0]||''}"/></div>
    <button class="btn btn-outline btn-sm" onclick="salvarDadosPresenca()" style="margin-bottom:12px">Salvar dados</button>
    <div class="divider"></div>
    <div class="card-title">Adicionar jogador</div>
    <div class="flex-row gap8">
      <select id="gp-add" style="flex:1"><option value="">Selecionar...</option>
        ${todos.map(j=>`<option value="${j.id}">${escHtml(j.nome)}</option>`).join('')}
      </select>
      <button class="btn btn-gold btn-sm" onclick="adminAddPresenca('confirmado')">+ Conf.</button>
      <button class="btn btn-outline btn-sm" onclick="adminAddPresenca('espera')">+ Esp.</button>
    </div>
    <div class="divider"></div>
    <div class="card-title">Confirmados</div>`;

  (p.confirmados||[]).forEach(c=>{
    const j=D.jogadores.find(x=>x.id===c.id);
    const isAvulso=j?.tipo==='avulso';
    html+=`<div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:12px">${escHtml(c.nome)} ${isAvulso&&!c.pagou?'<span class="espera-tag">💰</span>':''}</span>
      <div style="display:flex;gap:4px">
        ${isAvulso&&!c.pagou?`<button class="btn btn-green btn-sm" style="padding:2px 6px;font-size:10px" onclick="darBaixaPresenca('${c.id||c.nome}');closeModals()">Pago</button>`:''}
        <button class="btn btn-outline btn-sm" style="color:var(--red);padding:2px 6px;font-size:10px" onclick="adminRemPresenca('${c.id||c.nome}','confirmado')">✕</button>
      </div>
    </div>`;
  });

  html+=`<div class="card-title mt12">Espera</div>`;
  (p.espera||[]).forEach(c=>{
    html+=`<div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:12px;color:var(--text3)">${escHtml(c.nome)}</span>
      <button class="btn btn-outline btn-sm" style="color:var(--red);padding:2px 6px;font-size:10px" onclick="adminRemPresenca('${c.id||c.nome}','espera')">✕</button>
    </div>`;
  });

  html+=`<button class="btn btn-outline mt8" onclick="closeModals()">Fechar</button>`;
  modal(html);
}

async function salvarDadosPresenca() {
  const data=document.getElementById('gp-data')?.value;
  const local=document.getElementById('gp-local')?.value;
  if(data) await savePresenca({...(D.presenca||{}),data});
  if(local) await saveConfig({local});
  toast('Dados salvos ✓');
}

async function adminAddPresenca(tipo) {
  const id=document.getElementById('gp-add')?.value; if(!id) return;
  const j=D.jogadores.find(x=>x.id===id); if(!j) return;
  const p=D.presenca||{aberta:true,confirmados:[],espera:[],data:getProximaSegunda()};
  const entry={id,nome:j.nome,pagou:j.tipo!=='avulso',ts:Date.now()};
  if(tipo==='confirmado') {
    if(!p.confirmados.find(x=>x.id===id)) p.confirmados=[...(p.confirmados||[]),entry];
    if(j.tipo==='avulso') {
      const dbt={id:genId(),desc:`Pelada ${p.data||''}`,valor:D.config.valorPelada,data:p.data||'',pago:false};
      await saveJogador({...j,debitos:[...(j.debitos||[]),dbt]});
    }
  } else {
    if(!p.espera.find(x=>x.id===id)) p.espera=[...(p.espera||[]),entry];
  }
  await savePresenca(p); closeModals(); gerenciarPresenca();
}

async function adminRemPresenca(idOuNome, lista) {
  const p=D.presenca; if(!p) return;
  if(lista==='confirmado') p.confirmados=(p.confirmados||[]).filter(x=>x.id!==idOuNome&&x.nome!==idOuNome);
  else p.espera=(p.espera||[]).filter(x=>x.id!==idOuNome&&x.nome!==idOuNome);
  await savePresenca(p); closeModals(); gerenciarPresenca();
}

async function cancelarSorteio() {
  confirm('Cancelar o sorteio atual?', async()=>{
    await saveSorteio({status:'cancelado',ts:Date.now()});
    toast('Sorteio cancelado'); renderHome();
  },'CANCELAR','btn-red');
}

function editarTimes() {
  const s=D.sorteio; if(!s?.times) return;
  const keys=Object.keys(s.times).sort();
  const allNomes=keys.flatMap(k=>s.times[k]);
  let html=`<div class="modal-title">✏️ Editar Times</div>`;
  keys.forEach((k,i)=>{
    html+=`<div class="card-title">${escHtml(k.replace('time','Time ').trim())} <span style="color:${TIME_COLORS[i]||'var(--gold)'}">●</span></div>`;
    html+=(s.times[k]||[]).map(nome=>`
      <div class="flex-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:12px">${escHtml(nome)}</span>
        <select onchange="moverJogador('${nome}','${k}',this.value)" style="font-size:11px;padding:3px;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px">
          ${keys.map(k2=>`<option value="${k2}" ${k2===k?'selected':''}>${k2.replace('time','Time ')}</option>`).join('')}
        </select>
      </div>`).join('');
  });
  html+=`<button class="btn btn-outline mt8 w100" onclick="closeModals()">Fechar</button>`;
  modal(html);
}

async function moverJogador(nome, deTime, paraTime) {
  if(deTime===paraTime) return;
  const s=D.sorteio; if(!s?.times) return;
  const times={...s.times};
  times[deTime]=(times[deTime]||[]).filter(n=>n!==nome);
  times[paraTime]=[...(times[paraTime]||[]),nome];
  await saveSorteio({...s,times});
  toast('Time atualizado'); closeModals(); editarTimes();
}

// ══════════════════════════════════════════
//  PELADA DETAIL
// ══════════════════════════════════════════
function abrirPelada(data) {
  const p=D.peladasHist.find(x=>x.data===data);
  const jogNaData=D.jogadores.filter(j=>(j.domingos||[]).some(d=>d.data===data));
  const isAdm=isAdminUser();

  // Compute stats
  const stats=jogNaData.map(j=>{
    const d=(j.domingos||[]).find(x=>x.data===data)||{gols:0,assists:0,vitorias:0};
    return {...j,...d};
  }).sort((a,b)=>(b.gols+b.assists)-(a.gols+a.assists));

  const mvpId=p?.mvp;
  const mvpJ=mvpId?D.jogadores.find(x=>x.id===mvpId):null;

  let html=`<div class="modal-title">Pelada ${data}</div>`;
  if(mvpJ) html+=`<div style="text-align:center;margin-bottom:12px">⭐ <strong class="gold-text">MVP: ${escHtml(mvpJ.nome)}</strong></div>`;

  // MVP voting
  const vol=p?.votacao; const curId=D.curUser?.id;
  if(vol?.status==='aberta'&&curId&&!vol.votos?.[curId]) {
    html+=`<div class="small" style="margin-bottom:8px">Vote no MVP:</div>`;
    html+=jogNaData.map(j=>`<button class="btn btn-outline btn-sm w100 mt8" onclick="votarMvp('${j.id}','${data}');closeModals()">⭐ ${escHtml(j.nome)}</button>`).join('');
    if(isAdm) html+=`<button class="btn btn-red btn-sm w100 mt8" onclick="encerrarMvp('${data}');closeModals()">⚡ Encerrar votação</button>`;
    html+=`<div class="divider"></div>`;
  }

  // Stats table
  html+=`<div class="stat-grid" style="grid-template-columns:2fr 1fr 1fr 1fr;gap:4px;margin-bottom:12px">
    <div style="font-size:10px;color:var(--text3);padding:4px">Jogador</div>
    <div style="font-size:10px;color:var(--text3);text-align:center;padding:4px">⚽</div>
    <div style="font-size:10px;color:var(--text3);text-align:center;padding:4px">🅰️</div>
    <div style="font-size:10px;color:var(--text3);text-align:center;padding:4px">🏆</div>
  </div>`;
  stats.forEach(j=>{
    html+=`<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:4px;padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:12px;font-weight:600">${escHtml(j.nome)}</div>
      <div style="text-align:center;font-family:'JetBrains Mono',monospace;font-size:12px">${j.gols||0}</div>
      <div style="text-align:center;font-family:'JetBrains Mono',monospace;font-size:12px">${j.assists||0}</div>
      <div style="text-align:center;font-family:'JetBrains Mono',monospace;font-size:12px">${j.vitorias||0}</div>
    </div>
    ${renderReacoes(data,j.id)}`;
  });

  if(isAdm) html+=`<button class="btn btn-outline mt8 w100" style="color:var(--red)" onclick="confirmarDelPelada('${data}');closeModals()">🗑️ Excluir pelada</button>`;
  html+=`<button class="btn btn-outline mt8 w100" onclick="closeModals()">Fechar</button>`;
  modal(html);
}

function confirmarDelPelada(data) {
  confirm(`Excluir a pelada de ${data}? Isso removerá as estatísticas de todos os jogadores.`, async()=>{
    const p=D.peladasHist.find(x=>x.data===data);
    if(p) await delPelada(p.id);
    for(const j of D.jogadores) {
      const novos=(j.domingos||[]).filter(d=>d.data!==data);
      if(novos.length!==(j.domingos||[]).length) await saveJogador({...j,domingos:novos});
    }
    toast('Pelada excluída'); renderHome();
  },'EXCLUIR','btn-red');
}

// ══════════════════════════════════════════
//  FINANCES MODALS
// ══════════════════════════════════════════
function darBaixaDebito(id) {
  const j=D.jogadores.find(x=>x.id===id); if(!j) return;
  const abertos=(j.debitos||[]).filter(d=>!d.pago);
  if(!abertos.length){toast('Sem débitos em aberto');return;}
  let html=`<div class="modal-title">💰 Dar baixa</div>
    <div class="input-wrap"><label>Débito</label>
      <select id="db-sel">
        ${abertos.map(d=>`<option value="${d.id}">${escHtml(d.desc)} — ${fmtMoney(d.valor)} (${d.data||'—'})</option>`).join('')}
      </select></div>
    <div class="input-wrap"><label>Data do pagamento</label>
      <input type="date" id="db-data" value="${new Date().toISOString().split('T')[0]}"/></div>
    <button class="btn btn-gold" onclick="confirmarBaixa('${id}')">CONFIRMAR</button>
    <button class="btn btn-outline mt8" onclick="closeModals()">Cancelar</button>`;
  modal(html,'centered');
}

async function confirmarBaixa(jogId) {
  const j=D.jogadores.find(x=>x.id===jogId); if(!j) return;
  const selId=document.getElementById('db-sel')?.value;
  const dataPag=document.getElementById('db-data')?.value;
  const debitos=(j.debitos||[]).map(d=>d.id===selId?{...d,pago:true,dataPag}:d);
  await saveJogador({...j,debitos});
  closeModals(); toast('Baixa registrada ✓'); renderFinancas();
}

function addDebito(id) {
  const j=D.jogadores.find(x=>x.id===id); if(!j) return;
  modal(`<div class="modal-title">+ Novo Débito — ${escHtml(j.nome)}</div>
    <div class="input-wrap"><label>Descrição</label><input type="text" id="nd-desc" placeholder="Ex: Multa, colete..."/></div>
    <div class="input-wrap"><label>Valor (R$)</label><input type="number" id="nd-val" min="0" step="0.01" value="${D.config.valorPelada}"/></div>
    <div class="input-wrap"><label>Data</label><input type="date" id="nd-data" value="${new Date().toISOString().split('T')[0]}"/></div>
    <button class="btn btn-gold" onclick="salvarDebito('${id}')">SALVAR</button>
    <button class="btn btn-outline mt8" onclick="closeModals()">Cancelar</button>`,'centered');
}

async function salvarDebito(id) {
  const j=D.jogadores.find(x=>x.id===id); if(!j) return;
  const desc=document.getElementById('nd-desc')?.value.trim();
  const val=parseFloat(document.getElementById('nd-val')?.value)||0;
  const data=document.getElementById('nd-data')?.value;
  if(!desc||!val){toast('Preencha descrição e valor');return;}
  const d={id:genId(),desc,valor:val,data:data?new Date(data+'T12:00').toLocaleDateString('pt-BR'):'',pago:false};
  await saveJogador({...j,debitos:[...(j.debitos||[]),d]});
  closeModals(); toast('Débito adicionado ✓'); renderFinancas();
}

function abrirConfigValores() {
  modal(`<div class="modal-title">⚙️ Valores</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="input-wrap"><label>Pelada (R$)</label><input type="number" id="cv-pelada" value="${D.config.valorPelada}" step="0.01"/></div>
      <div class="input-wrap"><label>Multa desist. (R$)</label><input type="number" id="cv-multa" value="${D.config.multaDesistencia}" step="0.01"/></div>
      <div class="input-wrap"><label>Multa 3h (R$)</label><input type="number" id="cv-m3h" value="${D.config.multaAviso3h}" step="0.01"/></div>
      <div class="input-wrap"><label>Atraso/sem. (R$)</label><input type="number" id="cv-atraso" value="${D.config.multaAtraso}" step="0.01"/></div>
    </div>
    <button class="btn btn-gold" onclick="salvarConfigValores()">SALVAR</button>
    <button class="btn btn-outline mt8" onclick="closeModals()">Cancelar</button>`,'centered');
}

async function salvarConfigValores() {
  const c={
    valorPelada: parseFloat(document.getElementById('cv-pelada')?.value)||20,
    multaDesistencia: parseFloat(document.getElementById('cv-multa')?.value)||20,
    multaAviso3h: parseFloat(document.getElementById('cv-m3h')?.value)||5,
    multaAtraso: parseFloat(document.getElementById('cv-atraso')?.value)||2
  };
  await saveConfig(c); closeModals(); toast('Valores salvos ✓'); renderFinancas();
}

// ══════════════════════════════════════════
//  COMUNICADOS
// ══════════════════════════════════════════
function novoComunicado() {
  modal(`<div class="modal-title">📢 Novo Comunicado</div>
    <div class="input-wrap"><label>Título</label><input type="text" id="com-titulo" placeholder="Assunto..."/></div>
    <div class="input-wrap"><label>Mensagem</label><textarea id="com-corpo" rows="4" style="resize:none" placeholder="Digite aqui..."></textarea></div>
    <button class="btn btn-gold" onclick="publicarComunicado()">PUBLICAR</button>
    <button class="btn btn-outline mt8" onclick="closeModals()">Cancelar</button>`);
}

async function publicarComunicado() {
  const titulo=document.getElementById('com-titulo')?.value.trim();
  const corpo=document.getElementById('com-corpo')?.value.trim();
  if(!titulo||!corpo){toast('Preencha título e mensagem');return;}
  const id=genId();
  const c={id,titulo,corpo,autor:D.curUser?.nome||'Admin',data:new Date().toLocaleDateString('pt-BR'),ts:Date.now()};
  D.comunicados.unshift(c);
  if(db) await fbSet('comunicados/'+id,c); else LS.set('comunicados',D.comunicados);
  closeModals(); toast('Comunicado publicado ✓'); renderHome();
}

async function delComunicado(id) {
  D.comunicados=D.comunicados.filter(x=>x.id!==id);
  if(db) await fbDel('comunicados/'+id); else LS.set('comunicados',D.comunicados);
  renderHome();
}

// ══════════════════════════════════════════
//  MATH / INDEX
// ══════════════════════════════════════════
// Alpha table: diminui com o tempo (nota perde peso conforme acumulam dados)
function alpha(n) {
  const table=[1,0.9,0.8,0.75,0.65,0.6,0.55,0.5,0.48,0.45,0.42,0.40,0.38,0.36,0.34,0.32,0.30,0.29,0.28,0.26,0.25];
  if(n<=0) return 1.0;
  if(n>=table.length) return table[table.length-1];
  // Interpolate
  const lo=table[Math.floor(n)]||table[table.length-1];
  const hi=table[Math.ceil(n)]||lo;
  return lo+(hi-lo)*(n%1);
}

function calcIF(j) {
  const domingos=j.domingos||[];
  const n=domingos.length;
  const nota=normalizeNota(j.nota||5);

  if(n===0) return nota*10;

  // Score per sunday
  const scores=domingos.map(d=>(d.gols||0)+(d.assists||0)+0.75*(d.vitorias||0));
  const sAcum=scores.reduce((a,b)=>a+b,0)/n;

  // Group average for shrinkage
  const allScores=D.jogadores.flatMap(x=>(x.domingos||[]).map(d=>(d.gols||0)+(d.assists||0)+0.75*(d.vitorias||0)));
  const sGrp=allScores.length?allScores.reduce((a,b)=>a+b,0)/allScores.length:0;

  // Bayesian shrinkage k=5
  const sAdj=(n*sAcum+5*sGrp)/(n+5);

  // Normalize both to 0-1
  const maxS=Math.max(...D.jogadores.map(jj=>{
    const ns=(jj.domingos||[]).length;
    const sc=ns?(jj.domingos||[]).reduce((a,d)=>a+(d.gols||0)+(d.assists||0)+0.75*(d.vitorias||0),0)/ns:0;
    const g=allScores.length?allScores.reduce((a,b)=>a+b,0)/allScores.length:0;
    return (ns*sc+5*g)/(ns+5);
  }),0.01);

  const sNorm=Math.min(sAdj/maxS,1);
  const a=alpha(n);
  const IF=(a*nota+(1-a)*sNorm);
  return Math.min(IF*10,10);
}

function normalizeNota(nota) {
  return Math.min(Math.max((nota||5)/10,0),1);
}

function getStats(j) {
  const domingos=j.domingos||[];
  return {
    gols:domingos.reduce((a,d)=>a+(d.gols||0),0),
    assists:domingos.reduce((a,d)=>a+(d.assists||0),0),
    vitorias:domingos.reduce((a,d)=>a+(d.vitorias||0),0)
  };
}

// ══════════════════════════════════════════
//  FINANCES HELPERS
// ══════════════════════════════════════════
function getTotalDebito(j) {
  const hoje=new Date(); hoje.setHours(0,0,0,0);
  const prazo=getProximoPrazo();
  return (j.debitos||[]).filter(d=>{
    if(d.pago) return false;
    return true;
  }).reduce((a,d)=>a+(d.valor||0),0);
}

function jogadorInadimplente(j) {
  const debitos=(j.debitos||[]).filter(d=>!d.pago);
  if(!debitos.length) return false;
  // Check if any non-mensalidade debt or mensalidade past due
  const hoje=new Date(); hoje.setHours(0,0,0,0);
  const prazo=getProximoPrazo();
  for(const d of debitos) {
    if(d.tipo==='mensalidade'&&hoje<=prazo) return 'mensalidade'; // not yet due
    return true; // any other debt blocks
  }
  return false;
}

// ══════════════════════════════════════════
//  DATE HELPERS
// ══════════════════════════════════════════
function getProximaSegunda() {
  const hoje=new Date();
  const dia=hoje.getDay();
  const diff=(1-dia+7)%7||7;
  const seg=new Date(hoje); seg.setDate(hoje.getDate()+diff);
  return seg.toLocaleDateString('pt-BR');
}

function getProximoSabado12h() {
  const hoje=new Date();
  const dia=hoje.getDay();
  const diff=(6-dia+7)%7||7;
  const sab=new Date(hoje); sab.setDate(hoje.getDate()+diff); sab.setHours(12,0,0,0);
  return sab;
}

// ══════════════════════════════════════════
//  SECURITY
// ══════════════════════════════════════════
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════
//  GLOBAL EXPORTS
// ══════════════════════════════════════════
Object.assign(window, {
  loginStep, entrarSemConta, saveFirebase, useLocal,
  goTab, toggleFloatMenu, verPerfil, sairDaConta,
  abrirUploadFoto, abrirMudarSenha, confirmarMudarSenha,
  renderHome, renderJogadores, renderRanking, renderFinancas, renderOpcoes,
  abrirPerfil, editarNota, salvarNota, confirmarDelJog, delDomingo, delDomingo1, delDomingoTodos,
  abrirCadJogador, salvarCadJogador,
  iniciarFlow, fecharFlow, confirmarData, toggleSel, confirmarSel, registrarSemTimes,
  confirmarTimes, cancelarFlowPartida, proxStats, changeVal, votarMvp, encerrarMvp,
  confirmarPresenca, desmarcarPresenca, darBaixaPresenca, gerenciarPresenca,
  salvarDadosPresenca, adminAddPresenca, adminRemPresenca, cancelarSorteio, editarTimes, moverJogador,
  abrirPelada, confirmarDelPelada, toggleReacao,
  darBaixaDebito, confirmarBaixa, addDebito, salvarDebito, abrirConfigValores, salvarConfigValores,
  novoComunicado, publicarComunicado, delComunicado,
  verRegras, abrirRestricoesModal, addRestricao, delRestricao, toggleAdmin, promoverAdmin,
  closeModals, sortearTimes, renderFlow,
  _confirmYes: ()=>{}
});

// ── BOOT ──
boot();
