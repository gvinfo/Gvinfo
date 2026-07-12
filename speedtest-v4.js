(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const startBtn = byId('startSpeedTest');
  if (!startBtn) return;

  const ui = {
    status: byId('speedStatus'), value: byId('speedValue'), download: byId('downloadMetric'),
    upload: byId('uploadMetric'), ping: byId('pingMetric'), jitter: byId('jitterMetric'),
    stability: byId('stabilityMetric'), diagnosis: byId('speedDiagnosis'),
    gauge: document.querySelector('.gauge'), canvas: byId('speedChart')
  };
  const ctx = ui.canvas ? ui.canvas.getContext('2d') : null;
  const DOWN = 'https://speed.cloudflare.com/__down';
  const UP = 'https://speed.cloudflare.com/__up';
  const VERSION = '4.1';
  let running = false;
  let runToken = 0;
  let samples = [];
  let controllers = new Set();

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const median = (arr) => {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const mbpsText = (v) => !Number.isFinite(v) || v <= 0 ? '--' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);

  function setStatus(text) { ui.status.textContent = `${text} · v${VERSION}`; }
  function setGauge(v) {
    const value = Number.isFinite(v) ? Math.max(0, v) : 0;
    const n = Math.log10(value + 1) / Math.log10(1001);
    if (ui.gauge) {
      ui.gauge.style.setProperty('--percent', `${clamp(n * 37.5, 0, 37.5)}%`);
      ui.gauge.style.setProperty('--angle', `${-130 + clamp(n, 0, 1) * 260}deg`);
    }
    ui.value.textContent = value ? mbpsText(value) : '0';
  }

  function drawChart() {
    if (!ctx || !ui.canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(300, ui.canvas.getBoundingClientRect().width || 900);
    const height = Math.max(180, Math.min(300, width * .3));
    ui.canvas.width = Math.round(width * dpr);
    ui.canvas.height = Math.round(height * dpr);
    ui.canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(167,207,43,.10)';
    for (let i = 1; i < 5; i++) {
      const y = height * i / 5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    if (samples.length < 2) return;
    const max = Math.max(10, ...samples) * 1.15;
    const pts = samples.map((v, i) => ({ x: i * width / Math.max(samples.length - 1, 1), y: height - 12 - v / max * (height - 28) }));
    const fill = ctx.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, 'rgba(184,234,54,.30)'); fill.addColorStop(1, 'rgba(184,234,54,0)');
    ctx.beginPath(); ctx.moveTo(pts[0].x, height); pts.forEach(p => ctx.lineTo(p.x, p.y)); ctx.lineTo(pts.at(-1).x, height); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = '#b8ea36'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  }

  function abortAll() {
    for (const c of controllers) { try { c.abort(); } catch (_) {} }
    controllers.clear();
  }

  async function fetchTimed(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await Promise.race([
        fetch(url, { ...options, signal: controller.signal, cache: 'no-store', mode: 'cors' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo limite')), timeoutMs + 250))
      ]);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function latencyTest(token) {
    const times = [];
    for (let i = 0; i < 5; i++) {
      if (token !== runToken) throw new Error('Cancelado');
      const t0 = performance.now();
      try {
        const r = await fetchTimed(`${DOWN}?bytes=1&cache=${Date.now()}-${i}`, {}, 3500);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await Promise.race([r.arrayBuffer(), new Promise((_, reject) => setTimeout(() => reject(new Error('Corpo travado')), 3500))]);
        times.push(performance.now() - t0);
      } catch (_) {}
      await sleep(80);
    }
    if (times.length < 2) throw new Error('Servidor de latência indisponível');
    const ping = median(times);
    const deltas = times.slice(1).map((v, i) => Math.abs(v - times[i]));
    return { ping, jitter: median(deltas) };
  }

  async function downloadOnce(bytes, token, onSample) {
    const controller = new AbortController();
    controllers.add(controller);
    const hardTimer = setTimeout(() => controller.abort(), 12000);
    const t0 = performance.now();
    let received = 0, lastBytes = 0, lastTime = t0;
    try {
      const response = await Promise.race([
        fetch(`${DOWN}?bytes=${bytes}&cache=${Date.now()}-${Math.random()}`, { signal: controller.signal, cache: 'no-store', mode: 'cors' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Sem resposta')), 9000))
      ]);
      if (!response.ok || !response.body) throw new Error('Download indisponível');
      const reader = response.body.getReader();
      while (true) {
        if (token !== runToken) throw new Error('Cancelado');
        const part = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Transferência parada')), 5000))
        ]);
        if (part.done) break;
        received += part.value.byteLength;
        const now = performance.now();
        if (now - lastTime >= 300) {
          const speed = ((received - lastBytes) * 8) / ((now - lastTime) / 1000) / 1e6;
          if (Number.isFinite(speed) && speed > 0) onSample(speed);
          lastBytes = received; lastTime = now;
        }
      }
      return { bytes: received, seconds: Math.max((performance.now() - t0) / 1000, .1) };
    } finally {
      clearTimeout(hardTimer); controllers.delete(controller);
    }
  }

  async function downloadTest(token) {
    setStatus('Medindo download'); samples = []; drawChart();
    const recent = [];
    const onSample = (v) => {
      recent.push(v); if (recent.length > 6) recent.shift();
      const smooth = median(recent); samples.push(smooth); if (samples.length > 50) samples.shift();
      setGauge(smooth); ui.download.textContent = `${mbpsText(smooth)} Mbps`; drawChart();
    };
    const results = await Promise.allSettled([
      downloadOnce(4_000_000, token, onSample),
      downloadOnce(4_000_000, token, onSample)
    ]);
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!ok.length) throw new Error('Servidor de download bloqueado');
    const total = ok.reduce((s, r) => s + r.bytes, 0);
    const sec = Math.max(...ok.map(r => r.seconds), .1);
    const value = total * 8 / sec / 1e6;
    samples.push(value); setGauge(value); drawChart(); return value;
  }

  async function uploadTest(download, token) {
    setStatus('Medindo upload');
    const bytes = download > 100 ? 1_000_000 : 500_000;
    const payload = new Uint8Array(bytes); // conteúdo zerado evita travamento do crypto em alguns aparelhos
    const t0 = performance.now();
    const r = await fetchTimed(`${UP}?cache=${Date.now()}`, { method: 'POST', body: payload }, 9000);
    if (token !== runToken || !r.ok) throw new Error('Upload indisponível');
    return bytes * 8 / Math.max((performance.now() - t0) / 1000, .1) / 1e6;
  }

  function stability() {
    if (samples.length < 4) return 'Boa';
    const mean = avg(samples); const variance = avg(samples.map(v => (v - mean) ** 2)); const cv = Math.sqrt(variance) / Math.max(mean, 1);
    return cv < .16 ? 'Ótima' : cv < .30 ? 'Boa' : cv < .48 ? 'Regular' : 'Instável';
  }

  function finishButton() {
    running = false; startBtn.disabled = false; startBtn.textContent = 'Testar novamente';
  }

  async function run() {
    if (running) return;
    running = true; const token = ++runToken;
    startBtn.disabled = true; startBtn.textContent = 'Testando...';
    ['download','upload','ping','jitter'].forEach(k => ui[k].textContent = k === 'ping' || k === 'jitter' ? '-- ms' : '-- Mbps');
    ui.stability.textContent = '--'; ui.diagnosis.className = 'speed-diagnosis'; ui.diagnosis.textContent = 'Teste iniciado. Etapa atual aparece acima do velocímetro.'; setGauge(0);

    // Este watchdog altera a interface diretamente e não depende das requisições terminarem.
    const watchdog = setTimeout(() => {
      if (token !== runToken || !running) return;
      runToken++; abortAll(); setStatus('Teste interrompido por tempo limite');
      ui.diagnosis.className = 'speed-diagnosis bad';
      ui.diagnosis.innerHTML = 'O servidor externo não respondeu. A tela foi liberada automaticamente. Atualize a página com <strong>Ctrl + F5</strong> e tente novamente.';
      finishButton();
    }, 35000);

    try {
      setStatus('Medindo latência');
      const lat = await latencyTest(token); if (token !== runToken) return;
      ui.ping.textContent = `${Math.round(lat.ping)} ms`; ui.jitter.textContent = `${lat.jitter.toFixed(1)} ms`;
      const down = await downloadTest(token); if (token !== runToken) return;
      ui.download.textContent = `${mbpsText(down)} Mbps`;
      let up = null;
      try { up = await uploadTest(down, token); if (token !== runToken) return; ui.upload.textContent = `${mbpsText(up)} Mbps`; }
      catch (_) { ui.upload.textContent = 'Indisponível'; }
      const st = stability(); ui.stability.textContent = st; setStatus(up === null ? 'Concluído parcialmente' : 'Teste concluído');
      ui.diagnosis.className = 'speed-diagnosis good';
      ui.diagnosis.innerHTML = `<strong>${mbpsText(down)} Mbps</strong> de download · <strong>${up === null ? 'upload indisponível' : mbpsText(up) + ' Mbps'}</strong> · <strong>${Math.round(lat.ping)} ms</strong> de ping.`;
    } catch (e) {
      if (token !== runToken) return;
      console.error(e); setStatus('Não foi possível concluir');
      ui.diagnosis.className = 'speed-diagnosis bad';
      ui.diagnosis.innerHTML = `Falha na etapa atual: <strong>${String(e.message || e)}</strong>. A tela foi liberada e você pode tentar novamente.`;
    } finally {
      if (token === runToken) { clearTimeout(watchdog); abortAll(); finishButton(); }
    }
  }

  startBtn.addEventListener('click', run);
  window.addEventListener('resize', drawChart);
  setStatus('Pronto para iniciar'); setGauge(0); drawChart();
})();
