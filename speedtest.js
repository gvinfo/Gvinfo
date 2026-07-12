(() => {
  'use strict';

  const startBtn = document.getElementById('startSpeedTest');
  if (!startBtn) return;

  const statusEl = document.getElementById('speedStatus');
  const speedValue = document.getElementById('speedValue');
  const downloadMetric = document.getElementById('downloadMetric');
  const uploadMetric = document.getElementById('uploadMetric');
  const pingMetric = document.getElementById('pingMetric');
  const jitterMetric = document.getElementById('jitterMetric');
  const stabilityMetric = document.getElementById('stabilityMetric');
  const diagnosis = document.getElementById('speedDiagnosis');
  const gauge = document.querySelector('.gauge');
  const canvas = document.getElementById('speedChart');
  const ctx = canvas?.getContext('2d');

  const BASE_URL = 'https://speed.cloudflare.com';
  const DOWNLOAD_URL = `${BASE_URL}/__down`;
  const UPLOAD_URL = `${BASE_URL}/__up`;
  const PARALLEL_DOWNLOADS = 4;
  const PARALLEL_UPLOADS = 2;
  const MIN_DOWNLOAD_BYTES = 2_000_000;
  const MAX_DOWNLOAD_BYTES = 25_000_000;
  const MAX_UPLOAD_BYTES = 8_000_000;

  let samples = [];
  let running = false;
  let controller = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const average = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  function formatMbps(value) {
    if (!Number.isFinite(value)) return '--';
    if (value >= 100) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function setGauge(mbps) {
    const normalized = Math.log10(Math.max(1, mbps) + 1) / Math.log10(1001);
    const percent = clamp(normalized * 37.5, 0, 37.5);
    const angle = -130 + clamp(normalized, 0, 1) * 260;
    gauge?.style.setProperty('--percent', `${percent}%`);
    gauge?.style.setProperty('--angle', `${angle}deg`);
    speedValue.textContent = formatMbps(mbps) === '--' ? '0' : formatMbps(mbps);
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
    const values = samples.map(item => item.mbps).filter(Number.isFinite);
    const maxValue = Math.max(10, ...values) * 1.15;
    const points = samples.map((item, index) => ({
      x: (index / Math.max(samples.length - 1, 1)) * width,
      y: height - 12 - (item.mbps / maxValue) * (height - 28)
    }));

    const fill = ctx.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, 'rgba(184,234,54,.30)');
    fill.addColorStop(1, 'rgba(184,234,54,0)');
    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    points.forEach(point => ctx.lineTo(point.x, point.y));
    ctx.lineTo(points[points.length - 1].x, height);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.strokeStyle = '#b8ea36';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(184,234,54,.50)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  async function latencyTest() {
    const measurements = [];

    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      try {
        const response = await fetch(`${DOWNLOAD_URL}?bytes=0&ts=${Date.now()}-${i}`, {
          cache: 'no-store',
          signal: controller.signal
        });
        if (!response.ok) throw new Error('Falha na medição de latência');
        await response.arrayBuffer();
        measurements.push(performance.now() - start);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
      }
      await sleep(70);
    }

    if (measurements.length < 4) throw new Error('Latência indisponível');
    const trimmed = [...measurements].sort((a, b) => a - b).slice(1, -1);
    const ping = median(trimmed);
    const deltas = trimmed.slice(1).map((value, index) => Math.abs(value - trimmed[index]));
    return { ping, jitter: median(deltas) };
  }

  async function fetchDownload(bytes, sampleCallback) {
    const start = performance.now();
    const response = await fetch(`${DOWNLOAD_URL}?bytes=${bytes}&ts=${Date.now()}-${Math.random()}`, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok || !response.body) throw new Error('Servidor de download indisponível');

    const reader = response.body.getReader();
    let received = 0;
    let previousBytes = 0;
    let previousTime = start;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      const now = performance.now();
      if (now - previousTime >= 250) {
        const mbps = ((received - previousBytes) * 8) / ((now - previousTime) / 1000) / 1_000_000;
        sampleCallback(mbps);
        previousBytes = received;
        previousTime = now;
      }
    }

    return { bytes: received, milliseconds: performance.now() - start };
  }

  async function estimateConnection() {
    const start = performance.now();
    const response = await fetch(`${DOWNLOAD_URL}?bytes=1000000&ts=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error('Servidor de teste indisponível');
    const data = await response.arrayBuffer();
    const seconds = Math.max((performance.now() - start) / 1000, 0.05);
    return (data.byteLength * 8) / seconds / 1_000_000;
  }

  async function downloadTest() {
    samples = [];
    drawChart();

    updateStatus('Preparando download...');
    const estimate = await estimateConnection();
    const targetBytes = clamp(Math.round((estimate * 1_000_000 / 8) * 2.2), MIN_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES);

    updateStatus('Medindo download...');
    const start = performance.now();
    let lastVisualUpdate = 0;
    const recent = [];
    const sampleCallback = mbps => {
      if (!Number.isFinite(mbps) || mbps <= 0) return;
      recent.push(mbps);
      if (recent.length > 8) recent.shift();
      const smooth = median(recent);
      const now = performance.now();
      if (now - lastVisualUpdate > 180) {
        samples.push({ mbps: smooth });
        if (samples.length > 50) samples.shift();
        setGauge(smooth);
        downloadMetric.textContent = `${formatMbps(smooth)} Mbps`;
        drawChart();
        lastVisualUpdate = now;
      }
    };

    const results = await Promise.all(
      Array.from({ length: PARALLEL_DOWNLOADS }, () => fetchDownload(targetBytes, sampleCallback))
    );

    const elapsed = (performance.now() - start) / 1000;
    const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0);
    const rawMbps = (totalBytes * 8) / elapsed / 1_000_000;

    const stableSamples = samples.slice(Math.floor(samples.length * 0.2)).map(item => item.mbps);
    const sampleMedian = stableSamples.length ? median(stableSamples) : rawMbps;
    const finalMbps = rawMbps * 0.72 + sampleMedian * 0.28;
    samples.push({ mbps: finalMbps });
    setGauge(finalMbps);
    drawChart();
    return finalMbps;
  }

  function createUploadBlob(bytes) {
    const chunk = new Uint8Array(Math.min(bytes, 1_000_000));
    crypto.getRandomValues(chunk);
    const parts = [];
    let remaining = bytes;
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.byteLength);
      parts.push(length === chunk.byteLength ? chunk : chunk.slice(0, length));
      remaining -= length;
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  }

  async function uploadTest(downloadMbps) {
    updateStatus('Medindo upload...');
    const estimatedUpload = Math.max(3, Math.min(downloadMbps, 200));
    const bytes = clamp(Math.round((estimatedUpload * 1_000_000 / 8) * 1.6), 750_000, MAX_UPLOAD_BYTES);
    const payload = createUploadBlob(bytes);
    const start = performance.now();

    const results = await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, async (_, index) => {
      const requestStart = performance.now();
      const response = await fetch(`${UPLOAD_URL}?ts=${Date.now()}-${index}`, {
        method: 'POST',
        body: payload,
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Servidor de upload indisponível');
      await response.text();
      return performance.now() - requestStart;
    }));

    const elapsed = Math.max((performance.now() - start) / 1000, 0.05);
    const aggregateMbps = (payload.size * PARALLEL_UPLOADS * 8) / elapsed / 1_000_000;
    const individualMbps = results.map(ms => (payload.size * 8) / (ms / 1000) / 1_000_000);
    return aggregateMbps * 0.8 + average(individualMbps) * 0.2;
  }

  function stabilityResult() {
    const values = samples.map(item => item.mbps).filter(value => Number.isFinite(value) && value > 0);
    if (values.length < 4) return { label: 'Boa', cv: 0 };
    const mean = average(values);
    const variance = average(values.map(value => (value - mean) ** 2));
    const cv = Math.sqrt(variance) / Math.max(mean, 1);
    if (cv < 0.16) return { label: 'Ótima', cv };
    if (cv < 0.30) return { label: 'Boa', cv };
    if (cv < 0.48) return { label: 'Regular', cv };
    return { label: 'Instável', cv };
  }

  function showDiagnosis(download, upload, ping, jitter, stability) {
    let className = 'good';
    let message = 'Conexão adequada para navegação, chamadas, streaming e suporte remoto.';

    if (download < 10 || upload < 3 || ping > 100) {
      className = 'bad';
      message = 'A conexão apresenta limitações que podem causar lentidão, cortes em chamadas ou dificuldade no acesso remoto.';
    } else if (download < 30 || upload < 8 || ping > 60 || jitter > 25 || stability.label === 'Instável') {
      className = 'warn';
      message = 'A conexão funciona para uso comum, mas pode oscilar em chamadas, jogos ou quando vários aparelhos estão conectados.';
    } else if (download >= 100 && upload >= 20 && ping <= 35 && jitter <= 10) {
      message = 'Excelente conexão para vídeo em alta resolução, chamadas, jogos e vários dispositivos simultâneos.';
    }

    diagnosis.className = `speed-diagnosis ${className}`;
    diagnosis.innerHTML = `<strong>${formatMbps(download)} Mbps</strong> de download · <strong>${formatMbps(upload)} Mbps</strong> de upload · <strong>${Math.round(ping)} ms</strong> de ping · <strong>${jitter.toFixed(1)} ms</strong> de jitter.<br>${message}`;
  }

  function reset() {
    samples = [];
    setGauge(0);
    downloadMetric.textContent = '-- Mbps';
    uploadMetric.textContent = '-- Mbps';
    pingMetric.textContent = '-- ms';
    jitterMetric.textContent = '-- ms';
    stabilityMetric.textContent = '--';
    updateStatus('Pronto para iniciar');
    diagnosis.className = 'speed-diagnosis';
    diagnosis.innerHTML = 'Clique em <strong>Iniciar teste</strong> para analisar sua conexão.';
    drawChart();
  }

  async function run() {
    if (running) return;
    running = true;
    controller = new AbortController();
    startBtn.disabled = true;
    startBtn.textContent = 'Testando...';
    diagnosis.className = 'speed-diagnosis';
    diagnosis.textContent = 'Evite downloads e mantenha esta página aberta durante a medição.';
    downloadMetric.textContent = '-- Mbps';
    uploadMetric.textContent = '-- Mbps';
    pingMetric.textContent = '-- ms';
    jitterMetric.textContent = '-- ms';
    stabilityMetric.textContent = '--';
    setGauge(0);

    try {
      updateStatus('Medindo latência...');
      const latency = await latencyTest();
      pingMetric.textContent = `${Math.round(latency.ping)} ms`;
      jitterMetric.textContent = `${latency.jitter.toFixed(1)} ms`;

      const download = await downloadTest();
      downloadMetric.textContent = `${formatMbps(download)} Mbps`;

      const upload = await uploadTest(download);
      uploadMetric.textContent = `${formatMbps(upload)} Mbps`;

      const stability = stabilityResult();
      stabilityMetric.textContent = stability.label;
      updateStatus('Teste concluído');
      showDiagnosis(download, upload, latency.ping, latency.jitter, stability);
    } catch (error) {
      console.error(error);
      updateStatus('Não foi possível concluir');
      diagnosis.className = 'speed-diagnosis bad';
      diagnosis.innerHTML = 'O teste não conseguiu acessar o servidor de medição. Verifique a conexão, desative temporariamente bloqueadores de conteúdo e tente novamente.';
    } finally {
      running = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Testar novamente';
      controller = null;
    }
  }

  startBtn.addEventListener('click', run);
  window.addEventListener('resize', drawChart);
  reset();
})();
