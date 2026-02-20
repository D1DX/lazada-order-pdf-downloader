const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const progressDiv = document.getElementById('progress');
const downloadedCount = document.getElementById('downloadedCount');
const pagesDone = document.getElementById('pagesDone');
const skippedCount = document.getElementById('skippedCount');
const statusText = document.getElementById('statusText');
const logDiv = document.getElementById('log');
const loginWarning = document.getElementById('loginWarning');

// --- Default dates: This Month ---
const now = new Date();
const currentYear = now.getFullYear();
const today = now.toISOString().split('T')[0];
const monthStart = `${currentYear}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

document.getElementById('dateFrom').value = monthStart;
document.getElementById('dateTo').value = today;

// --- Quick date buttons with multi-select for years ---
let activePresetBtn = null; // For non-year presets (mutually exclusive)
const activeYearBtns = new Set(); // For year buttons (multi-select)

function buildQuickDates() {
  const container = document.getElementById('quickDates');

  const presets = [
    { label: 'Today', from: today, to: today, cls: '', type: 'preset' },
    { label: 'This Week', from: getWeekStart(), to: today, cls: '', type: 'preset' },
    { label: 'This Month', from: monthStart, to: today, cls: '', type: 'preset' },
    { label: 'Last 3 Mo', from: getMonthsAgo(3), to: today, cls: '', type: 'preset' },
    { label: 'Last 6 Mo', from: getMonthsAgo(6), to: today, cls: '', type: 'preset' },
  ];

  // Separator
  const sepData = { type: 'separator' };

  // Year buttons
  const years = [];
  for (let y = currentYear; y >= currentYear - 4; y--) {
    years.push({ label: String(y), year: y, cls: 'year-btn', type: 'year' });
  }

  const allTime = { label: 'All Time', from: '', to: '', cls: 'special-btn', type: 'preset' };

  // Build preset buttons
  for (const p of presets) {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    if (p.cls) btn.classList.add(p.cls);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // Clear any active year selections
      clearYearSelections();
      // Set date range
      document.getElementById('dateFrom').value = p.from;
      document.getElementById('dateTo').value = p.to;
      // Highlight - deselect old, select new
      if (activePresetBtn) activePresetBtn.classList.remove('active');
      btn.classList.add('active');
      activePresetBtn = btn;
    });

    // Mark "This Month" as active by default
    if (p.label === 'This Month') {
      btn.classList.add('active');
      activePresetBtn = btn;
    }

    container.appendChild(btn);
  }

  // Add separator
  const sep = document.createElement('div');
  sep.className = 'date-sep';
  container.appendChild(sep);

  // Build year buttons (multi-select)
  for (const y of years) {
    const btn = document.createElement('button');
    btn.textContent = y.label;
    btn.classList.add('year-btn');
    btn.dataset.year = y.year;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // Clear any active preset selection
      if (activePresetBtn) {
        activePresetBtn.classList.remove('active');
        activePresetBtn = null;
      }

      // Toggle this year
      if (btn.classList.contains('active')) {
        btn.classList.remove('active');
        activeYearBtns.delete(btn);
      } else {
        btn.classList.add('active');
        activeYearBtns.add(btn);
      }

      // Recalculate date range from selected years
      applyYearSelection();
    });

    container.appendChild(btn);
  }

  // All Time button
  const allBtn = document.createElement('button');
  allBtn.textContent = allTime.label;
  allBtn.classList.add('special-btn');
  allBtn.addEventListener('click', (e) => {
    e.preventDefault();
    clearYearSelections();
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
    if (activePresetBtn) activePresetBtn.classList.remove('active');
    allBtn.classList.add('active');
    activePresetBtn = allBtn;
  });
  container.appendChild(allBtn);
}

function clearYearSelections() {
  for (const btn of activeYearBtns) {
    btn.classList.remove('active');
  }
  activeYearBtns.clear();
}

function applyYearSelection() {
  if (activeYearBtns.size === 0) {
    // Nothing selected - clear dates
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
    return;
  }

  // Get min and max year from selections
  const selectedYears = [];
  for (const btn of activeYearBtns) {
    selectedYears.push(parseInt(btn.dataset.year));
  }
  selectedYears.sort((a, b) => a - b);

  const minYear = selectedYears[0];
  const maxYear = selectedYears[selectedYears.length - 1];

  document.getElementById('dateFrom').value = `${minYear}-01-01`;
  document.getElementById('dateTo').value = `${maxYear}-12-31`;
}

function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split('T')[0];
}

function getMonthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().split('T')[0];
}

buildQuickDates();

// Clear active preset when manual date change
document.getElementById('dateFrom').addEventListener('change', () => {
  if (activePresetBtn) { activePresetBtn.classList.remove('active'); activePresetBtn = null; }
  clearYearSelections();
});
document.getElementById('dateTo').addEventListener('change', () => {
  if (activePresetBtn) { activePresetBtn.classList.remove('active'); activePresetBtn = null; }
  clearYearSelections();
});

// --- Collapsible sections ---
function setupCollapsible(headerId, arrowId, contentId) {
  const header = document.getElementById(headerId);
  const arrow = document.getElementById(arrowId);
  const content = document.getElementById(contentId);

  header.addEventListener('click', () => {
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

// --- Open folder link ---
document.getElementById('openFolderLink').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'openFolder' });
});

// --- Logging with fun emojis ---
function addLog(msg, type = '') {
  logDiv.style.display = 'block';

  // Check for divider lines (--- text ---)
  if (msg.startsWith('---') && msg.endsWith('---')) {
    const entry = document.createElement('div');
    entry.className = 'entry divider-msg';
    entry.textContent = msg;
    logDiv.appendChild(entry);
    logDiv.scrollTop = logDiv.scrollHeight;
    return;
  }

  const entry = document.createElement('div');
  entry.className = 'entry' + (type ? ' ' + type : '');

  const ts = document.createElement('span');
  ts.className = 'ts';
  const now = new Date();
  ts.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')} `;

  // Add contextual emoji based on message content
  let emoji = '';
  const msgLower = msg.toLowerCase();
  if (type === 'success') {
    if (msgLower.includes('saved') || msgLower.includes('pdf')) emoji = '\u{1F4BE}';
    else if (msgLower.includes('finish') || msgLower.includes('done') || msgLower.includes('complete')) emoji = '\u{1F389}';
    else if (msgLower.includes('navigat') || msgLower.includes('page')) emoji = '\u2705';
    else if (msgLower.includes('found') || msgLower.includes('start')) emoji = '\u{1F680}';
    else emoji = '\u2728';
  } else if (type === 'error') {
    if (msgLower.includes('stop')) emoji = '\u{1F6D1}';
    else if (msgLower.includes('skip')) emoji = '\u23ED\uFE0F';
    else if (msgLower.includes('fail') || msgLower.includes('cannot')) emoji = '\u274C';
    else if (msgLower.includes('login')) emoji = '\u{1F512}';
    else emoji = '\u26A0\uFE0F';
  } else {
    if (msgLower.includes('scanning') || msgLower.includes('processing')) emoji = '\u{1F50D}';
    else if (msgLower.includes('checking')) emoji = '\u{1F4CB}';
    else if (msgLower.includes('page jump') || msgLower.includes('navigat')) emoji = '\u{1F4CD}';
    else if (msgLower.includes('smart') || msgLower.includes('binary search')) emoji = '\u{1F9E0}';
    else if (msgLower.includes('filter') || msgLower.includes('config')) emoji = '\u2699\uFE0F';
    else if (msgLower.includes('date')) emoji = '\u{1F4C5}';
    else if (msgLower.includes('delay')) emoji = '\u23F1\uFE0F';
    else if (msgLower.includes('duplicate')) emoji = '\u{1F504}';
    else if (msgLower.includes('order')) emoji = '\u{1F4E6}';
    else if (msgLower.includes('total') || msgLower.includes('summary')) emoji = '\u{1F4CA}';
    else if (msgLower.includes('found')) emoji = '\u{1F50E}';
    else if (msgLower.includes('status')) emoji = '\u{1F3F7}\uFE0F';
    else if (msgLower.includes('excluded')) emoji = '\u{1F6AB}';
    else emoji = '\u25B8';
  }

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = emoji + ' ';

  entry.appendChild(ts);
  entry.appendChild(icon);
  entry.appendChild(document.createTextNode(msg));
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
    addLog(`All done! Saved ${msg.downloaded} PDFs, skipped ${msg.skipped}. Great success!`, 'success');
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    statusText.textContent = `\u2705 Done! ${msg.downloaded} PDFs saved.`;
  } else if (msg.type === 'error') {
    addLog(`Error: ${msg.text}`, 'error');
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
  } else if (msg.type === 'stopped') {
    addLog(`Stopped! Saved ${msg.downloaded} PDFs before stopping.`, 'error');
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    statusText.textContent = `\u{1F6D1} Stopped. ${msg.downloaded} PDFs saved.`;
  } else if (msg.type === 'needLogin') {
    loginWarning.style.display = 'flex';
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
  }
});

// --- Start button ---
startBtn.addEventListener('click', async () => {
  loginWarning.style.display = 'none';

  let dateFrom = document.getElementById('dateFrom').value;
  let dateTo = document.getElementById('dateTo').value;
  const delayMs = parseInt(document.getElementById('delay').value) || 500;
  const cutAds = document.getElementById('cutAds').checked;
  const cutSideMenu = document.getElementById('cutSideMenu').checked;
  const cutHeader = document.getElementById('cutHeader').checked;
  const cutFooter = document.getElementById('cutFooter').checked;
  const fitOnePage = document.getElementById('fitOnePage').checked;
  const excludedStatuses = getExcludedStatuses();

  // Validate date range
  if (dateFrom && dateTo && dateFrom > dateTo) {
    addLog(`Date range is invalid: "${dateFrom}" is after "${dateTo}". Swapping them.`, 'error');
    [dateFrom, dateTo] = [dateTo, dateFrom];
    document.getElementById('dateFrom').value = dateFrom;
    document.getElementById('dateTo').value = dateTo;
  }

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
    delayMs: delayMs,
    cutAds,
    cutSideMenu,
    cutHeader,
    cutFooter,
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
