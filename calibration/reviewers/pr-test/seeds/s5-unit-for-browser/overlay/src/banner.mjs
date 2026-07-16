const DISMISS_KEY = 'promo-dismissed';

export function renderBanner(message) {
  const el = document.createElement('div');
  el.className = 'promo-banner';

  const text = document.createElement('span');
  text.className = 'promo-banner__text';
  text.textContent = message;

  const button = document.createElement('button');
  button.className = 'promo-banner__dismiss';
  button.setAttribute('aria-label', 'Dismiss');
  button.textContent = '×';
  button.addEventListener('click', () => {
    el.classList.add('promo-banner--hidden');
    localStorage.setItem(DISMISS_KEY, '1');
  });

  el.append(text, button);
  return el;
}

export function mountBanner(message) {
  if (localStorage.getItem(DISMISS_KEY) === '1') return null;
  const el = renderBanner(message);
  document.body.prepend(el);
  return el;
}
