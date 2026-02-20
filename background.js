// State
let state = {
  running: false,
  stopped: false,
  downloaded: 0,
  skipped: 0,
  pagesProcessed: 0,
  status: '',
  listTabId: null
};

function log(text, logType = '') {
  console.log(`[LazadaPDF] ${text}`);
  chrome.runtime.sendMessage({ type: 'log', text, logType }).catch(() => {});
}

function sendProgress(status) {
  state.status = status;
  chrome.runtime.sendMessage({
    type: 'progress',
    downloaded: state.downloaded,
    pagesProcessed: state.pagesProcessed,
    skipped: state.skipped,
    status
  }).catch(() => {});
}

function sleep(ms) {
  // Interruptible sleep - checks state.stopped every 200ms
  return new Promise(resolve => {
    if (ms <= 0) { resolve(); return; }
    const start = Date.now();
    const interval = setInterval(() => {
      if (state.stopped || Date.now() - start >= ms) {
        clearInterval(interval);
        resolve();
      }
    }, Math.min(200, ms));
  });
}

// --- Side Panel: open on toolbar icon click ---
// This keeps the extension visible at all times while running
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// --- Navigation & Login Detection ---
const ORDERS_URL = 'https://my.lazada.co.th/customer/order/index/';
const LAZADA_BASE = 'https://my.lazada.co.th';

function isOrdersPage(url) {
  return url && url.includes('my.lazada.co.th/customer/order/index');
}

function isLoginPage(url) {
  return url && (url.includes('member.lazada.co.th/user/login') || url.includes('/login'));
}

async function navigateToOrders(tabId, currentUrl) {
  if (isOrdersPage(currentUrl)) {
    return { ok: true, tabId };
  }

  log('Navigating to Lazada My Orders page...');
  await chrome.tabs.update(tabId, { url: ORDERS_URL });
  await waitForTabLoad(tabId);
  await sleep(2000);

  const tab = await chrome.tabs.get(tabId);
  if (isLoginPage(tab.url)) {
    log('Login required. Please log in to Lazada first.', 'error');
    chrome.runtime.sendMessage({ type: 'needLogin' }).catch(() => {});
    return { ok: false, needLogin: true };
  }

  if (!isOrdersPage(tab.url)) {
    log('Could not navigate to orders page. Please navigate manually.', 'error');
    return { ok: false };
  }

  log('Successfully navigated to orders page.', 'success');
  return { ok: true, tabId };
}

