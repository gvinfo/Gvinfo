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
  const ctx = canvas ? canvas.getContext('2d') : null;

  const DOWNLOAD_URL = 'https://speed.cloudflare.com/__down';
  const UPLOAD_URL = 'https://speed.cloudflare.com/__up';
  const TEST_TIMEOUT = 20000;
  const OVERALL_TIMEOUT = 55000;

  let running = false;
  let activeRequests = [];
  let samples = [];

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const median = values => {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
    if (gauge) {
      gauge.style.setProperty('--percent', `${clamp(normalized * 37.5, 0, 37.5)}%`);
      gauge.style.setProperty('--angle', `${-130 + clamp(normalized, 0, 1) * 260}deg`);
    }
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
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
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
    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, height);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = '#b8ea36';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function trackRequest(xhr) {
    activeRequests.push(xhr);
    const remove = () => {
      activeRequests = activeRequests.filter(item => item !== xhr);
    };
    xhr.addEventListener('loadend', remove, { once: true });
    return xhr;
  }

  function abortAllRequests() {
    activeRequests.slice().forEach(xhr => {
      try { xhr.abort(); } catch (_) {}
    });
    activeRequests = [];
  }

  function xhrRequest({ method = 'GET', url, body = null, timeout = TEST_TIMEOUT, responseType = 'arraybuffer', onProgress }) {
    return new Promise((resolve, reject) => {
      const xhr = trackRequest(new XMLHttpRequest());
      xhr.open(method, url, true);
      xhr.responseType = responseType;
      xhr.timeout = timeout;
      xhr.setRequestHeader('Cache-Control', 'no-cache');

      if (typeof onProgress === 'function') {
        const target = method === 'POST' ? xhr.upload : xhr;
        target.onprogress = event => onProgress(event.loaded, event.total || 0);
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);
        else reject(new Error(`Servidor respondeu ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Falha de rede ou bloqueio CORS'));
      xhr.ontimeout = () => reject(new Error('Tempo limite excedido'));
      xhr.onabort = () => reject(new Error('Teste interrompido'));
      xhr.send(body);
    });
  }

  async function latencyTest() {
    const times = [];
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      try {
        await xhrRequest({
          url: `${DOWNLOAD_URL}?bytes=1&t=${Date.now()}-${i}`,
          timeout: 4500
        });
        times.push(performance.now() - start);
      } catch (_) {}
      await sleep(100);
    }
    if (times.length < 2) throw new Error('Servidor de latência indisponível');
    const useful = times.length > 4 ? times.slice().sort((a, b) => a - b).slice(1, -1) : times;
    const ping = median(useful);
    const deltas = useful.slice(1).map((value, index) => Math.abs(value - useful[index]));
    return { ping, jitter: deltas.length ? median(deltas) : 0 };
  }

  async function oneDownload(bytes, onSample) {
    const start = performance.now();
    let lastBytes = 0;
    let lastTime = start;
    const xhr = await xhrRequest({
      url: `${DOWNLOAD_URL}?bytes=${bytes}&t=${Date.now()}-${Math.random()}`,
      timeout: TEST_TIMEOUT,
      onProgress: loaded => {
        const now = performance.now();
        if (now - lastTime >= 300) {
          const mbps = ((loaded - lastBytes) * 8) / ((now - lastTime) / 1000) / 1e6;
          if (Number.isFinite(mbps) && mbps > 0) onSample(mbps);
          lastBytes = loaded;
          lastTime = now;
        }
      }
    });
    const elapsed = Math.max((performance.now() - start) / 1000, 0.1);
    const received = xhr.response ? xhr.response.byteLength : bytes;
    return { bytes: received, seconds: elapsed };
  }

  async function downloadTest() {
    updateStatus('Medindo download...');
    samples = [];
    drawChart();
    const recent = [];

    const onSample = mbps => {
      recent.push(mbps);
      if (recent.length > 7) recent.shift();
      const smooth = median(recent);
      samples.push({ mbps: smooth });
      if (samples.length > 50) samples.shift();
      setGauge(smooth);
      downloadMetric.textContent = `${formatMbps(smooth)} Mbps`;
      drawChart();
    };

    const results = await Promise.allSettled([
      oneDownload(6_000_000, onSample),
      oneDownload(6_000_000, onSample),
      oneDownload(6_000_000, onSample)
    ]);

    const successful = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    if (!successful.length) throw new Error('Download bloqueado ou indisponível');

    const totalBytes = successful.reduce((sum, item) => sum + item.bytes, 0);
    const longestTime = Math.max(...successful.map(item => item.seconds), 0.1);
    const rawMbps = (totalBytes * 8) / longestTime / 1e6;
    const sampleValues = samples.map(item => item.mbps).filter(value => Number.isFinite(value) && value > 0);
    const finalMbps = sampleValues.length ? rawMbps * 0.8 + median(sampleValues) * 0.2 : rawMbps;

    samples.push({ mbps: finalMbps });
    setGauge(finalMbps);
    drawChart();
    return finalMbps;
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
    const bytes = downloadMbps > 100 ? 2_000_000 : 1_000_000;
    const payload = randomPayload(bytes);
    const start = performance.now();
    await xhrRequest({
      method: 'POST',
      url: `${UPLOAD_URL}?t=${Date.now()}`,
      body: payload,
      timeout: 15000,
      responseType: 'text'
    });
    return (bytes * 8) / Math.max((performance.now() - start) / 1000, 0.1) / 1e6;
  }

  function stabilityResult() {
    const values = samples.map(s => s.mbps).filter(v => Number.isFinite(v) && v > 0);
    if (values.length < 4) return 'Boa';
    const mean = average(values);
    const variance = average(values.map(v => (v - mean) ** 2));
    const cv = Math.sqrt(variance) / Math.max(mean, 1);
    if (cv < 0.16) return 'Ótima';
    if (cv < 0.30) return 'Boa';
    if (cv < 0.48) return 'Regular';
    return 'Instável';
  }

  function showDiagnosis(download, upload, ping, jitter, stability) {
    const uploadText = Number.isFinite(upload) ? `<strong>${formatMbps(upload)} Mbps</strong> de upload` : '<strong>upload indisponível</strong>';
    let level = 'good';
    let message = 'Conexão adequada para navegação, chamadas, streaming e suporte remoto.';
    if (download < 10 || ping > 100 || (Number.isFinite(upload) && upload < 3)) {
      level = 'bad';
      message = 'A conexão apresenta limitações que podem causar lentidão, cortes em chamadas ou dificuldade no acesso remoto.';
    } else if (download < 30 || ping > 60 || jitter > 25 || stability === 'Instável') {
      level = 'warn';
      message = 'A conexão funciona para uso comum, mas pode oscilar em chamadas, jogos ou com vários aparelhos conectados.';
    }
    diagnosis.className = `speed-diagnosis ${level}`;
    diagnosis.innerHTML = `<strong>${formatMbps(download)} Mbps</strong> de download · ${uploadText} · <strong>${Math.round(ping)} ms</strong> de ping · <strong>${jitter.toFixed(1)} ms</strong> de jitter.<br>${message}`;
  }

  function reset() {
    samples = [];
    setGauge(0);
    drawChart();
    downloadMetric.textContent = '-- Mbps';
    uploadMetric.textContent = '-- Mbps';
    pingMetric.textContent = '-- ms';
    jitterMetric.textContent = '-- ms';
    stabilityMetric.textContent = '--';
    updateStatus('Pronto para iniciar');
    diagnosis.className = 'speed-diagnosis';
    diagnosis.innerHTML = 'Clique em <strong>Iniciar teste</strong> para analisar sua conexão.';
  }

  async function run() {
    if (running) return;
    running = true;
    startBtn.disabled = true;
    startBtn.textContent = 'Testando...';
    setGauge(0);
    downloadMetric.textContent = '-- Mbps';
    uploadMetric.textContent = '-- Mbps';
    pingMetric.textContent = '-- ms';
    jitterMetric.textContent = '-- ms';
    stabilityMetric.textContent = '--';
    diagnosis.className = 'speed-diagnosis';
    diagnosis.textContent = 'Mantenha esta página aberta e evite outros downloads durante a medição.';

    const overallTimer = setTimeout(() => abortAllRequests(), OVERALL_TIMEOUT);
    let latency;
    let download;
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
      diagnosis.innerHTML = 'O servidor do teste foi bloqueado ou não respondeu. Desative temporariamente VPN, bloqueador de anúncios ou proteção web do antivírus e tente novamente.';
    } finally {
      clearTimeout(overallTimer);
      abortAllRequests();
      running = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Testar novamente';
    }
  }

  startBtn.addEventListener('click', run);
  window.addEventListener('resize', drawChart);
  reset();
})();
