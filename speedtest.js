(() => {
  const startBtn = document.getElementById('startSpeedTest');
  if (!startBtn) return;

  const shell = startBtn.closest('.speedtest-shell');
  const rerunBtn = document.getElementById('rerunSpeedTest');
  const statusEl = document.getElementById('speedStatus');
  const liveLabel = document.getElementById('speedLiveLabel');
  const speedValue = document.getElementById('speedValue');
  const speedUnit = document.getElementById('speedUnit');
  const downloadMetric = document.getElementById('downloadMetric');
  const pingMetric = document.getElementById('pingMetric');
  const stabilityMetric = document.getElementById('stabilityMetric');
  const diagnosis = document.getElementById('speedDiagnosis');
  const dialProgress = document.getElementById('dialProgress');
  const chartWrap = document.getElementById('speedChartWrap');
  const canvas = document.getElementById('speedChart');
  const ctx = canvas.getContext('2d');

  const CIRCUMFERENCE = 1043;
  const TEST_FILE = 'downloads/AeroAdmin.exe';
  let samples = [];

  function formatMbps(value) {
    if (!Number.isFinite(value)) return '0';
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  }

  function dialPercent(mbps) {
    if (mbps <= 10) return (mbps / 10) * 0.22;
    if (mbps <= 50) return 0.22 + ((mbps - 10) / 40) * 0.25;
    if (mbps <= 100) return 0.47 + ((mbps - 50) / 50) * 0.18;
    if (mbps <= 300) return 0.65 + ((mbps - 100) / 200) * 0.22;
    return Math.min(1, 0.87 + ((mbps - 300) / 700) * 0.13);
  }

  function setSpeed(mbps, showMetric = true) {
    const pct = Math.max(0, Math.min(1, dialPercent(mbps)));
    dialProgress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - pct));
    speedValue.textContent = formatMbps(mbps);
    speedUnit.textContent = 'Mbps';
    if (showMetric) downloadMetric.textContent = formatMbps(mbps);
  }

  function resetVisuals() {
    samples = [];
    dialProgress.style.strokeDashoffset = String(CIRCUMFERENCE);
    speedValue.textContent = 'GO';
    speedUnit.textContent = 'TESTE';
    downloadMetric.textContent = '--';
    pingMetric.textContent = '--';
    stabilityMetric.textContent = '--';
    chartWrap.hidden = true;
    rerunBtn.hidden = true;
    drawChart();
  }

  function drawChart() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(300, rect.width || 720);
    const cssH = 126;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    for (let i = 1; i < 4; i++) {
      const y = (cssH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
      ctx.strokeStyle = 'rgba(167,207,43,.075)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (samples.length < 2) return;

    const max = Math.max(20, ...samples.map(s => s.mbps)) * 1.18;
    const points = samples.map((s, i) => ({
      x: (i / Math.max(samples.length - 1, 1)) * cssW,
      y: cssH - 9 - (s.mbps / max) * (cssH - 23)
    }));

    const fill = ctx.createLinearGradient(0, 0, 0, cssH);
    fill.addColorStop(0, 'rgba(184,234,54,.28)');
    fill.addColorStop(1, 'rgba(184,234,54,0)');
    ctx.beginPath();
    ctx.moveTo(points[0].x, cssH);
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, cssH);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = '#b8ea36';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(184,234,54,.55)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  async function pingTest() {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      try {
        await fetch(`imagens/favicon.png?ping=${Date.now()}-${i}`, { cache: 'no-store' });
        times.push(performance.now() - start);
      } catch (_) {}
    }
    if (!times.length) return null;
    return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  }

  async function downloadTest() {
    samples = [];
    chartWrap.hidden = false;
    drawChart();
    const start = performance.now();
    const response = await fetch(`${TEST_FILE}?speedtest=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Arquivo de teste indisponível');
    const reader = response.body?.getReader();

    if (!reader) {
      const blob = await response.blob();
      const seconds = (performance.now() - start) / 1000;
      return (blob.size * 8) / seconds / 1_000_000;
    }

    let received = 0;
    let lastTime = start;
    let lastBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      const now = performance.now();
      if (now - lastTime >= 180) {
        const mbps = ((received - lastBytes) * 8) / ((now - lastTime) / 1000) / 1_000_000;
        samples.push({ mbps });
        if (samples.length > 36) samples.shift();
        setSpeed(mbps);
        liveLabel.textContent = `Medindo download: ${formatMbps(mbps)} Mbps`;
        drawChart();
        lastTime = now;
        lastBytes = received;
      }
    }
    const totalSeconds = (performance.now() - start) / 1000;
    const average = (received * 8) / totalSeconds / 1_000_000;
    samples.push({ mbps: average });
    drawChart();
    return average;
  }

  function stabilityLabel() {
    const values = samples.map(s => s.mbps).filter(Number.isFinite);
    if (values.length < 3) return 'Boa';
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length;
    const cv = Math.sqrt(variance) / Math.max(avg, 1);
    return cv < .22 ? 'Ótima' : cv < .42 ? 'Boa' : 'Instável';
  }

  function resultText(mbps, ping, stability) {
    let cls = 'good';
    let message;
    if (mbps >= 100) message = 'Excelente para vídeo em alta resolução, chamadas, jogos e vários dispositivos.';
    else if (mbps >= 30) message = 'Boa para navegação, streaming, chamadas e suporte remoto.';
    else if (mbps >= 10) { cls = 'warn'; message = 'Adequada para uso básico, mas pode oscilar com vários dispositivos.'; }
    else { cls = 'bad'; message = 'Velocidade baixa. Pode causar travamentos e lentidão.'; }
    diagnosis.className = `speed-diagnosis speedtest-diagnosis ${cls}`;
    diagnosis.innerHTML = `<strong>${formatMbps(mbps)} Mbps</strong> de download · <strong>${ping ?? '--'} ms</strong> de ping · estabilidade <strong>${stability}</strong>.<br>${message}`;
  }

  async function run() {
    startBtn.disabled = true;
    shell.classList.add('is-testing');
    rerunBtn.hidden = true;
    statusEl.textContent = 'Testando';
    liveLabel.textContent = 'Medindo latência...';
    diagnosis.className = 'speed-diagnosis speedtest-diagnosis';
    diagnosis.textContent = 'Mantenha esta página aberta e evite outros downloads durante o teste.';
    setSpeed(0, false);
    downloadMetric.textContent = '--';
    pingMetric.textContent = '--';
    stabilityMetric.textContent = '--';

    try {
      const ping = await pingTest();
      if (ping !== null) pingMetric.textContent = String(ping);
      liveLabel.textContent = 'Medindo velocidade de download...';
      const mbps = await downloadTest();
      const stability = stabilityLabel();
      setSpeed(mbps);
      stabilityMetric.textContent = stability;
      statusEl.textContent = 'Concluído';
      liveLabel.textContent = 'Teste concluído';
      resultText(mbps, ping, stability);
      rerunBtn.hidden = false;
    } catch (error) {
      statusEl.textContent = 'Falha';
      liveLabel.textContent = 'Não foi possível concluir';
      diagnosis.className = 'speed-diagnosis speedtest-diagnosis bad';
      diagnosis.innerHTML = 'Não foi possível executar o teste. Confirme se o arquivo <strong>downloads/AeroAdmin.exe</strong> está publicado no GitHub.';
      speedValue.textContent = '!';
      speedUnit.textContent = 'ERRO';
      rerunBtn.hidden = false;
    } finally {
      shell.classList.remove('is-testing');
      startBtn.disabled = false;
    }
  }

  startBtn.addEventListener('click', run);
  rerunBtn?.addEventListener('click', run);
  window.addEventListener('resize', () => { if (!chartWrap.hidden) drawChart(); });
  resetVisuals();
})();
