document.addEventListener('DOMContentLoaded', () => {
  const elementos = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window) {
    document.documentElement.classList.add('reveal-ready');

    const observador = new IntersectionObserver((entradas, observer) => {
      entradas.forEach((entrada) => {
        if (entrada.isIntersecting) {
          entrada.target.classList.add('visivel');
          observer.unobserve(entrada.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

    elementos.forEach((item) => observador.observe(item));
  } else {
    elementos.forEach((item) => item.classList.add('visivel'));
  }

  const lightbox = document.getElementById('tutorial-lightbox');
  if (!lightbox) return;

  const imagemAmpliada = lightbox.querySelector('img');
  const botaoFechar = lightbox.querySelector('.lightbox-fechar');
  let ultimoFoco = null;

  const fecharLightbox = () => {
    lightbox.classList.remove('aberto');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-aberto');
    imagemAmpliada.removeAttribute('src');
    if (ultimoFoco) ultimoFoco.focus();
  };

  document.querySelectorAll('[data-lightbox]').forEach((botao) => {
    botao.addEventListener('click', () => {
      const origem = botao.dataset.lightbox;
      if (!origem) return;

      ultimoFoco = botao;
      imagemAmpliada.src = origem;
      imagemAmpliada.alt = botao.querySelector('img')?.alt || 'Imagem ampliada do tutorial';
      lightbox.classList.add('aberto');
      lightbox.setAttribute('aria-hidden', 'false');
      document.body.classList.add('lightbox-aberto');
      botaoFechar?.focus();
    });
  });

  botaoFechar?.addEventListener('click', fecharLightbox);

  lightbox.addEventListener('click', (evento) => {
    if (evento.target === lightbox) fecharLightbox();
  });

  document.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape' && lightbox.classList.contains('aberto')) {
      fecharLightbox();
    }
  });
});
