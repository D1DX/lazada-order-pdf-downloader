const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const progressDiv = document.getElementById('progress');
const downloadedCount = document.getElementById('downloadedCount');
const pagesDone = document.getElementById('pagesDone');
const skippedCount = document.getElementById('skippedCount');
const statusText = document.getElementById('statusText');
const logDiv = document.getElementById('log');
const loginWarning = document.getElementById('loginWarning');

// --- Default dates to today ---
const today = new Date().toISOString().split('T')[0];
document.getElementById('dateFrom').value = today;
document.getElementById('dateTo').value = today;

// --- Quick date buttons ---
function buildQuickDates() {
  const container = document.getElementById('quickDates');
  const currentYear = new Date().getFullYear();

  const presets = [
    { label: 'Today', from: today, to: today },
    { label: 'This Month', from: `${currentYear}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`, to: today },
  ];

  // Current year + 4 previous years
  for (let y = currentYear; y >= currentYear - 4; y--) {
    presets.push({ label: String(y), from: `${y}-01-01`, to: `${y}-12-31` });
  }

  presets.push({ label: 'All Time', from: '', to: '' });

  for (const p of presets) {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('dateFrom').value = p.from;
      document.getElementById('dateTo').value = p.to;
    });
    container.appendChild(btn);
  }
}
buildQuickDates();

// --- Collapsible sections ---
function setupCollapsible(headerId, arrowId, contentId) {
  const header = document.getElementById(headerId);
  const arrow = document.getElementById(arrowId);
  const content = document.getElementById(contentId);

  header.addEventListener('click', () => {
    const isOpen = content.classList.contains('open');
    content.classList.toggle('open');
    arrow.classList.toggle('open');
  });
}
setupCollapsible('pdfOptionsHeader', 'pdfOptionsArrow', 'pdfOptionsContent');
setupCollapsible('statusFilterHeader', 'statusFilterArrow', 'statusFilterContent');

// --- Status filter chips ---
document.querySelectorAll('.status-chip').forEach(chip => {
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    if (chip.classList.contains('active')) {
      chip.classList.remove('active');
      chip.classList.add('excluded');
    } else {
      chip.classList.remove('excluded');
      chip.classList.add('active');
    }
  });
});

function getExcludedStatuses() {
  const excluded = [];
  document.querySelectorAll('.status-chip.excluded').forEach(chip => {
    excluded.push(chip.dataset.status);
  });
  return excluded;
}

// --- Logging ---
function addLog(msg, type = '') {
  logDiv.style.display = 'block';
  const entry = document.createElement('div');
  entry.className = 'entry' + (type ? ' ' + type : '');
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logDiv.appendChild(entry);
  logDiv.scrollTop = logDiv.scrollHeight;
}

function updateProgress(downloaded, pagesProcessed, skipped, status) {
  progressDiv.style.display = 'block';
  downloadedCount.textContent = downloaded;
  pagesDone.textContent = pagesProcessed;
  skippedCount.textContent = skipped;
  if (status) statusText.textContent = status;
}

// --- Listen for messages from background ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'log') {
    addLog(msg.text, msg.logType || '');
  } else if (msg.type === 'progress') {
    updateProgress(msg.downloaded, msg.pagesProcessed, msg.skipped, msg.status);
  } else if (msg.type === 'done') {
    addLog(`Finished! Downloaded ${msg.downloaded} PDFs. (${msg.skipped} skipped)`, 'success');
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    statusText.textContent = `Done! ${msg.downloaded} PDFs saved.`;
  } else if (msg.type === 'error') {
    addLog(`Error: ${msg.text}`, 'error');
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
  } else if (msg.type === 'stopped') {
    addLog(`Stopped by user. Downloaded ${msg.downloaded} PDFs.`, 'error');
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    statusText.textContent = `Stopped. ${msg.downloaded} PDFs saved.`;
  } else if (msg.type === 'needLogin') {
    loginWarning.style.display = 'block';
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
  }
});

// --- Start button ---
startBtn.addEventListener('click', async () => {
  loginWarning.style.display = 'none';

  const dateFrom = document.getElementById('dateFrom').value;
  const dateTo = document.getElementById('dateTo').value;
  const delay = parseInt(document.getElementById('delay').value) || 3;
  const cutAds = document.getElementById('cutAds').checked;
  const cutSideMenu = document.getElementById('cutSideMenu').checked;
  const cutHeader = document.getElementById('cutHeader').checked;
  const fitOnePage = document.getElementById('fitOnePage').checked;
  const excludedStatuses = getExcludedStatuses();

  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  startBtn.disabled = true;
  stopBtn.style.display = 'block';
  progressDiv.style.display = 'block';
  logDiv.style.display = 'block';

  addLog('Starting PDF download process...');

  chrome.runtime.sendMessage({
    action: 'start',
    tabId: tab.id,
    tabUrl: tab.url || '',
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    delay: delay,
    cutAds,
    cutSideMenu,
    cutHeader,
    fitOnePage,
    excludedStatuses
  });
});

// --- Stop button ---
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stop' });
  addLog('Stopping...', 'error');
});

// --- On popup open, check current state ---
chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
  if (response && response.running) {
    startBtn.disabled = true;
    stopBtn.style.display = 'block';
    progressDiv.style.display = 'block';
    logDiv.style.display = 'block';
    updateProgress(response.downloaded, response.pagesProcessed, response.skipped, response.status);
  }
});