// --- Navigate to a specific page number ---
async function goToPageNumber(tabId, targetPage) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (target) => {
      // Helper: set input value using multiple strategies for React compatibility
      function setInputValue(input, value) {
        const strValue = String(value);

        // Strategy A: Use execCommand('insertText') which triggers React's
        // synthetic event system reliably (simulates real user typing)
        input.focus();
        input.select(); // Select all existing text
        try {
          // Clear existing value first
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeInputValueSetter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));

          // Type the new value via execCommand (triggers React onChange)
          document.execCommand('insertText', false, strValue);
        } catch (_) {
          // Fallback: native setter approach
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeInputValueSetter.call(input, strValue);
        }

        // Fire events to ensure React picks up the change
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // Also fire React 16+ compatible InputEvent
        try {
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: strValue
          }));
        } catch (_) {}
      }

      // Helper: fire Enter key events
      function pressEnter(input) {
        input.focus();
        for (const evtType of ['keydown', 'keypress', 'keyup']) {
          input.dispatchEvent(new KeyboardEvent(evtType, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
          }));
        }
      }

      // Helper: find a clickable "Go" button near a given element
      // Searches siblings and parent's children for a button-like element with text "Go"
      function findGoButton(nearElement) {
        // Search from the nearest pagination ancestor
        let searchRoot = nearElement.parentElement;
        for (let i = 0; i < 5 && searchRoot; i++) {
          // Look for buttons, links, spans with text "Go" (exact match only)
          const candidates = searchRoot.querySelectorAll('button, a, span, div');
          for (const el of candidates) {
            // Check DIRECT text content (not children's text) to avoid matching "Go to" label
            const directText = Array.from(el.childNodes)
              .filter(n => n.nodeType === Node.TEXT_NODE)
              .map(n => n.textContent.trim())
              .join('')
              .toLowerCase();
            // Also check full trimmed text for simple elements with no children
            const fullText = el.textContent.trim().toLowerCase();
            const hasChildren = el.children.length > 0;

            if (directText === 'go' || (!hasChildren && fullText === 'go')) {
              return el;
            }
          }
          searchRoot = searchRoot.parentElement;
        }

        // Fallback: search the entire document for any element that's just "Go" text
        // near a pagination context
        const allElements = document.querySelectorAll('button, a, span[role="button"], div[role="button"]');
        for (const el of allElements) {
          const text = el.textContent.trim().toLowerCase();
          if (text === 'go' && el.offsetParent !== null) {
            // Make sure it's visible and near pagination area
            return el;
          }
        }
        return null;
      }

      // --- Search for pagination container (try multiple selectors) ---
      const pagSelectors = [
        '.order-pagination',
        '[class*="pagination"]',
        '.next-pagination',
        '[class*="pager"]'
      ];
      let pag = null;
      for (const sel of pagSelectors) {
        pag = document.querySelector(sel);
        if (pag) break;
      }
      if (!pag) return { ok: false, reason: 'no-pagination' };

      // Strategy 1: Try clicking the page number button directly if visible
      const pageButtons = [...pag.querySelectorAll('button, li, a')];
      for (const btn of pageButtons) {
        const text = btn.textContent.trim();
        if (text === String(target) && !btn.className.includes('current') && !btn.className.includes('active')) {
          btn.click();
          return { ok: true, method: 'button-click' };
        }
      }

      // Strategy 2: Find "Go to" input and "Go" button
      // Search broadly - the Go input might be a sibling/cousin of the pagination, not inside it
      // First search inside pagination, then search the pagination's parent containers
      let goInput = null;
      let searchAreas = [pag];
      // Also add parent and grandparent to search area
      if (pag.parentElement) searchAreas.push(pag.parentElement);
      if (pag.parentElement && pag.parentElement.parentElement) {
        searchAreas.push(pag.parentElement.parentElement);
      }

      for (const area of searchAreas) {
        const inputs = area.querySelectorAll('input');
        for (const inp of inputs) {
          const type = inp.type.toLowerCase();
          if (type === 'number' || type === 'text' || type === 'tel' || type === '') {
            goInput = inp;
            break;
          }
        }
        if (goInput) break;
      }

      if (!goInput) {
        // Last resort: find any input near text "Go to" in the whole page
        const allInputs = document.querySelectorAll('input[type="number"], input[type="text"], input[type="tel"], input:not([type])');
        for (const inp of allInputs) {
          const parentText = (inp.parentElement?.textContent || '').toLowerCase();
          if (parentText.includes('go to') || parentText.includes('page')) {
            goInput = inp;
            break;
          }
        }
      }

      if (goInput) {
        // Set the value
        setInputValue(goInput, target);

        // Find and click the "Go" button
        const goBtn = findGoButton(goInput);
        if (goBtn) {
          // Delay to let React process the input value change before clicking
          await new Promise(r => setTimeout(r, 300));
          goBtn.click();
          // Also press Enter on the input as a belt-and-suspenders approach
          await new Promise(r => setTimeout(r, 100));
          pressEnter(goInput);
          return { ok: true, method: 'go-button', debug: `Found Go btn tag=${goBtn.tagName} text="${goBtn.textContent.trim()}"` };
        }

        // No Go button found - try Enter key as fallback
        await new Promise(r => setTimeout(r, 300));
        pressEnter(goInput);
        return { ok: true, method: 'enter-key', debug: 'Go button not found, used Enter key' };
      }

      // Strategy 3: Broader jump input selectors
      const jumpInput = document.querySelector(
        '.next-pagination-jump input, [class*="jump"] input, ' +
        '[class*="pagination"] input'
      );
      if (jumpInput) {
        setInputValue(jumpInput, target);
        const goBtn = findGoButton(jumpInput);
        if (goBtn) {
          await new Promise(r => setTimeout(r, 300));
          goBtn.click();
          await new Promise(r => setTimeout(r, 100));
          pressEnter(jumpInput);
          return { ok: true, method: 'jump-go-button' };
        }
        await new Promise(r => setTimeout(r, 300));
        pressEnter(jumpInput);
        return { ok: true, method: 'jump-enter-key' };
      }

      return { ok: false, reason: 'no-input-found', debug: `Searched ${searchAreas.length} areas, pag class="${pag.className}"` };
    },
    args: [targetPage]
  });

  const result = results[0]?.result;
  if (result) {
    if (result.ok) {
      log(`Page jump: navigated to page ${targetPage} via ${result.method}${result.debug ? ' (' + result.debug + ')' : ''}`);
    } else {
      log(`Page jump failed: ${result.reason}${result.debug ? ' (' + result.debug + ')' : ''}`, 'error');
    }
    return result.ok;
  }
  return false;
}

