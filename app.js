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
