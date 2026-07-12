(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const start = $('startSpeedTest');
  if (!start) return;

  const ui = {
    shell: document.querySelector('.speedtest-shell') || document.querySelector('.speed-card'),
    status: $('speedStatus'),
    latency: $('pingMetric'),
    jitter: $('jitterMetric'),
    stability: $('stabilityMetric'),
    estimate: $('downloadMetric'),
    value: $('speedValue'),
    unit: $('speedUnit'),
    live: $('speedLiveLabel'),
    diagnosis: $('speedDiagnosis'),
    grid: $('connectionQualityGrid'),
    rerun: $('rerunSpeedTest'),
    dial: $('dialProgress')
  };

  const VERSION = '1.0';
  let running = false;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function text(element, value) {
    if (element) element.textContent = value;
  }

  function setStatus(value) {
    text(ui.status, `${value} · v${VERSION}`);
  }

  function setProgress(percent) {
    if (!ui.dial) return;
    const circumference = 1043;
    ui.dial.style.strokeDashoffset = String(circumference * (1 - clamp(percent, 0, 100) / 100));
  }

  function setButton(label, main, small) {
    const goLabel = start.querySelector('.go-label');
    const strong = start.querySelector('strong');
    const unit = start.querySelector('small');
    if (goLabel) goLabel.textContent = label;
    if (strong) strong.textContent = main;
    if (unit) unit.textContent = small;
    if (!goLabel && !strong && !unit) start.textContent = main;
  }

  function requestOnce(index) {
    return new Promise((resolve) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const started = performance.now();
      fetch(`imagens/favicon.png?diagnostico=${Date.now()}-${index}`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal
      }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      }).then(() => {
        resolve({ ok: true, ms: performance.now() - started });
      }).catch(() => {
        resolve({ ok: false, ms: null });
      }).finally(() => clearTimeout(timeout));
    });
  }

  function browserConnection() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return {
      online: navigator.onLine,
      type: connection?.effectiveType || 'não informado',
      downlink: Number.isFinite(connection?.downlink) ? connection.downlink : null,
      rtt: Number.isFinite(connection?.rtt) ? connection.rtt : null,
      saveData: Boolean(connection?.saveData)
    };
  }

  function scoreForUse(use, latency, jitter, loss, downlink) {
    const rules = {
      remote: { latency: 180, jitter: 45, loss: 15, downlink: 1 },
      calls: { latency: 150, jitter: 30, loss: 8, downlink: 2 },
      streaming: { latency: 260, jitter: 80, loss: 12, downlink: 5 },
      gaming: { latency: 80, jitter: 20, loss: 3, downlink: 3 }
    }[use];

    let score = 100;
    score -= Math.max(0, latency - rules.latency * 0.45) / rules.latency * 45;
    score -= Math.max(0, jitter - rules.jitter * 0.35) / rules.jitter * 30;
    score -= Math.max(0, loss) / Math.max(rules.loss, 1) * 35;
    if (downlink !== null && downlink < rules.downlink) score -= 25;
    return clamp(Math.round(score), 0, 100);
  }

  function rating(score) {
    if (score >= 85) return { label: 'Excelente', cls: 'excellent' };
    if (score >= 70) return { label: 'Muito boa', cls: 'good' };
    if (score >= 52) return { label: 'Regular', cls: 'regular' };
    return { label: 'Ruim', cls: 'bad' };
  }

  function overallRating(latency, jitter, loss, downlink) {
    const scores = ['remote', 'calls', 'streaming', 'gaming'].map(use => scoreForUse(use, latency, jitter, loss, downlink));
    return rating(Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length));
  }

  function renderCards(latency, jitter, loss, downlink) {
    if (!ui.grid) return;
    const uses = [
      ['remote', 'Acesso remoto', 'RustDesk, AeroAdmin e suporte técnico'],
      ['calls', 'Videochamadas', 'WhatsApp, Meet, Teams e Zoom'],
      ['streaming', 'Streaming', 'Vídeos, filmes e transmissões'],
      ['gaming', 'Jogos online', 'Resposta rápida e estabilidade']
    ];
    ui.grid.innerHTML = uses.map(([key, title, detail]) => {
      const result = rating(scoreForUse(key, latency, jitter, loss, downlink));
      return `<article class="quality-card ${result.cls}"><span>${title}</span><strong>${result.label}</strong><small>${detail}</small></article>`;
    }).join('');
    ui.grid.hidden = false;
  }

  async function run() {
    if (running) return;
    running = true;
    start.disabled = true;
    ui.shell?.classList.add('is-testing');
    ui.rerun && (ui.rerun.hidden = true);
    ui.grid && (ui.grid.hidden = true);
    setStatus('Analisando conexão');
    setButton('ANALISANDO', '...', 'AGUARDE');
    text(ui.live, 'Verificando latência, oscilações e falhas de conexão...');
    text(ui.latency, '--');
    text(ui.jitter, '--');
    text(ui.stability, '--');
    text(ui.estimate, '--');
    setProgress(5);

    const connection = browserConnection();
    if (!connection.online) {
      finishError('O navegador informa que o dispositivo está sem conexão com a internet.');
      return;
    }

    const results = [];
    for (let i = 0; i < 10; i++) {
      const result = await requestOnce(i);
      results.push(result);
      setProgress(10 + (i + 1) * 7);
      text(ui.live, `Analisando conexão: ${i + 1} de 10 verificações`);
      await sleep(100);
    }

    const successful = results.filter(result => result.ok).map(result => result.ms);
    if (successful.length < 3) {
      finishError('Não foi possível obter respostas suficientes do servidor. Verifique bloqueadores, VPN ou instabilidade da rede.');
      return;
    }

    const latency = median(successful);
    const variations = successful.slice(1).map((value, index) => Math.abs(value - successful[index]));
    const jitter = median(variations);
    const loss = ((results.length - successful.length) / results.length) * 100;
    const stability = loss === 0 && jitter < 20 ? 'Ótima' : loss <= 10 && jitter < 45 ? 'Boa' : loss <= 20 && jitter < 90 ? 'Regular' : 'Instável';
    const overall = overallRating(latency, jitter, loss, connection.downlink);

    text(ui.latency, Math.round(latency));
    text(ui.jitter, jitter.toFixed(1));
    text(ui.stability, stability);
    text(ui.estimate, connection.downlink !== null ? connection.downlink.toFixed(connection.downlink >= 10 ? 0 : 1) : 'N/D');
    text(ui.live, `Diagnóstico concluído: conexão ${overall.label.toLowerCase()}`);
    setStatus('Diagnóstico concluído');
    setProgress(100);
    setButton('RESULTADO', overall.label.toUpperCase(), 'CONEXÃO');

    if (ui.diagnosis) {
      ui.diagnosis.className = `speed-diagnosis speedtest-diagnosis ${overall.cls === 'bad' ? 'bad' : overall.cls === 'regular' ? 'warn' : 'good'}`;
      const estimate = connection.downlink !== null ? `${connection.downlink} Mbps estimados pelo navegador` : 'velocidade não informada pelo navegador';
      ui.diagnosis.innerHTML = `<strong>${overall.label}</strong> — latência de <strong>${Math.round(latency)} ms</strong>, jitter de <strong>${jitter.toFixed(1)} ms</strong> e <strong>${loss.toFixed(0)}%</strong> de falhas nas requisições. ${estimate}.`;
    }
    renderCards(latency, jitter, loss, connection.downlink);
    finish();
  }

  function finishError(message) {
    setStatus('Não foi possível concluir');
    setProgress(0);
    setButton('TENTAR', 'GO', 'NOVAMENTE');
    text(ui.live, 'A análise não pôde ser concluída.');
    if (ui.diagnosis) {
      ui.diagnosis.className = 'speed-diagnosis speedtest-diagnosis bad';
      ui.diagnosis.textContent = message;
    }
    finish();
  }

  function finish() {
    running = false;
    start.disabled = false;
    ui.shell?.classList.remove('is-testing');
    if (ui.rerun) ui.rerun.hidden = false;
  }

  start.addEventListener('click', run);
  ui.rerun?.addEventListener('click', run);
  window.addEventListener('online', () => setStatus('Conexão detectada'));
  window.addEventListener('offline', () => setStatus('Sem conexão'));
  setStatus(navigator.onLine ? 'Pronto para analisar' : 'Sem conexão');
  setButton('INICIAR', 'GO', 'ANÁLISE');
})();
