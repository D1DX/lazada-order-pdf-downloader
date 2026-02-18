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
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  // If already on orders page, nothing to do
  if (isOrdersPage(currentUrl)) {
    return { ok: true, tabId };
  }

  // Navigate the current tab to orders page
  log('Navigating to Lazada My Orders page...');
  await chrome.tabs.update(tabId, { url: ORDERS_URL });
  await waitForTabLoad(tabId);
  await sleep(2000);

  // Check if we ended up on login page
  const tab = await chrome.tabs.get(tabId);
  if (isLoginPage(tab.url)) {
    log('Login required. Please log in to Lazada first.', 'error');
    chrome.runtime.sendMessage({ type: 'needLogin' }).catch(() => {});
    return { ok: false, needLogin: true };
  }

  // Verify we're on orders page
  if (!isOrdersPage(tab.url)) {
    log('Could not navigate to orders page. Please navigate manually.', 'error');
    return { ok: false };
  }

  log('Successfully navigated to orders page.', 'success');
  return { ok: true, tabId };
}

// --- Extract order links from the order list page ---
// Uses world: 'MAIN' to access React fiber props on DOM elements
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

        // Deduplicate by composite key (shopGroupKey + tradeOrderId)
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
    await sleep(500);
    const orders = await extractOrdersFromPage(tabId);
    if (orders.length > 0) {
      if (!previousFirstOrder || orders[0].shopGroupKey !== previousFirstOrder) {
        return true;
      }
    }
  }
  return false;
}

