(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const startBtn = $('startSpeedTest');
  if (!startBtn) return;

  const statusEl = $('speedStatus');
  const speedValue = $('speedValue');
  const downloadMetric = $('downloadMetric');
  const uploadMetric = $('uploadMetric');
  const pingMetric = $('pingMetric');
  const jitterMetric = $('jitterMetric');
  const stabilityMetric = $('stabilityMetric');
  const diagnosis = $('speedDiagnosis');
  const gauge = document.querySelector('.gauge');
  const canvas = $('speedChart');
  const ctx = canvas?.getContext('2d');

  const DOWNLOAD_URL = 'https://speed.cloudflare.com/__down';
  const UPLOAD_URL = 'https://speed.cloudflare.com/__up';
  const OVERALL_TIMEOUT_MS = 50000;
  let running = false;
  let mainController = null;
  let samples = [];

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const median = values => {
    if (!values.length) return 0;
    const a = [...values].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function formatMbps(value) {
    if (!Number.isFinite(value) || value <= 0) return '--';
    if (value >= 100) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function setGauge(mbps) {
    const value = Number.isFinite(mbps) ? Math.max(0, mbps) : 0;
    const normalized = Math.log10(value + 1) / Math.log10(1001);
    gauge?.style.setProperty('--percent', `${clamp(normalized * 37.5, 0, 37.5)}%`);
    gauge?.style.setProperty('--angle', `${-130 + clamp(normalized, 0, 1) * 260}deg`);
    speedValue.textContent = value ? formatMbps(value) : '0';
  }

  function updateStatus(text) {
    statusEl.textContent = text;
  }

  function drawChart() {
    if (!ctx || !canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(300, rect.width || 900);
    const height = Math.max(180, Math.min(300, width * 0.3));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(167,207,43,.10)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const y = (height / 5) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    if (samples.length < 2) return;

    const values = samples.map(s => s.mbps).filter(Number.isFinite);
    const max = Math.max(10, ...values) * 1.15;
    const points = samples.map((s, i) => ({
      x: (i / Math.max(samples.length - 1, 1)) * width,
      y: height - 12 - (s.mbps / max) * (height - 28)
    }));
    const fill = ctx.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, 'rgba(184,234,54,.30)');
    fill.addColorStop(1, 'rgba(184,234,54,0)');
    ctx.beginPath(); ctx.moveTo(points[0].x, height);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points.at(-1).x, height); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = '#b8ea36'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke();
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(new DOMException('Tempo limite excedido', 'TimeoutError')), timeoutMs);
    const abortFromMain = () => local.abort(mainController?.signal.reason);
    mainController?.signal.addEventListener('abort', abortFromMain, { once: true });
    try {
      return await fetch(url, { ...options, signal: local.signal, cache: 'no-store' });
    } finally {
      clearTimeout(timer);
      mainController?.signal.removeEventListener('abort', abortFromMain);
    }
  }

  async function latencyTest() {
    const times = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      try {
        const response = await fetchWithTimeout(`${DOWNLOAD_URL}?bytes=1&t=${Date.now()}-${i}`, {}, 4000);
        if (response.ok) {
          await response.arrayBuffer();
          times.push(performance.now() - start);
        }
      } catch (error) {
        if (mainController?.signal.aborted) throw error;
      }
      await sleep(80);
    }
    if (times.length < 3) throw new Error('Não foi possível medir a latência');
    const ordered = [...times].sort((a, b) => a - b);
    const useful = ordered.length > 4 ? ordered.slice(1, -1) : ordered;
    const ping = median(useful);
    const deltas = useful.slice(1).map((v, i) => Math.abs(v - useful[i]));
    return { ping, jitter: deltas.length ? median(deltas) : 0 };
  }

  async function oneDownload(bytes, onSample) {
    const start = performance.now();
    const response = await fetchWithTimeout(`${DOWNLOAD_URL}?bytes=${bytes}&t=${Date.now()}-${Math.random()}`, {}, 18000);
    if (!response.ok || !response.body) throw new Error('Servidor de download indisponível');
    const reader = response.body.getReader();
    let received = 0;
    let lastBytes = 0;
    let lastTime = start;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      const now = performance.now();
      if (now - lastTime >= 300) {
        onSample(((received - lastBytes) * 8) / ((now - lastTime) / 1000) / 1e6);
        lastBytes = received;
        lastTime = now;
      }
    }
    return received;
  }

  async function downloadTest() {
    updateStatus('Medindo download...');
    samples = [];
    drawChart();
    const recent = [];
    const onSample = mbps => {
      if (!Number.isFinite(mbps) || mbps <= 0) return;
      recent.push(mbps);
      if (recent.length > 7) recent.shift();
      const smooth = median(recent);
      samples.push({ mbps: smooth });
      if (samples.length > 50) samples.shift();
      setGauge(smooth);
      downloadMetric.textContent = `${formatMbps(smooth)} Mbps`;
      drawChart();
    };

    const start = performance.now();
    const jobs = Array.from({ length: 3 }, () => oneDownload(8_000_000, onSample));
    const settled = await Promise.allSettled(jobs);
    const bytes = settled.filter(r => r.status === 'fulfilled').reduce((sum, r) => sum + r.value, 0);
    if (!bytes) throw new Error('Não foi possível medir o download');
    const seconds = Math.max((performance.now() - start) / 1000, 0.1);
    const raw = (bytes * 8) / seconds / 1e6;
    const stable = samples.slice(Math.floor(samples.length * .2)).map(s => s.mbps);
    const result = stable.length ? raw * .75 + median(stable) * .25 : raw;
    samples.push({ mbps: result });
    setGauge(result); drawChart();
    return result;
  }

  function randomPayload(bytes) {
    const data = new Uint8Array(bytes);
    for (let offset = 0; offset < bytes; offset += 65536) {
      crypto.getRandomValues(data.subarray(offset, Math.min(offset + 65536, bytes)));
    }
    return data;
  }

  async function uploadTest(downloadMbps) {
    updateStatus('Medindo upload...');
    const bytes = downloadMbps > 100 ? 3_000_000 : 1_500_000;
    const payload = randomPayload(bytes);
    const start = performance.now();
    const response = await fetchWithTimeout(`${UPLOAD_URL}?t=${Date.now()}`, {
      method: 'POST',
      body: payload
    }, 15000);
    if (!response.ok) throw new Error('Upload indisponível');
    await response.text();
    const seconds = Math.max((performance.now() - start) / 1000, .1);
    return (bytes * 8) / seconds / 1e6;
  }

  function stabilityResult() {
    const values = samples.map(s => s.mbps).filter(v => Number.isFinite(v) && v > 0);
    if (values.length < 4) return 'Boa';
    const mean = average(values);
    const variance = average(values.map(v => (v - mean) ** 2));
    const cv = Math.sqrt(variance) / Math.max(mean, 1);
    if (cv < .16) return 'Ótima';
    if (cv < .30) return 'Boa';
    if (cv < .48) return 'Regular';
    return 'Instável';
  }

  function showDiagnosis(download, upload, ping, jitter, stability) {
    const uploadText = Number.isFinite(upload) ? `<strong>${formatMbps(upload)} Mbps</strong> de upload` : '<strong>upload indisponível</strong>';
    let level = 'good';
    let message = 'Conexão adequada para navegação, chamadas, streaming e suporte remoto.';
    if (download < 10 || ping > 100 || (Number.isFinite(upload) && upload < 3)) {
      level = 'bad'; message = 'A conexão apresenta limitações que podem causar lentidão, cortes em chamadas ou dificuldade no acesso remoto.';
    } else if (download < 30 || ping > 60 || jitter > 25 || stability === 'Instável') {
      level = 'warn'; message = 'A conexão funciona para uso comum, mas pode oscilar em chamadas, jogos ou com vários aparelhos conectados.';
    }
    diagnosis.className = `speed-diagnosis ${level}`;
    diagnosis.innerHTML = `<strong>${formatMbps(download)} Mbps</strong> de download · ${uploadText} · <strong>${Math.round(ping)} ms</strong> de ping · <strong>${jitter.toFixed(1)} ms</strong> de jitter.<br>${message}`;
  }

  function reset() {
    samples = [];
    setGauge(0); drawChart();
    downloadMetric.textContent = '-- Mbps'; uploadMetric.textContent = '-- Mbps';
    pingMetric.textContent = '-- ms'; jitterMetric.textContent = '-- ms'; stabilityMetric.textContent = '--';
    updateStatus('Pronto para iniciar');
    diagnosis.className = 'speed-diagnosis';
    diagnosis.innerHTML = 'Clique em <strong>Iniciar teste</strong> para analisar sua conexão.';
  }

  async function run() {
    if (running) return;
    running = true;
    mainController = new AbortController();
    const overallTimer = setTimeout(() => mainController.abort(new DOMException('Tempo total excedido', 'TimeoutError')), OVERALL_TIMEOUT_MS);
    startBtn.disabled = true;
    startBtn.textContent = 'Testando...';
    setGauge(0);
    downloadMetric.textContent = '-- Mbps'; uploadMetric.textContent = '-- Mbps';
    pingMetric.textContent = '-- ms'; jitterMetric.textContent = '-- ms'; stabilityMetric.textContent = '--';
    diagnosis.className = 'speed-diagnosis';
    diagnosis.textContent = 'Mantenha esta página aberta e evite outros downloads durante a medição.';

    let latency = null;
    let download = null;
    let upload = null;
    try {
      updateStatus('Medindo latência...');
      latency = await latencyTest();
      pingMetric.textContent = `${Math.round(latency.ping)} ms`;
      jitterMetric.textContent = `${latency.jitter.toFixed(1)} ms`;

      download = await downloadTest();
      downloadMetric.textContent = `${formatMbps(download)} Mbps`;

      try {
        upload = await uploadTest(download);
        uploadMetric.textContent = `${formatMbps(upload)} Mbps`;
      } catch (error) {
        console.warn('Upload não medido:', error);
        uploadMetric.textContent = 'Indisponível';
      }

      const stability = stabilityResult();
      stabilityMetric.textContent = stability;
      updateStatus(upload === null ? 'Teste concluído parcialmente' : 'Teste concluído');
      showDiagnosis(download, upload, latency.ping, latency.jitter, stability);
    } catch (error) {
      console.error(error);
      updateStatus('Não foi possível concluir');
      diagnosis.className = 'speed-diagnosis bad';
      diagnosis.innerHTML = 'O servidor de medição não respondeu dentro do limite. Recarregue a página e tente novamente. Bloqueadores de conteúdo, VPN ou filtros de segurança também podem impedir o teste.';
    } finally {
      clearTimeout(overallTimer);
      running = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Testar novamente';
      mainController = null;
    }
  }

  startBtn.addEventListener('click', run);
  window.addEventListener('resize', drawChart);
  reset();
})();
