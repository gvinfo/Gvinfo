(() => {
  const btn = document.getElementById('startSpeedTest');
  if (!btn) return;

  const statusEl = document.getElementById('speedStatus');
  const speedValue = document.getElementById('speedValue');
  const downloadMetric = document.getElementById('downloadMetric');
  const pingMetric = document.getElementById('pingMetric');
  const stabilityMetric = document.getElementById('stabilityMetric');
  const diagnosis = document.getElementById('speedDiagnosis');
  const gauge = document.querySelector('.gauge');
  const canvas = document.getElementById('speedChart');
  const ctx = canvas.getContext('2d');

  let samples = [];
  const testFile = 'downloads/AeroAdmin.exe';

  function formatMbps(value){
    if (!Number.isFinite(value)) return '0';
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  }

  function setSpeed(mbps){
    const capped = Math.max(0, Math.min(mbps, 500));
    const percent = (capped / 500) * 37.5;
    const angle = -180 + (capped / 500) * 180;
    gauge.style.setProperty('--percent', percent + '%');
    gauge.style.setProperty('--angle', angle + 'deg');
    speedValue.textContent = formatMbps(mbps);
    downloadMetric.textContent = `${formatMbps(mbps)} Mbps`;
  }

  function drawChart(){
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = 'rgba(255,255,255,.035)';
    ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = 'rgba(167,207,43,.12)';
    ctx.lineWidth = 1;
    for(let i=1;i<5;i++){
      const y = (h/5)*i;
      ctx.beginPath(); ctx.moveTo(36,y); ctx.lineTo(w-24,y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.beginPath(); ctx.moveTo(36,20); ctx.lineTo(36,h-34); ctx.lineTo(w-24,h-34); ctx.stroke();

    const max = Math.max(50, ...samples.map(s => s.mbps)) * 1.18;
    ctx.fillStyle = 'rgba(185,194,176,.78)';
    ctx.font = '22px Inter, Segoe UI, Arial';
    ctx.fillText('Mbps', 44, 34);
    ctx.font = '18px Inter, Segoe UI, Arial';
    ctx.fillText(Math.round(max).toString(), 44, 66);
    ctx.fillText('0', 44, h-42);

    if(samples.length < 2) return;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = 54 + (i / Math.max(samples.length - 1, 1)) * (w - 94);
      const y = (h - 34) - (s.mbps / max) * (h - 76);
      if(i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.strokeStyle = 'rgba(167,207,43,.95)';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    const grad = ctx.createLinearGradient(0, 70, 0, h - 34);
    grad.addColorStop(0, 'rgba(167,207,43,.22)');
    grad.addColorStop(1, 'rgba(167,207,43,0)');
    ctx.lineTo(w-40,h-34); ctx.lineTo(54,h-34); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
  }

  async function ping(){
    const times = [];
    for(let i=0;i<5;i++){
      const start = performance.now();
      try{
        await fetch(`imagens/favicon.png?ping=${Date.now()}-${i}`, {cache:'no-store'});
        times.push(performance.now() - start);
      }catch(e){ /* ignore */ }
    }
    if(!times.length) return null;
    const avg = times.reduce((a,b)=>a+b,0)/times.length;
    return Math.round(avg);
  }

  async function runDownloadTest(){
    samples = [];
    drawChart();
    const start = performance.now();
    const response = await fetch(`${testFile}?test=${Date.now()}`, {cache:'no-store'});
    if(!response.ok) throw new Error('Arquivo de teste indisponível');

    const reader = response.body?.getReader();
    if(!reader){
      const blob = await response.blob();
      const seconds = (performance.now() - start) / 1000;
      return (blob.size * 8) / seconds / 1000000;
    }

    let received = 0;
    let lastTime = start;
    let lastBytes = 0;
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      received += value.length;
      const now = performance.now();
      if(now - lastTime >= 250){
        const mbps = ((received - lastBytes) * 8) / ((now - lastTime)/1000) / 1000000;
        samples.push({t:(now-start)/1000, mbps});
        setSpeed(mbps);
        drawChart();
        lastTime = now;
        lastBytes = received;
      }
    }
    const totalSeconds = (performance.now() - start) / 1000;
    const avg = (received * 8) / totalSeconds / 1000000;
    samples.push({t:totalSeconds, mbps:avg});
    return avg;
  }

  function stabilityLabel(){
    if(samples.length < 3) return 'Boa';
    const values = samples.map(s => s.mbps).filter(v => Number.isFinite(v));
    const avg = values.reduce((a,b)=>a+b,0)/values.length;
    const variance = values.reduce((a,b)=>a+Math.pow(b-avg,2),0)/values.length;
    const cv = Math.sqrt(variance) / Math.max(avg, 1);
    if(cv < .22) return 'Ótima';
    if(cv < .42) return 'Boa';
    return 'Instável';
  }

  function finalText(mbps, pingMs, stability){
    let cls = 'good';
    let text = `Resultado: <strong>${formatMbps(mbps)} Mbps</strong> de download, ping aproximado de <strong>${pingMs ?? '--'} ms</strong> e estabilidade <strong>${stability}</strong>. `;
    if(mbps >= 100){
      text += 'Conexão muito boa para navegação, chamadas, downloads e suporte remoto.';
    } else if(mbps >= 30){
      text += 'Conexão adequada para uso geral e suporte remoto.';
    } else if(mbps >= 10){
      cls = 'warn'; text += 'Conexão utilizável, mas pode apresentar lentidão em downloads, chamadas ou múltiplos dispositivos.';
    } else {
      cls = 'bad'; text += 'Conexão baixa. Pode haver travamentos em chamadas, acesso remoto e navegação.';
    }
    diagnosis.className = `speed-diagnosis ${cls}`;
    diagnosis.innerHTML = text;
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Testando...';
    statusEl.textContent = 'Medindo latência...';
    diagnosis.className = 'speed-diagnosis';
    diagnosis.innerHTML = 'Iniciando teste. Evite downloads, vídeos e outros dispositivos usando a rede durante a medição.';
    setSpeed(0);
    pingMetric.textContent = '-- ms';
    stabilityMetric.textContent = '--';

    try{
      const pingMs = await ping();
      if(pingMs) pingMetric.textContent = `${pingMs} ms`;
      statusEl.textContent = 'Medindo download...';
      const mbps = await runDownloadTest();
      const stability = stabilityLabel();
      setSpeed(mbps);
      stabilityMetric.textContent = stability;
      statusEl.textContent = 'Teste concluído';
      finalText(mbps, pingMs, stability);
    }catch(e){
      statusEl.textContent = 'Erro no teste';
      diagnosis.className = 'speed-diagnosis bad';
      diagnosis.innerHTML = 'Não foi possível executar o teste. Verifique se o arquivo <strong>downloads/AeroAdmin.exe</strong> está no GitHub e tente novamente.';
    }finally{
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  drawChart();
})();
