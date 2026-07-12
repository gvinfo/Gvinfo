(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const startBtn = $('startSpeedTest');
  if (!startBtn) return;

  const ui = {
    shell: startBtn.closest('.speedtest-shell') || startBtn.closest('.speed-card'),
    status: $('speedStatus'),
    value: $('speedValue'),
    unit: $('speedUnit'),
    live: $('speedLiveLabel'),
    download: $('downloadMetric'),
    upload: $('uploadMetric'),
    ping: $('pingMetric'),
    jitter: $('jitterMetric'),
    stability: $('stabilityMetric'),
    diagnosis: $('speedDiagnosis'),
    chartWrap: $('speedChartWrap'),
    canvas: $('speedChart'),
    dial: $('dialProgress'),
    gauge: document.querySelector('.gauge'),
    rerun: $('rerunSpeedTest')
  };

  const VERSION = '5.0';
  const DOWN = 'https://speed.cloudflare.com/__down';
  const UP = 'https://speed.cloudflare.com/__up';
  const ctx = ui.canvas ? ui.canvas.getContext('2d') : null;
  const DIAL_LENGTH = 1043;
  let running = false;
  let runId = 0;
  let samples = [];
  const activeXhrs = new Set();

  const safeText = (el, text) => { if (el) el.textContent = text; };
  const safeClass = (el, value) => { if (el) el.className = value; };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const average = (a) => a.length ? a.reduce((s, n) => s + n, 0) / a.length : 0;
  const median = (a) => {
    if (!a.length) return 0;
    const sorted = [...a].sort((x, y) => x - y);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const formatSpeed = (v) => !Number.isFinite(v) || v <= 0 ? '--' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);

  function setStatus(text) {
    safeText(ui.status, `${text} · v${VERSION}`);
  }

  function setButtonState(testing) {
    startBtn.disabled = testing;
    const label = startBtn.querySelector('.go-label');
    const strong = startBtn.querySelector('strong');
    const small = startBtn.querySelector('small');

    if (label && strong && small) {
      safeText(label, testing ? 'AGUARDE' : 'INICIAR');
      if (testing) {
        safeText(strong, '...');
        safeText(small, 'TESTANDO');
      } else {
        safeText(strong, 'GO');
        safeText(small, 'TESTE');
      }
    } else {
      safeText(startBtn, testing ? 'Testando...' : 'Iniciar teste');
    }

    if (ui.shell) ui.shell.classList.toggle('is-testing', testing);
  }

  function updateGauge(speed) {
    const value = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    const ratio = clamp(Math.log10(value + 1) / Math.log10(1001), 0, 1);

    if (ui.gauge) {
      ui.gauge.style.setProperty('--percent', `${ratio * 37.5}%`);
      ui.gauge.style.setProperty('--angle', `${-130 + ratio * 260}deg`);
    }
    if (ui.dial) ui.dial.style.strokeDashoffset = String(DIAL_LENGTH * (1 - ratio));

    if (ui.value) safeText(ui.value, value > 0 ? formatSpeed(value) : (startBtn.querySelector('.go-label') ? 'GO' : '0'));
    if (ui.unit && value > 0) safeText(ui.unit, 'MBPS');
  }

  function drawChart() {
    if (!ctx || !ui.canvas) return;
    const rect = ui.canvas.getBoundingClientRect();
    const width = Math.max(300, rect.width || 900);
    const height = Math.max(126, rect.height || 220);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(width * dpr);
    ui.canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(167,207,43,.10)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const y = height * i / 5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    if (samples.length < 2) return;
    const max = Math.max(10, ...samples) * 1.15;
    const points = samples.map((v, i) => ({
      x: i * width / Math.max(samples.length - 1, 1),
      y: height - 10 - (v / max) * (height - 24)
    }));
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(184,234,54,.28)');
    gradient.addColorStop(1, 'rgba(184,234,54,0)');
    ctx.beginPath(); ctx.moveTo(points[0].x, height);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, height); ctx.closePath();
    ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = '#b8ea36'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  }

  function xhrTransfer({ method = 'GET', url, body = null, timeout = 10000, onProgress }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhrs.add(xhr);
      xhr.open(method, url, true);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = timeout;
      xhr.setRequestHeader('Cache-Control', 'no-cache');
      const started = performance.now();
      xhr.onprogress = (event) => { if (onProgress) onProgress(event.loaded, performance.now() - started); };
      if (xhr.upload && method === 'POST') {
        xhr.upload.onprogress = (event) => { if (onProgress) onProgress(event.loaded, performance.now() - started); };
      }
      xhr.onload = () => {
        activeXhrs.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 400) resolve({ bytes: xhr.response ? xhr.response.byteLength : 0, ms: performance.now() - started });
        else reject(new Error(`HTTP ${xhr.status || 'sem resposta'}`));
      };
      xhr.onerror = () => { activeXhrs.delete(xhr); reject(new Error('Falha de rede ou bloqueio CORS')); };
      xhr.ontimeout = () => { activeXhrs.delete(xhr); reject(new Error('Tempo limite excedido')); };
      xhr.onabort = () => { activeXhrs.delete(xhr); reject(new Error('Teste cancelado')); };
      try { xhr.send(body); } catch (e) { activeXhrs.delete(xhr); reject(e); }
    });
  }

  function abortAll() {
    for (const xhr of activeXhrs) { try { xhr.abort(); } catch (_) {} }
    activeXhrs.clear();
  }

  async function measureLatency(id) {
    const times = [];
    for (let i = 0; i < 6; i++) {
      if (id !== runId) throw new Error('Teste cancelado');
      try {
        const result = await xhrTransfer({ url: `${DOWN}?bytes=1&cache=${Date.now()}-${i}`, timeout: 3500 });
        times.push(result.ms);
      } catch (_) {}
      await new Promise(r => setTimeout(r, 90));
    }
    if (times.length < 3) throw new Error('Servidor de latência indisponível');
    const ping = median(times);
    const diffs = times.slice(1).map((v, i) => Math.abs(v - times[i]));
    return { ping, jitter: median(diffs) };
  }

  async function measureDownload(id) {
    samples = [];
    if (ui.chartWrap) ui.chartWrap.hidden = false;
    drawChart();
    const rolling = [];
    const started = performance.now();
    const progress = (loaded, elapsedMs) => {
      if (elapsedMs < 200) return;
      const speed = loaded * 8 / (elapsedMs / 1000) / 1e6;
      if (!Number.isFinite(speed) || speed <= 0) return;
      rolling.push(speed); if (rolling.length > 5) rolling.shift();
      const smoothed = median(rolling);
      samples.push(smoothed); if (samples.length > 60) samples.shift();
      updateGauge(smoothed);
      safeText(ui.download, `${formatSpeed(smoothed)} Mbps`);
      safeText(ui.live, `Download: ${formatSpeed(smoothed)} Mbps`);
      drawChart();
    };

    const jobs = [
      xhrTransfer({ url: `${DOWN}?bytes=8000000&cache=${Date.now()}-a`, timeout: 15000, onProgress: progress }),
      xhrTransfer({ url: `${DOWN}?bytes=8000000&cache=${Date.now()}-b`, timeout: 15000, onProgress: progress })
    ];
    const results = await Promise.allSettled(jobs);
    if (id !== runId) throw new Error('Teste cancelado');
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!ok.length) throw new Error('Servidor de download indisponível');
    const totalBytes = ok.reduce((sum, r) => sum + r.bytes, 0);
    const seconds = Math.max((performance.now() - started) / 1000, .1);
    const speed = totalBytes * 8 / seconds / 1e6;
    samples.push(speed); updateGauge(speed); drawChart();
    return speed;
  }

  async function measureUpload(id) {
    const bytes = 1_000_000;
    const payload = new Uint8Array(bytes);
    const result = await xhrTransfer({ method: 'POST', url: `${UP}?cache=${Date.now()}`, body: payload, timeout: 12000 });
    if (id !== runId) throw new Error('Teste cancelado');
    return bytes * 8 / Math.max(result.ms / 1000, .1) / 1e6;
  }

  function classifyStability() {
    if (samples.length < 4) return 'Boa';
    const mean = average(samples);
    const variance = average(samples.map(v => (v - mean) ** 2));
    const cv = Math.sqrt(variance) / Math.max(mean, 1);
    return cv < .16 ? 'Ótima' : cv < .30 ? 'Boa' : cv < .48 ? 'Regular' : 'Instável';
  }

  function resetMetrics() {
    safeText(ui.download, '-- Mbps');
    safeText(ui.upload, '-- Mbps');
    safeText(ui.ping, '-- ms');
    safeText(ui.jitter, '-- ms');
    safeText(ui.stability, '--');
    safeText(ui.live, 'Preparando teste...');
    updateGauge(0);
  }

  function finish() {
    running = false;
    setButtonState(false);
    if (ui.rerun) ui.rerun.hidden = false;
  }

  async function run() {
    if (running) return;
    running = true;
    const id = ++runId;
    setButtonState(true);
    resetMetrics();
    safeClass(ui.diagnosis, 'speed-diagnosis speedtest-diagnosis');
    safeText(ui.diagnosis, 'Teste iniciado. Não feche esta página durante a medição.');

    const watchdog = setTimeout(() => {
      if (!running || id !== runId) return;
      ++runId; abortAll();
      setStatus('Tempo limite');
      safeClass(ui.diagnosis, 'speed-diagnosis speedtest-diagnosis bad');
      safeText(ui.diagnosis, 'O servidor de medição não respondeu a tempo. O teste foi encerrado automaticamente.');
      safeText(ui.live, 'Teste encerrado por tempo limite.');
      finish();
    }, 45000);

    try {
      setStatus('Medindo ping');
      safeText(ui.live, 'Medindo latência...');
      const latency = await measureLatency(id);
      if (id !== runId) return;
      safeText(ui.ping, `${Math.round(latency.ping)} ms`);
      safeText(ui.jitter, `${latency.jitter.toFixed(1)} ms`);

      setStatus('Medindo download');
      const download = await measureDownload(id);
      if (id !== runId) return;
      safeText(ui.download, `${formatSpeed(download)} Mbps`);

      let upload = null;
      if (ui.upload) {
        setStatus('Medindo upload');
        safeText(ui.live, 'Medindo upload...');
        try {
          upload = await measureUpload(id);
          if (id !== runId) return;
          safeText(ui.upload, `${formatSpeed(upload)} Mbps`);
        } catch (_) {
          safeText(ui.upload, 'Indisponível');
        }
      }

      const stability = classifyStability();
      safeText(ui.stability, stability);
      setStatus('Teste concluído');
      safeText(ui.live, `Resultado: ${formatSpeed(download)} Mbps de download`);
      safeClass(ui.diagnosis, 'speed-diagnosis speedtest-diagnosis good');
      const uploadText = upload === null ? '' : ` · ${formatSpeed(upload)} Mbps de upload`;
      if (ui.diagnosis) ui.diagnosis.innerHTML = `<strong>${formatSpeed(download)} Mbps</strong> de download${uploadText} · <strong>${Math.round(latency.ping)} ms</strong> de ping · estabilidade <strong>${stability}</strong>.`;
    } catch (error) {
      if (id !== runId) return;
      console.error('GV Info Speed Test:', error);
      setStatus('Não foi possível concluir');
      safeText(ui.live, 'Falha ao medir a conexão.');
      safeClass(ui.diagnosis, 'speed-diagnosis speedtest-diagnosis bad');
      safeText(ui.diagnosis, `Falha: ${error.message || error}. O botão foi liberado para uma nova tentativa.`);
    } finally {
      if (id === runId) {
        clearTimeout(watchdog);
        abortAll();
        finish();
      }
    }
  }

  startBtn.addEventListener('click', run);
  if (ui.rerun) ui.rerun.addEventListener('click', run);
  window.addEventListener('resize', drawChart);
  setStatus('Pronto para iniciar');
  updateGauge(0);
  drawChart();
})();
