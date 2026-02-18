const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const progressDiv = document.getElementById('progress');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const statusText = document.getElementById('statusText');
const logDiv = document.getElementById('log');

function addLog(msg, type = '') {
  logDiv.style.display = 'block';
  const entry = document.createElement('div');
  entry.className = 'entry' + (type ? ' ' + type : '');
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logDiv.appendChild(entry);
  logDiv.scrollTop = logDiv.scrollHeight;
}

function updateProgress(current, total, status) {
  progressDiv.style.display = 'block';
  progressText.textContent = `${current} / ${total}`;
  progressBar.style.width = total > 0 ? `${(current / total) * 100}%` : '0%';
  if (status) statusText.textContent = status;
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'log') {
    addLog(msg.text, msg.logType || '');
  } else if (msg.type === 'progress') {
    updateProgress(msg.current, msg.total, msg.status);
  } else if (msg.type === 'done') {
    addLog(`Finished! Downloaded ${msg.downloaded} PDFs.`, 'success');
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    statusText.textContent = `Done! ${msg.downloaded} PDFs saved.`;
  } else if (msg.type === 'error') {
    addLog(`Error: ${msg.text}`, 'error');
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
  } else if (msg.type === 'stopped') {
    addLog('Stopped by user.', 'error');
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    statusText.textContent = 'Stopped.';
  }
});

startBtn.addEventListener('click', async () => {
  const dateFrom = document.getElementById('dateFrom').value;
  const dateTo = document.getElementById('dateTo').value;
  const delay = parseInt(document.getElementById('delay').value) || 3;

  // Get the active tab - must be on Lazada order list page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes('my.lazada.co.th/customer/order/index')) {
    addLog('Please navigate to Lazada My Orders page first!', 'error');
    return;
  }

  startBtn.disabled = true;
  stopBtn.style.display = 'block';
  progressDiv.style.display = 'block';
  logDiv.style.display = 'block';

  addLog('Starting PDF download process...');

  chrome.runtime.sendMessage({
    action: 'start',
    tabId: tab.id,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    delay: delay
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stop' });
  addLog('Stopping...', 'error');
});

// On popup open, check current state from background
chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
  if (response && response.running) {
    startBtn.disabled = true;
    stopBtn.style.display = 'block';
    progressDiv.style.display = 'block';
    logDiv.style.display = 'block';
    updateProgress(response.current, response.total, response.status);
  }
});
