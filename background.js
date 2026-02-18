// State
let state = {
  running: false,
  stopped: false,
  current: 0,
  total: 0,
  downloaded: 0,
  status: '',
  listTabId: null
};

function log(text, logType = '') {
  chrome.runtime.sendMessage({ type: 'log', text, logType }).catch(() => {});
}

function progress(current, total, status) {
  state.current = current;
  state.total = total;
  state.status = status;
  chrome.runtime.sendMessage({ type: 'progress', current, total, status }).catch(() => {});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extract order links from the order list page using injected script
// Must use world: 'MAIN' to access React fiber props on DOM elements
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
        // Deduplicate by shopGroupKey
        if (seen.has(shopGroupKey)) continue;
        seen.add(shopGroupKey);

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

// Get pagination info from the order list page
async function getPaginationInfo(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pag = document.querySelector('.order-pagination');
      if (!pag) return { currentPage: 1, totalPages: 1 };

      const buttons = [...pag.querySelectorAll('button')];
      const currentBtn = buttons.find(b => b.className.includes('current'));
      const currentPage = currentBtn ? parseInt(currentBtn.textContent) : 1;

      // Parse "1/57" text
      const pageText = pag.textContent;
      const match = pageText.match(/(\d+)\s*\/\s*(\d+)/);
      const totalPages = match ? parseInt(match[2]) : 1;

      return { currentPage, totalPages };
    }
  });

  return results[0]?.result || { currentPage: 1, totalPages: 1 };
}

// Click next page button on order list
async function goToNextPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pag = document.querySelector('.order-pagination');
      if (!pag) return false;

      // The "next" arrow button has class "next" (not "prev", not "current")
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

// Wait for page content to load after pagination click
async function waitForPageLoad(tabId, previousFirstOrder) {
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const orders = await extractOrdersFromPage(tabId);
    if (orders.length > 0) {
      // Check if it's different from the previous page
      if (!previousFirstOrder || orders[0].shopGroupKey !== previousFirstOrder) {
        return true;
      }
    }
  }
  return false;
}

// Print tab to PDF using debugger API and download it
async function printTabToPDF(tabId, filename) {
  await chrome.debugger.attach({ tabId }, '1.3');

  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: false,
      paperWidth: 8.27,   // A4
      paperHeight: 11.69,  // A4
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4
    });

    // Use data URL since service workers don't support URL.createObjectURL
    const dataUrl = 'data:application/pdf;base64,' + result.data;

    await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false
    });

    // Small delay to ensure download starts
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
    // Timeout after 30s
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  // "12 Feb 2026" format
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d;
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

// Main process
async function startProcess(listTabId, dateFrom, dateTo, delaySeconds) {
  state.running = true;
  state.stopped = false;
  state.downloaded = 0;
  state.listTabId = listTabId;

  try {
    const { totalPages } = await getPaginationInfo(listTabId);
    log(`Found ${totalPages} pages of orders.`);

    let pageNum = 1;
    let reachedEndOfRange = false;

    // Process page by page starting from current page
    while (pageNum <= totalPages && !state.stopped && !reachedEndOfRange) {
      log(`Processing page ${pageNum}/${totalPages}...`);
      progress(state.downloaded, 0, `Scanning page ${pageNum}/${totalPages}...`);

      // If not on page 1 and we need to navigate, do so
      if (pageNum > 1) {
        const prevFirst = (await extractOrdersFromPage(listTabId))[0]?.shopGroupKey;
        const navigated = await goToNextPage(listTabId);
        if (!navigated) {
          log('Could not navigate to next page.', 'error');
          break;
        }
        await waitForPageLoad(listTabId, prevFirst);
        await sleep(1000);
      }

      // Extract orders on this page
      const orders = await extractOrdersFromPage(listTabId);
      log(`Found ${orders.length} orders on page ${pageNum}.`);

      if (orders.length === 0) {
        log('No orders found on this page, stopping.');
        break;
      }

      // Process each order
      for (let i = 0; i < orders.length; i++) {
        if (state.stopped) break;

        const order = orders[i];
        progress(state.downloaded, 0, `Page ${pageNum}: checking order ${i + 1}/${orders.length} (${order.shopName})`);

        // Open order detail to get date and print
        let detailTabId = null;
        try {
          const baseUrl = 'https://my.lazada.co.th/customer/order/view/';
          const url = `${baseUrl}?shopGroupKey=${encodeURIComponent(order.shopGroupKey)}&tradeOrderId=${encodeURIComponent(order.tradeOrderId)}`;

          const tab = await chrome.tabs.create({ url, active: false });
          detailTabId = tab.id;

          await waitForTabLoad(detailTabId);
          await sleep(2500); // Wait for React to render

          // Get the placed date
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

          // Check if date is before our range (orders are newest first)
          // If so, we've passed the range and can stop
          if (orderDate && isDateBeforeRange(orderDate, dateFrom)) {
            log(`Order date ${orderDate} is before range start. Stopping.`, 'success');
            reachedEndOfRange = true;
            try { await chrome.tabs.remove(detailTabId); } catch (_) {}
            break;
          }

          // Check if date is in range
          if (!isDateInRange(orderDate, dateFrom, dateTo)) {
            log(`Order date ${orderDate} is outside range, skipping.`);
            try { await chrome.tabs.remove(detailTabId); } catch (_) {}
            await sleep(500);
            continue;
          }

          // Date is in range - print to PDF
          const dateForFile = orderDate ? orderDate.replace(/\s+/g, '-') : 'unknown-date';
          const shopClean = sanitizeFilename(order.shopName) || 'shop';
          const filename = `Lazada_Orders/${dateForFile}_${order.tradeOrderId}_${shopClean}.pdf`;

          progress(state.downloaded, 0, `Saving PDF: ${order.tradeOrderId} (${order.shopName})`);

          await printTabToPDF(detailTabId, filename);
          state.downloaded++;
          log(`Saved: ${filename}`, 'success');

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

      pageNum++;
    }

    state.running = false;
    chrome.runtime.sendMessage({
      type: state.stopped ? 'stopped' : 'done',
      downloaded: state.downloaded
    }).catch(() => {});

  } catch (err) {
    state.running = false;
    log(`Fatal error: ${err.message}`, 'error');
    chrome.runtime.sendMessage({ type: 'error', text: err.message }).catch(() => {});
  }
}

// Message handler
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'start') {
    startProcess(msg.tabId, msg.dateFrom, msg.dateTo, msg.delay);
    sendResponse({ ok: true });
  } else if (msg.action === 'stop') {
    state.stopped = true;
    sendResponse({ ok: true });
  } else if (msg.action === 'getState') {
    sendResponse({
      running: state.running,
      current: state.current,
      total: state.total,
      status: state.status
    });
  }
  return true;
});
