(() => {
  const pages = (() => {
    const tag = document.getElementById('search-pages');
    return tag ? JSON.parse(tag.textContent || '[]') : [];
  })();
  const dialog = document.querySelector('[data-search-dialog]');
  const input = document.querySelector('[data-search-input]');
  const results = document.querySelector('[data-search-results]');
  const openBtn = document.querySelector('[data-search-open]');
  let selected = 0;

  const matches = () => {
    const q = (input.value || '').trim().toLowerCase();
    if (!q) return [];
    return pages.filter((p) => `${p.title} ${p.description}`.toLowerCase().includes(q));
  };

  const render = () => {
    const list = matches();
    if (selected >= list.length) selected = Math.max(0, list.length - 1);
    results.innerHTML = list.length === 0
      ? `<p class="search-empty">${input.value.trim() ? 'No matches.' : 'Type to search.'}</p>`
      : list.map((p, i) => `
        <a class="search-result${i === selected ? ' selected' : ''}" href="${p.url}">
          <span class="search-result-title">${p.title}</span><br>
          <span class="search-result-desc">${p.description}</span>
        </a>`).join('');
    return list;
  };

  const open = () => { dialog.hidden = false; input.value = ''; input.focus(); render(); };
  const close = () => { dialog.hidden = true; };

  if (openBtn) openBtn.addEventListener('click', open);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (e) => {
    const list = render();
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, list.length - 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
    if (e.key === 'Enter' && list[selected]) window.location.assign(list[selected].url);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); dialog.hidden ? open() : close(); }
    if (e.key === 'Escape' && !dialog.hidden) close();
  });
})();