// --- Extract order links from the order list page ---
async function extractOrdersFromPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const shops = document.querySelectorAll('.shop.shop-cursor');
      const orders = [];
      const seen = new Set();

      for (const shop of shops) {
        const fiberKey = Object.keys(shop).find(k => k.startsWith('__reactInternalInstance'));
        if (!fiberKey) continue;
        const fiber = shop[fiberKey];
        if (!fiber || !fiber.return) continue;
        const props = fiber.return.memoizedProps;
        if (!props || !props.componentData || !props.componentData.fields) continue;

        const fields = props.componentData.fields;
        const shopGroupKey = fields.shopGroupKey;
        const tradeOrderId = fields.tradeOrderId;

        if (!shopGroupKey || !tradeOrderId) continue;

        const dedupeKey = `${shopGroupKey}_${tradeOrderId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        orders.push({
          shopGroupKey,
          tradeOrderId: String(tradeOrderId),
          shopName: fields.name || '',
          status: fields.status || ''
        });
      }
      return orders;
    }
  });

  return results[0]?.result || [];
}

// --- Pagination ---
async function getPaginationInfo(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pag = document.querySelector('.order-pagination');
      if (!pag) return { currentPage: 1, totalPages: 1 };

      const buttons = [...pag.querySelectorAll('button')];
      const currentBtn = buttons.find(b => b.className.includes('current'));
      const currentPage = currentBtn ? parseInt(currentBtn.textContent) : 1;

      const pageText = pag.textContent;
      const match = pageText.match(/(\d+)\s*\/\s*(\d+)/);
      const totalPages = match ? parseInt(match[2]) : 1;

      return { currentPage, totalPages };
    }
  });

  return results[0]?.result || { currentPage: 1, totalPages: 1 };
}

async function goToNextPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pag = document.querySelector('.order-pagination');
      if (!pag) return false;
      const nextArrow = pag.querySelector('.next-pagination-item.next');
      if (nextArrow && !nextArrow.disabled) {
        nextArrow.click();
        return true;
      }
      return false;
    }
  });

  return results[0]?.result || false;
}

async function waitForPageLoad(tabId, previousFirstOrder) {
  for (let i = 0; i < 20; i++) {
    if (state.stopped) return false;
    await sleep(500);
    if (state.stopped) return false;
    const orders = await extractOrdersFromPage(tabId);
    if (orders.length > 0) {
      if (!previousFirstOrder || orders[0].shopGroupKey !== previousFirstOrder) {
        return true;
      }
    }
  }
  return false;
}

// --- Get the date of the first order on a given page ---
// This opens a detail tab to check the date, then closes it.
// Returns the date string or null.
async function sampleDateFromPage(tabId, orders) {
  if (!orders || orders.length === 0) return null;
  const order = orders[0];
  const baseUrl = 'https://my.lazada.co.th/customer/order/view/';
  const url = `${baseUrl}?shopGroupKey=${encodeURIComponent(order.shopGroupKey)}&tradeOrderId=${encodeURIComponent(order.tradeOrderId)}`;

  let detailTabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    detailTabId = tab.id;
    await waitForTabLoad(detailTabId);
    await sleep(2000);

    const dateResults = await chrome.scripting.executeScript({
      target: { tabId: detailTabId },
      func: () => {
        const text = document.body.innerText;
        const match = text.match(/Placed on\s+(\d{1,2}\s+\w+\s+\d{4})/);
        return match ? match[1] : null;
      }
    });

    return dateResults[0]?.result || null;
  } catch (e) {
    return null;
  } finally {
    if (detailTabId) {
      try { await chrome.tabs.remove(detailTabId); } catch (_) {}
    }
  }
}

// --- Smart page finder using binary search ---
// Orders are sorted newest-first. We want to find the first page
// that contains orders within our date range.
// Returns the page number to start from.
async function findStartPage(tabId, dateFrom, dateTo, totalPages) {
  if (!dateTo || totalPages <= 2) return 1;

  log(`Smart navigation: searching ${totalPages} pages for date range start...`);
  sendProgress('Smart navigation: finding the right page...');

  // Check page 1 first - if the newest orders are already in range, start from page 1
  const page1Orders = await extractOrdersFromPage(tabId);
  const page1Date = await sampleDateFromPage(tabId, page1Orders);

  if (page1Date) {
    log(`Page 1 first order date: ${page1Date}`);
    if (dateTo && isDateBeforeRange(page1Date, dateTo)) {
      // Page 1 orders are AFTER our dateTo? No, isDateBeforeRange checks if date < from.
      // We need: if page1Date > dateTo, all orders are too new... but orders are newest-first
      // so page 1 is the newest. If page1 date is within range, start here.
    }
    // If page 1 date is within our range, just start from page 1
    if (isDateInRange(page1Date, dateFrom, dateTo)) {
      log('Page 1 already contains orders in range. Starting from page 1.', 'success');
      return 1;
    }
    // If page 1 date is AFTER dateTo (orders newer than our range), we need to go forward
    const d = parseDate(page1Date);
    const to = dateTo ? new Date(dateTo + 'T23:59:59') : null;
    if (d && to && d > to) {
      log(`Page 1 orders (${page1Date}) are newer than ${dateTo}. Searching deeper...`);
      // Binary search: find the page where dates fall into range
      let lo = 1, hi = totalPages;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        log(`Binary search: checking page ${mid}/${totalPages}...`);
        sendProgress(`Smart search: checking page ${mid}/${totalPages}...`);

        // Navigate to page mid
        const prevFirst = (await extractOrdersFromPage(tabId))[0]?.shopGroupKey;
        const jumped = await goToPageNumber(tabId, mid);
        let contentLoaded = false;
        if (jumped) {
          contentLoaded = await waitForPageLoad(tabId, prevFirst);
          await sleep(1000);

          if (!contentLoaded) {
            // Page content didn't change - the Go button navigation likely failed.
            // Retry: try navigating again with a fresh attempt
            log(`Page ${mid} content did not change after navigation. Retrying...`);
            const prevFirst2 = (await extractOrdersFromPage(tabId))[0]?.shopGroupKey;
            const jumped2 = await goToPageNumber(tabId, mid);
            if (jumped2) {
              contentLoaded = await waitForPageLoad(tabId, prevFirst2);
              await sleep(1000);
            }

            if (!contentLoaded) {
              // Last resort: full page reload with page parameter in URL
              log(`Retry failed. Trying URL-based navigation to page ${mid}...`);
              try {
                const tab = await chrome.tabs.get(tabId);
                const currentUrl = new URL(tab.url);
                currentUrl.searchParams.set('page', String(mid));
                await chrome.tabs.update(tabId, { url: currentUrl.toString() });
                await waitForTabLoad(tabId);
                await sleep(2000);
                contentLoaded = true; // URL navigation forces full reload
              } catch (e) {
                log(`URL navigation failed: ${e.message}`, 'error');
              }
            }
          }

          if (!contentLoaded) {
            // Still failed - don't trust this page's data
            log(`Page ${mid} unreachable after all attempts. Skipping.`, 'error');
            hi = mid;
            continue;
          }

          // Verify we actually landed on the correct page
          const pageInfo = await getPaginationInfo(tabId);
          if (pageInfo.currentPage !== mid) {
            log(`Navigation check: expected page ${mid}, on page ${pageInfo.currentPage}. Adjusting.`);
            // Use the actual page we're on for the binary search decision
            // Don't retry again - we already retried above
          }
        } else {
          // Can't jump, fall back to sequential from page 1
          log('Cannot jump to page directly. Will scan sequentially.', 'error');
          // Navigate back to page 1
          const pf = (await extractOrdersFromPage(tabId))[0]?.shopGroupKey;
          await goToPageNumber(tabId, 1);
          await waitForPageLoad(tabId, pf);
          await sleep(1000);
          return 1;
        }

        const midOrders = await extractOrdersFromPage(tabId);
        const midDate = await sampleDateFromPage(tabId, midOrders);

        if (!midDate) {
          // Can't determine date, be safe and go left
          hi = mid;
          continue;
        }

        log(`Page ${mid} first order date: ${midDate}`);
        const midD = parseDate(midDate);

        if (midD && to && midD > to) {
          // Still too new, go right (deeper into older orders)
          lo = mid + 1;
        } else {
          // This page or earlier might be our start
          hi = mid;
        }
      }

      // Navigate to the found page
      // Go back one page to be safe (might have orders spanning the boundary)
      const startPage = Math.max(1, lo - 1);
      log(`Smart navigation: starting from page ${startPage}.`, 'success');

      const prevFirst2 = (await extractOrdersFromPage(tabId))[0]?.shopGroupKey;
      await goToPageNumber(tabId, startPage);
      await waitForPageLoad(tabId, prevFirst2);
      await sleep(1000);

      return startPage;
    }
  }

  return 1;
}

// --- Cleanup: DOM removal + CSS to prepare page for PDF ---
async function injectCleanupCSS(tabId, options) {

  // STEP 1: Run JS in MAIN world to physically REMOVE elements from the DOM.
  // This is far more reliable than CSS hiding because removed elements
  // don't occupy any layout space, so remaining content naturally expands.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (opts) => {
        // Helper: remove element from DOM
        function nuke(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

        // Helper: remove all matching selectors
        function nukeAll(selector) {
          document.querySelectorAll(selector).forEach(nuke);
        }

        // --- ALWAYS remove our injected PDF button ---
        nuke(document.getElementById('lazada-pdf-ext-btn'));

        // --- Remove sidebar ---
        if (opts.cutSideMenu) {
          // 1. Direct approach: find the element containing "Manage My Account" text
          //    and walk up to find its container to remove
          const walker = document.createTreeWalker(
            document.body, NodeFilter.SHOW_TEXT, null, false
          );
          const sidebarTexts = ['Manage My Account', 'My Wishlist', 'Sell On Lazada'];
          const elementsToRemove = new Set();

          while (walker.nextNode()) {
            const text = walker.currentNode.textContent.trim();
            for (const st of sidebarTexts) {
              if (text === st) {
                // Walk up to find a substantial container (not just a span)
                let el = walker.currentNode.parentElement;
                for (let i = 0; i < 10 && el; i++) {
                  const w = el.offsetWidth || 0;
                  const h = el.offsetHeight || 0;
                  // Sidebar is typically 150-250px wide, full height
                  if (w > 100 && w < 350 && h > 200) {
                    elementsToRemove.add(el);
                    break;
                  }
                  el = el.parentElement;
                }
              }
            }
          }
          elementsToRemove.forEach(nuke);

          // 2. Selector-based removal for common sidebar patterns
          nukeAll([
            '.left-content', '.my-account-left', '.account-sidebar',
            '.sidebar', '.left-sidebar', '.nav-sidebar',
            '.my-lazada-sidebar', '.lzd-aside', '.account-left',
            '.ant-layout-sider',
            '[class*="sidebar" i]', '[class*="left-nav" i]',
            '[class*="account-left" i]', '[class*="account-menu" i]',
            '[class*="side-menu" i]', '[class*="layout-sider" i]',
            '[data-spm*="sidebar"]', '[data-spm*="leftmenu"]'
          ].join(','));

          // 3. Only fix the direct layout ancestors that held sidebar + content
          //    Walk UP from the main content area, not down through all elements
          const mainContent = document.querySelector(
            '[class*="right-content" i], [class*="account-right" i], ' +
            '[class*="order-detail" i], [class*="account-content" i]'
          );
          if (mainContent) {
            let el = mainContent;
            while (el && el !== document.body) {
              const cs = window.getComputedStyle(el);
              // Only fix large left margins/paddings on direct ancestors
              const ml = parseFloat(cs.marginLeft) || 0;
              if (ml > 150) el.style.marginLeft = '0px';
              // Remove max-width constraints
              const mw = parseFloat(cs.maxWidth);
              if (mw > 0 && mw < window.innerWidth) el.style.maxWidth = '100%';
              el = el.parentElement;
            }
          }
        }

        // --- Remove ads ---
        if (opts.cutAds) {
          nukeAll([
            '.pdp-block', '.recommend', '.J_SimilarProduct', '.banner',
            '[class*="recommend" i]', '[class*="promotion" i]', '[class*="banner" i]',
            '[class*="advert" i]', '[class*="campaign" i]',
            '[data-spm*="recommend"]', '.J_DC_coupon',
            '.order-detail-bottom-recommend', '.pdp-mod-recommend',
            '.mod-order-detail-recommend', '.detail-recommend',
            'iframe[src*="ad"]', '.ads-container'
          ].join(','));
        }

        // --- Remove header ---
        if (opts.cutHeader) {
          nukeAll([
            '#topActionHeader', '.lzd-header', 'header', '.top-bar',
            '[class*="header-wrap" i]', '[class*="top-bar" i]',
            '.lzd-site-top', '#asc_header', '.next-overlay-wrapper',
            'nav[class*="header" i]',
            '[class*="lazada-header" i]'
          ].join(','));
        }

        // --- Remove footer ---
        if (opts.cutFooter) {
          nukeAll([
            'footer', '.footer', '.lzd-footer',
            '[class*="footer" i]',
            '.site-footer', '.page-footer',
            '.lzd-site-bottom', '[class*="bottom-bar" i]',
            '[data-spm*="footer"]'
          ].join(','));
        }

      },
      args: [options]
    });
  } catch (e) {
    log(`DOM cleanup warning: ${e.message}`, 'error');
  }

  // STEP 2: Apply CSS to expand content after sidebar removal.
  // Be careful not to override ALL widths which breaks internal layouts.
  const cssRules = [];

  cssRules.push(`
    /* Hide our injected button in print */
    #lazada-pdf-ext-btn { display: none !important; }

    /* Basic page reset */
    body, html {
      overflow-x: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    /* Expand the main content area that was next to sidebar */
    [class*="right-content" i], [class*="account-right" i],
    [class*="account-content" i] {
      width: 100% !important;
      max-width: 100% !important;
      margin-left: 0 !important;
      box-sizing: border-box !important;
    }

    /* Remove max-width constraints on top-level layout wrappers only */
    body > div > [class*="container" i],
    body > div > [class*="wrapper" i],
    body > [class*="container" i],
    body > [class*="wrapper" i] {
      max-width: 100% !important;
    }

    /* Print optimizations */
    @media print {
      body { margin: 0 !important; padding: 0 !important; }
      #lazada-pdf-ext-btn { display: none !important; }
    }
    @page { margin: 0; }
  `);

  await chrome.scripting.insertCSS({
    target: { tabId },
    css: cssRules.join('\n')
  });
}

// --- Print tab to PDF ---
async function printTabToPDF(tabId, filename, fitOnePage) {
  await chrome.debugger.attach({ tabId }, '1.3');

  try {
    const pdfOptions = {
      printBackground: true,
      preferCSSPageSize: false,
      paperWidth: 8.27,   // A4
      paperHeight: 11.69,  // A4
      marginTop: 0.3,
      marginBottom: 0.3,
      marginLeft: 0.3,
      marginRight: 0.3
    };

    if (fitOnePage) {
      // Get the content layout metrics at the current viewport
      const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      if (metrics && metrics.contentSize) {
        const contentHeight = metrics.contentSize.height;
        const contentWidth = metrics.contentSize.width;

        // Available print area in inches (A4 with margins)
        const availableWidthIn = 8.27 - 0.6;  // ~7.67in
        const availableHeightIn = 11.69 - 0.6; // ~11.09in
        const availableWidthPx = availableWidthIn * 96;  // ~737px
        const availableHeightPx = availableHeightIn * 96; // ~1065px

        // Only scale DOWN, never up — scaling up causes overlapping
        const scaleX = availableWidthPx / contentWidth;
        const scaleY = availableHeightPx / contentHeight;
        let scale = Math.min(scaleX, scaleY);
        scale = Math.min(scale, 1.0);  // NEVER scale up
        scale = Math.max(scale, 0.3);  // Don't go too tiny

        if (contentHeight * scale > availableHeightPx) {
          // Even after scaling, content is taller than one A4 page
          // Use a taller paper to fit everything
          const neededHeightIn = (contentHeight * scale) / 96 + 0.6;
          pdfOptions.paperHeight = neededHeightIn;
        }

        pdfOptions.scale = scale;
      }
    }

    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', pdfOptions);

    const dataUrl = 'data:application/pdf;base64,' + result.data;

    await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false
    });

    await sleep(500);
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {}
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    let resolved = false;
    function done() {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(stopCheck);
      clearTimeout(timeout);
      resolve();
    }
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        done();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Check for stop every 200ms so stop button responds quickly
    const stopCheck = setInterval(() => {
      if (state.stopped) done();
    }, 200);
    const timeout = setTimeout(done, 30000);
  });
}

// --- Date helpers ---
function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

function formatDateForFilename(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return 'unknown-date';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isDateInRange(dateStr, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return true;
  const d = parseDate(dateStr);
  if (!d) return true;

  if (dateFrom) {
    const from = new Date(dateFrom + 'T00:00:00');
    if (d < from) return false;
  }
  if (dateTo) {
    const to = new Date(dateTo + 'T23:59:59');
    if (d > to) return false;
  }
  return true;
}

function isDateBeforeRange(dateStr, dateFrom) {
  if (!dateFrom) return false;
  const d = parseDate(dateStr);
  if (!d) return false;
  const from = new Date(dateFrom + 'T00:00:00');
  return d < from;
}

function sanitizeFilename(str) {
  return str.replace(/[^a-zA-Z0-9\-_ ]/g, '').trim();
}

// --- Status matching ---
function isStatusExcluded(orderStatus, excludedStatuses) {
  if (!excludedStatuses || excludedStatuses.length === 0) return false;
  if (!orderStatus) {
    return excludedStatuses.includes('Other');
  }

  const statusLower = orderStatus.toLowerCase();

  for (const excluded of excludedStatuses) {
    const exLower = excluded.toLowerCase();
    if (statusLower.includes(exLower) || exLower.includes(statusLower)) {
      return true;
    }
  }

  const knownStatuses = ['delivered', 'completed', 'in transit', 'pending', 'cancelled', 'returned'];
  const isKnown = knownStatuses.some(k => statusLower.includes(k));
  if (!isKnown && excludedStatuses.includes('Other')) {
    return true;
  }

  return false;
}

// --- Main process ---
async function startProcess(tabId, tabUrl, dateFrom, dateTo, delayMs, options) {
  state.running = true;
  state.stopped = false;
  state.downloaded = 0;
  state.skipped = 0;
  state.pagesProcessed = 0;

  try {
    // Step 1: Navigate to orders page if needed
    const navResult = await navigateToOrders(tabId, tabUrl);
    if (!navResult.ok) {
      state.running = false;
      if (!navResult.needLogin) {
        chrome.runtime.sendMessage({ type: 'error', text: 'Could not navigate to orders page.' }).catch(() => {});
      }
      return;
    }

    state.listTabId = tabId;

    // Log filter configuration
    log(`--- Filter Configuration ---`);
    log(`Date range: ${dateFrom || 'any'} to ${dateTo || 'any'}`);
    log(`Excluded statuses: ${options.excludedStatuses.length > 0 ? options.excludedStatuses.join(', ') : 'none'}`);
    log(`PDF options: ${[
      options.cutAds ? 'no-ads' : '',
      options.cutSideMenu ? 'no-sidebar' : '',
      options.cutHeader ? 'no-header' : '',
      options.cutFooter ? 'no-footer' : '',
      options.fitOnePage ? 'fit-one-page' : ''
    ].filter(Boolean).join(', ')}`);
    log(`Delay: ${delayMs}ms between orders`);
    log(`Duplicates: tracked in memory (resets on extension restart)`);
    log(`----------------------------`);

    const globalSeen = new Set();

    const { totalPages } = await getPaginationInfo(tabId);
    log(`Found ${totalPages} page${totalPages > 1 ? 's' : ''} of orders.`);

    // Smart navigation: jump to the right page range
    let startPage = 1;
    if (totalPages > 2 && dateTo) {
      startPage = await findStartPage(tabId, dateFrom, dateTo, totalPages);
    }

    let pageNum = startPage;
    let reachedEndOfRange = false;

    // If we jumped to a page > 1, we need to navigate there
    if (startPage > 1) {
      const { currentPage } = await getPaginationInfo(tabId);
      if (currentPage !== startPage) {
        const prevFirst = (await extractOrdersFromPage(tabId))[0]?.shopGroupKey;
        await goToPageNumber(tabId, startPage);
        await waitForPageLoad(tabId, prevFirst);
        await sleep(1000);
      }
    }

    while (pageNum <= totalPages && !state.stopped && !reachedEndOfRange) {
      const pageLabel = `page ${pageNum}/${totalPages}`;
      log(`--- Processing ${pageLabel} ---`);
      sendProgress(`Scanning ${pageLabel}...`);

      // Navigate to next page if needed (skip for first iteration)
      if (pageNum > startPage) {
        const prevFirst = (await extractOrdersFromPage(tabId))[0]?.shopGroupKey;
        const navigated = await goToNextPage(tabId);
        if (!navigated) {
          log(`Could not navigate to next page after page ${pageNum - 1}.`, 'error');
          break;
        }
        await waitForPageLoad(tabId, prevFirst);
        await sleep(1000);
      }

      const orders = await extractOrdersFromPage(tabId);
      log(`Found ${orders.length} order${orders.length !== 1 ? 's' : ''} on ${pageLabel}.`);

      if (orders.length === 0) {
        log('No orders found on this page. Stopping.');
        break;
      }

      for (let i = 0; i < orders.length; i++) {
        if (state.stopped) break;

        const order = orders[i];
        const orderLabel = `[${pageLabel}, #${i + 1}/${orders.length}] ${order.tradeOrderId}`;

        // Global dedup (in-memory only - resets on extension restart)
        if (globalSeen.has(order.tradeOrderId)) {
          log(`${orderLabel} - duplicate, skipping.`);
          state.skipped++;
          sendProgress(`${pageLabel}: skip dup ${order.tradeOrderId}`);
          continue;
        }
        globalSeen.add(order.tradeOrderId);

        // Status filter
        if (isStatusExcluded(order.status, options.excludedStatuses)) {
          log(`${orderLabel} - status "${order.status}" excluded, skipping.`);
          state.skipped++;
          sendProgress(`${pageLabel}: skip ${order.tradeOrderId} (${order.status})`);
          continue;
        }

        if (state.stopped) break;
        sendProgress(`${pageLabel}: checking ${order.shopName} (${order.tradeOrderId})`);

        let detailTabId = null;
        try {
          const baseUrl = 'https://my.lazada.co.th/customer/order/view/';
          const url = `${baseUrl}?shopGroupKey=${encodeURIComponent(order.shopGroupKey)}&tradeOrderId=${encodeURIComponent(order.tradeOrderId)}`;

          const tab = await chrome.tabs.create({ url, active: false });
          detailTabId = tab.id;

          await waitForTabLoad(detailTabId);
          await sleep(2500);

          if (state.stopped) {
            try { await chrome.tabs.remove(detailTabId); } catch (_) {}
            break;
          }

          // Get placed date
          const dateResults = await chrome.scripting.executeScript({
            target: { tabId: detailTabId },
            func: () => {
              const text = document.body.innerText;
              const match = text.match(/Placed on\s+(\d{1,2}\s+\w+\s+\d{4})/);
              return match ? match[1] : null;
            }
          });

          const orderDate = dateResults[0]?.result;
          log(`${orderLabel} - "${order.shopName}" placed ${orderDate || 'unknown date'}, status: ${order.status || 'unknown'}`);

          // Early stop
          if (orderDate && isDateBeforeRange(orderDate, dateFrom)) {
            log(`${orderLabel} - date ${orderDate} is before range start ${dateFrom}. All remaining orders are older. Stopping.`, 'success');
            reachedEndOfRange = true;
            try { await chrome.tabs.remove(detailTabId); } catch (_) {}
            break;
          }

          // Skip if outside date range
          if (!isDateInRange(orderDate, dateFrom, dateTo)) {
            const reason = orderDate
              ? `date ${orderDate} outside range ${dateFrom || '*'} to ${dateTo || '*'}`
              : 'could not determine date';
            log(`${orderLabel} - ${reason}, skipping.`);
            state.skipped++;
            sendProgress(`${pageLabel}: skip ${order.tradeOrderId} (out of date range)`);
            try { await chrome.tabs.remove(detailTabId); } catch (_) {}
            await sleep(500);
            continue;
          }

          // In range - apply CSS and print PDF
          await injectCleanupCSS(detailTabId, options);
          await sleep(800); // Wait for DOM removal + CSS reflow before PDF

          const dateForFile = formatDateForFilename(orderDate);
          const shopClean = sanitizeFilename(order.shopName) || 'shop';
          const filename = `Lazada_Orders/${dateForFile}_${order.tradeOrderId}_${shopClean}.pdf`;

          sendProgress(`Saving PDF: ${order.tradeOrderId} (${order.shopName})`);

          await printTabToPDF(detailTabId, filename, options.fitOnePage);
          state.downloaded++;
          log(`${orderLabel} - SAVED: ${filename}`, 'success');
          sendProgress(`Saved ${state.downloaded} PDFs (${pageLabel})`);

          try { await chrome.tabs.remove(detailTabId); } catch (_) {}
          detailTabId = null;

          if (delayMs > 0) {
            await sleep(delayMs);
          }

        } catch (err) {
          log(`${orderLabel} - ERROR: ${err.message}`, 'error');
          if (detailTabId) {
            try { await chrome.tabs.remove(detailTabId); } catch (_) {}
          }
          await sleep(1000);
        }
      }

      state.pagesProcessed++;
      sendProgress(`Completed ${pageLabel}`);
      pageNum++;
    }

    state.running = false;

    // Summary
    log(`--- Summary ---`);
    log(`Total PDFs saved: ${state.downloaded}`);
    log(`Total skipped: ${state.skipped}`);
    log(`Pages processed: ${state.pagesProcessed}`);
    log(`---------------`);

    chrome.runtime.sendMessage({
      type: state.stopped ? 'stopped' : 'done',
      downloaded: state.downloaded,
      skipped: state.skipped
    }).catch(() => {});

  } catch (err) {
    state.running = false;
    log(`Fatal error: ${err.message}`, 'error');
    chrome.runtime.sendMessage({ type: 'error', text: err.message }).catch(() => {});
  }
}

