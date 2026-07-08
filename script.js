document.addEventListener('DOMContentLoaded', () => {
  const observador = new IntersectionObserver((entradas) => {
    entradas.forEach((entrada) => {
      if (entrada.isIntersecting) entrada.target.classList.add('visivel');
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('.reveal').forEach((item) => observador.observe(item));
});

// Fundo com partículas tecnológicas discretas
(() => {
  const canvas = document.getElementById('particles-bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, particles;

  function resize(){
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    const count = Math.min(85, Math.max(35, Math.floor(w * h / 22000)));
    particles = Array.from({length: count}, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      r: Math.random() * 1.4 + 0.5
    }));
  }

  function draw(){
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = 'rgba(167,207,43,0.34)';
    ctx.strokeStyle = 'rgba(167,207,43,0.12)';
    ctx.lineWidth = 1;

    for (const p of particles){
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < particles.length; i++){
      for (let j = i + 1; j < particles.length; j++){
        const a = particles[i], b = particles[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < 115){
          ctx.globalAlpha = (115 - dist) / 115;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  resize();
  draw();
})();