// --- CSS Injection to clean up order detail page before PDF ---
async function injectCleanupCSS(tabId, options) {
  const cssRules = [];

  if (options.cutAds) {
    // Hide ads, promotions, banners, recommended sections
    cssRules.push(`
      .pdp-block, .recommend, .J_SimilarProduct, .banner,
      [class*="recommend"], [class*="promotion"], [class*="banner"],
      [class*="advert"], [class*="Advert"], [class*="campaign"],
      [data-spm*="recommend"], .J_DC_coupon,
      .order-detail-bottom-recommend, .pdp-mod-recommend,
      .mod-order-detail-recommend, .detail-recommend,
      iframe[src*="ad"], .ads-container { display: none !important; }
    `);
  }

  if (options.cutSideMenu) {
    // Hide left sidebar / navigation
    cssRules.push(`
      .left-content, .my-account-left, .account-sidebar,
      .sidebar, .left-sidebar, .nav-sidebar,
      [class*="sidebar"], [class*="left-nav"],
      .my-lazada-sidebar { display: none !important; }
      .right-content, .main-content, .my-account-right,
      [class*="right-content"], [class*="main-content"] {
        width: 100% !important;
        margin-left: 0 !important;
        padding-left: 0 !important;
      }
    `);
  }

  if (options.cutHeader) {
    // Hide page header / top navigation
    cssRules.push(`
      #topActionHeader, .lzd-header, header, .top-bar,
      [class*="header-wrap"], [class*="top-bar"],
      .lzd-site-top, #asc_header, .next-overlay-wrapper,
      nav[class*="header"] { display: none !important; }
    `);
  }

  if (cssRules.length > 0) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      css: cssRules.join('\n')
    });
  }
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
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4
    };

    if (fitOnePage) {
      // Get the page content height to calculate scale
      const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      if (metrics && metrics.contentSize) {
        const contentHeight = metrics.contentSize.height;
        // Available print height in inches (A4 minus margins)
        const availableHeight = (11.69 - 0.8) * 96; // ~1045 pixels
        const availableWidth = (8.27 - 0.8) * 96;  // ~717 pixels
        const contentWidth = metrics.contentSize.width;

        // Calculate scale to fit content on one page
        const scaleY = availableHeight / contentHeight;
        const scaleX = availableWidth / contentWidth;
        const scale = Math.min(scaleX, scaleY, 1); // Don't upscale

        if (scale < 1 && scale > 0.3) {
          pdfOptions.scale = scale;
        } else if (scale <= 0.3) {
          // Content is too tall even at minimum scale, just use a long page
          pdfOptions.paperHeight = (contentHeight / 96) + 0.8;
        }
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
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

// --- Date helpers ---
function parseDate(dateStr) {
  if (!dateStr) return null;
  // "12 Feb 2026" or "12 Feb 2026 14:30:00" format
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
  if (!d) return true; // If we can't parse, include it

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
    // Unknown status - check if "Other" is excluded
    return excludedStatuses.includes('Other');
  }

  const statusLower = orderStatus.toLowerCase();

  for (const excluded of excludedStatuses) {
    const exLower = excluded.toLowerCase();
    if (statusLower.includes(exLower) || exLower.includes(statusLower)) {
      return true;
    }
  }

  // If status doesn't match any known category, check "Other"
  const knownStatuses = ['delivered', 'completed', 'in transit', 'pending', 'cancelled', 'returned'];
  const isKnown = knownStatuses.some(k => statusLower.includes(k));
  if (!isKnown && excludedStatuses.includes('Other')) {
    return true;
  }

  return false;
}

// --- Main process ---
async function startProcess(tabId, tabUrl, dateFrom, dateTo, delaySeconds, options) {
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

    // Global dedup set across all pages
    const globalSeen = new Set();

    const { totalPages } = await getPaginationInfo(tabId);
    log(`Found ${totalPages} pages of orders.`);

    let pageNum = 1;
    let reachedEndOfRange = false;

    while (pageNum <= totalPages && !state.stopped && !reachedEndOfRange) {
      log(`Processing page ${pageNum}/${totalPages}...`);
      sendProgress(`Scanning page ${pageNum}/${totalPages}...`);

      // Navigate to next page if needed
      if (pageNum > 1) {
        const prevFirst = (await extractOrdersFromPage(tabId))[0]?.shopGroupKey;
        const navigated = await goToNextPage(tabId);
        if (!navigated) {
          log('Could not navigate to next page.', 'error');
          break;
        }
        await waitForPageLoad(tabId, prevFirst);
        await sleep(1000);
      }

      const orders = await extractOrdersFromPage(tabId);
      log(`Found ${orders.length} orders on page ${pageNum}.`);

      if (orders.length === 0) {
        log('No orders found on this page, stopping.');
        break;
      }

      for (let i = 0; i < orders.length; i++) {
        if (state.stopped) break;

        const order = orders[i];

        // Global dedup by tradeOrderId (the actual order identifier)
        if (globalSeen.has(order.tradeOrderId)) {
          log(`Order ${order.tradeOrderId} already processed, skipping duplicate.`);
          state.skipped++;
          sendProgress(`Page ${pageNum}: skipping duplicate ${order.tradeOrderId}`);
          continue;
        }
        globalSeen.add(order.tradeOrderId);

        // Check status filter from order list data
        if (isStatusExcluded(order.status, options.excludedStatuses)) {
          log(`Order ${order.tradeOrderId} status "${order.status}" excluded, skipping.`);
          state.skipped++;
          sendProgress(`Page ${pageNum}: skipping ${order.tradeOrderId} (${order.status})`);
          continue;
        }

        sendProgress(`Page ${pageNum}: checking order ${i + 1}/${orders.length} (${order.shopName})`);

        let detailTabId = null;
        try {
          const baseUrl = 'https://my.lazada.co.th/customer/order/view/';
          const url = `${baseUrl}?shopGroupKey=${encodeURIComponent(order.shopGroupKey)}&tradeOrderId=${encodeURIComponent(order.tradeOrderId)}`;

          const tab = await chrome.tabs.create({ url, active: false });
          detailTabId = tab.id;

          await waitForTabLoad(detailTabId);
          await sleep(2500); // Wait for React to render

          // Get the placed date from detail page
          const dateResults = await chrome.scripting.executeScript({
            target: { tabId: detailTabId },
            func: () => {
              const text = document.body.innerText;
              const match = text.match(/Placed on\s+(\d{1,2}\s+\w+\s+\d{4})/);
              return match ? match[1] : null;
            }
          });

          const orderDate = dateResults[0]?.result;
          log(`Order ${order.tradeOrderId} (${order.shopName}): placed ${orderDate || 'unknown'}`);

          // Early stop: if date is before range start (orders are newest-first)
          if (orderDate && isDateBeforeRange(orderDate, dateFrom)) {
            log(`Order date ${orderDate} is before range start ${dateFrom}. Stopping early.`, 'success');
            reachedEndOfRange = true;
            try { await chrome.tabs.remove(detailTabId); } catch (_) {}
            break;
          }

          // Skip if outside date range
          if (!isDateInRange(orderDate, dateFrom, dateTo)) {
            log(`Order date ${orderDate} is outside range, skipping.`);
            state.skipped++;
            sendProgress(`Page ${pageNum}: skipping ${order.tradeOrderId} (date out of range)`);
            try { await chrome.tabs.remove(detailTabId); } catch (_) {}
            await sleep(500);
            continue;
          }

          // Date is in range - apply CSS cleanup and print to PDF
          await injectCleanupCSS(detailTabId, options);
          await sleep(300); // Let CSS apply

          const dateForFile = formatDateForFilename(orderDate);
          const shopClean = sanitizeFilename(order.shopName) || 'shop';
          const filename = `Lazada_Orders/${dateForFile}_${order.tradeOrderId}_${shopClean}.pdf`;

          sendProgress(`Saving PDF: ${order.tradeOrderId} (${order.shopName})`);

          await printTabToPDF(detailTabId, filename, options.fitOnePage);
          state.downloaded++;
          log(`Saved: ${filename}`, 'success');
          sendProgress(`Saved ${state.downloaded} PDFs (page ${pageNum})`);

          try { await chrome.tabs.remove(detailTabId); } catch (_) {}
          detailTabId = null;

          // Delay between orders
          if (delaySeconds > 0) {
            await sleep(delaySeconds * 1000);
          }

        } catch (err) {
          log(`Error processing order ${order.tradeOrderId}: ${err.message}`, 'error');
          if (detailTabId) {
            try { await chrome.tabs.remove(detailTabId); } catch (_) {}
          }
          await sleep(1000);
        }
      }

      state.pagesProcessed = pageNum;
      sendProgress(`Completed page ${pageNum}/${totalPages}`);
      pageNum++;
    }

    state.running = false;
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
      fitOnePage: msg.fitOnePage !== false,
      excludedStatuses: msg.excludedStatuses || []
    };
    startProcess(msg.tabId, msg.tabUrl, msg.dateFrom, msg.dateTo, msg.delay, options);
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
  }
  return true;
});