// --- Message handler ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'start') {
    const options = {
      cutAds: msg.cutAds !== false,
      cutSideMenu: msg.cutSideMenu !== false,
      cutHeader: msg.cutHeader === true,
      cutFooter: msg.cutFooter === true,
      fitOnePage: msg.fitOnePage !== false,
      excludedStatuses: msg.excludedStatuses || []
    };
    // delayMs is now in milliseconds directly
    const delayMs = msg.delayMs != null ? msg.delayMs : 500;
    startProcess(msg.tabId, msg.tabUrl, msg.dateFrom, msg.dateTo, delayMs, options);
    sendResponse({ ok: true });
  } else if (msg.action === 'stop') {
    state.stopped = true;
    sendResponse({ ok: true });
  } else if (msg.action === 'getState') {
    sendResponse({
      running: state.running,
      downloaded: state.downloaded,
      pagesProcessed: state.pagesProcessed,
      skipped: state.skipped,
      status: state.status
    });
  } else if (msg.action === 'openFolder') {
    // Try to open the downloads folder
    chrome.downloads.showDefaultFolder();
    sendResponse({ ok: true });
  } else if (msg.action === 'openSidePanel') {
    // Open side panel from content script floating button
    if (sender.tab) {
      // Try with windowId first (more reliable), fallback to tabId
      chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {
        chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
      });
    }
    sendResponse({ ok: true });
  }
  return true;
});
