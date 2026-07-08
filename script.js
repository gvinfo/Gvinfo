document.addEventListener('DOMContentLoaded', () => {
  const observador = new IntersectionObserver((entradas) => {
    entradas.forEach((entrada) => {
      if (entrada.isIntersecting) entrada.target.classList.add('visivel');
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('.reveal').forEach((item) => observador.observe(item));
});


// Mantém os botões do RustDesk apontando para o instalador Windows x64 mais recente.
// O link inicial é um fallback funcional; ao carregar a página, o script consulta a release mais nova no GitHub.
(async () => {
  const botoesRustDesk = document.querySelectorAll('[data-rustdesk-download]');
  if (!botoesRustDesk.length) return;

  const fallback = 'https://github.com/rustdesk/rustdesk/releases/download/1.4.9/rustdesk-1.4.9-x86_64.exe';

  try {
    const resposta = await fetch('https://api.github.com/repos/rustdesk/rustdesk/releases/latest', { cache: 'no-store' });
    if (!resposta.ok) throw new Error('Não foi possível consultar a última versão do RustDesk.');

    const release = await resposta.json();
    const asset = (release.assets || []).find((item) =>
      /^rustdesk-.*-x86_64\.exe$/i.test(item.name || '')
    );

    const url = asset?.browser_download_url || fallback;
    botoesRustDesk.forEach((botao) => {
      botao.href = url;
      botao.setAttribute('rel', 'noopener');
    });
  } catch (erro) {
    botoesRustDesk.forEach((botao) => {
      botao.href = fallback;
      botao.setAttribute('rel', 'noopener');
    });
  }
})();
