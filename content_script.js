// Content script: Injects a floating button on Lazada order pages
// to quickly open the extension side panel.

(function() {
  // Only inject on order-related pages
  if (!window.location.href.includes('my.lazada.co.th/customer/order')) return;

  // Don't inject twice
  if (document.getElementById('lazada-pdf-ext-btn')) return;

  const btn = document.createElement('div');
  btn.id = 'lazada-pdf-ext-btn';
  btn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="12" y1="18" x2="12" y2="12"/>
      <polyline points="9 15 12 18 15 15"/>
    </svg>
    <span style="font-size:11px;font-weight:600;">PDF</span>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #lazada-pdf-ext-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: #f57224;
      color: white;
      border-radius: 28px;
      padding: 10px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 4px 12px rgba(245,114,36,0.4);
      transition: all 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    #lazada-pdf-ext-btn:hover {
      background: #e0611a;
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(245,114,36,0.5);
    }
    #lazada-pdf-ext-btn:active {
      transform: translateY(0);
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(btn);

  btn.addEventListener('click', () => {
    // Ask background to open the side panel
    chrome.runtime.sendMessage({ action: 'openSidePanel' });
  });
})();
