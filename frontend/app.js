/* MNH Examination - student portal */
const root = document.querySelector('#app');
const state = {
  exam: null, session: null, answers: {}, idx: 0, mode: 'keyboard',
  flagged: {}, timer: null, saveTimer: null, saving: Promise.resolve(true), submitting: false
};

let audio = null;
let audioUrl = null;
let ttsLang = localStorage.getItem('mnhTtsLang') || 'en';
let ttsRate = Number(localStorage.getItem('mnhTtsRate') || 1);
let worksheet = null;

const WORKSHEET_KEY = /^__worksheet_p(\d+)$/;
const isWorksheetKey = key => WORKSHEET_KEY.test(String(key));
const WS_W = 794;
const WS_H = 1123;
const WS_MARGIN = 56;

const el = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));
const clockText = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

const savedStudentName = localStorage.getItem('mnhStudentName') || '';
const nameInput = el('studentName');
if (nameInput) {
  nameInput.value = savedStudentName;
  if (savedStudentName) {
    const userLabel = document.querySelector('header .user');
    if (userLabel) userLabel.textContent = savedStudentName;
  }
  nameInput.addEventListener('input', () => {
    const name = nameInput.value.trim();
    if (name) localStorage.setItem('mnhStudentName', name);
    const userLabel = document.querySelector('header .user');
    if (userLabel) userLabel.textContent = name || 'Demo Student';
  });
}

async function errorText(response) {
  try { const data = await response.json(); return data.detail || response.statusText; }
  catch { return response.statusText || 'Request failed'; }
}

/* ----------------------------------------------------------- read aloud */
function setTtsStatus(text) { const node = el('ttsStatus'); if (node) node.textContent = text; }

function stopSpeech() {
  if (audio) {
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio = null;
  }
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
  const button = el('listenBtn');
  if (button) { button.textContent = '🔊 Listen'; button.disabled = false; }
  setTtsStatus('');
}

function speechText(question) {
  const options = question.options
    ? ' Options: ' + question.options.map((option, i) => `${String.fromCharCode(65 + i)}: ${option}`).join('. ')
    : '';
  return question.text + options;
}

async function toggleListen() {
  if (audio) { stopSpeech(); return; }
  const requestedQuestion = currentQuestion();
  const button = el('listenBtn');
  button.disabled = true;
  setTtsStatus('Generating speech… long passages can take a moment');
  try {
    // POST avoids URL-length limits for passages of 2,000 words or more.
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: speechText(currentQuestion()), lang: ttsLang })
    });
    if (!response.ok) throw new Error(await errorText(response));
    if (!state.exam || currentQuestion() !== requestedQuestion) return;
    audioUrl = URL.createObjectURL(await response.blob());
    const player = new Audio(audioUrl);
    player.playbackRate = ttsRate;
    player.onended = () => stopSpeech();
    player.onerror = () => { stopSpeech(); setTtsStatus('Speech could not be played.'); };
    audio = player;
    await player.play();
    button.textContent = '⏹ Stop';
    button.disabled = false;
    setTtsStatus('Reading question aloud');
  } catch (error) {
    stopSpeech();
    setTtsStatus(`Speech unavailable: ${error.message || 'try again later'}`);
  }
}

function currentQuestion() { return state.exam.questions[state.idx]; }
function questionId() { return currentQuestion().id; }

function getAnswer(id) {
  const value = state.answers[id];
  if (value && typeof value === 'object') return { text: value.text || '', image: value.image || null };
  if (typeof value === 'string' && value.startsWith('data:image/')) return { text: '', image: value };
  return { text: typeof value === 'string' ? value : '', image: null };
}

function setAnswer(id, record) {
  if (record.text || record.image) state.answers[id] = record;
  else delete state.answers[id];
}

function hasAnswer(id) {
  const value = state.answers[id];
  return Boolean(value && (typeof value === 'object' ? (value.text || value.image) : value));
}

function answeredCount() {
  return Object.keys(state.answers).filter(key => !isWorksheetKey(key) && hasAnswer(key)).length;
}

/* ------------------------------------------------------------------ start */
async function startExam() {
  const button = el('start');
  button.disabled = true;
  button.textContent = 'Starting…';
  try {
    const enteredName = (nameInput && nameInput.value.trim()) || '';
    const student = enteredName || 'Demo Student';
    if (enteredName) localStorage.setItem('mnhStudentName', enteredName);
    const userLabel = document.querySelector('header .user');
    if (userLabel) userLabel.textContent = student;

    const examResponse = await fetch('/api/exam');
    if (!examResponse.ok) throw new Error(await errorText(examResponse));
    state.exam = await examResponse.json();

    const sessionResponse = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student })
    });
    if (!sessionResponse.ok) throw new Error(await errorText(sessionResponse));
    state.session = await sessionResponse.json();
    state.answers = {};
    state.flagged = {};
    state.idx = 0;
    state.mode = 'keyboard';
    render();
  } catch (error) {
    root.innerHTML = `<section class="welcome"><h1>Could not start examination</h1><p class="error">${esc(error.message)}</p><button id="retry">Try again</button></section>`;
    el('retry').onclick = () => location.reload();
  }
}
document.querySelector('#start').addEventListener('click', startExam);

/* ------------------------------------------------------------------ render */
function render() {
  clearInterval(state.timer);
  stopSpeech();
  if (worksheet) closeWorksheet();
  const question = currentQuestion();
  const isMcq = question.type === 'mcq';
  const mode = isMcq ? 'keyboard' : state.mode;
  const answer = getAnswer(question.id);
  const answered = answeredCount();
  const isFlagged = Boolean(state.flagged[question.id]);

  root.innerHTML = `
    <div class="layout">
      <aside class="nav">
        <h3>Question Navigator</h3>
        <div class="muted">Green: answered · Blue: current · Orange: flagged</div>
        <div class="grid">${state.exam.questions.map((q, i) => `
          <button class="${i === state.idx ? 'active ' : ''}${hasAnswer(q.id) ? 'done ' : ''}${state.flagged[q.id] ? 'flagged' : ''}"
                  data-goto="${i}" title="${esc(q.text)}">${i + 1}</button>`).join('')}
        </div>
        <p>${answered} answered of ${state.exam.questions.length}</p>
        ${state.exam.has_attachment ? '<p><a href="/api/exam/attachment" target="_blank" rel="noopener">Open examination document</a></p>' : ''}
        <div class="toolbar-vertical">
          <button class="secondary" id="downloadSheet">⬇ Editable sheet</button>
          <button class="secondary" id="openWorksheet">✍ Write on sheet</button>
        </div>
      </aside>
      <section class="panel question">
        <div class="muted">${esc(state.exam.title)} · Question ${state.idx + 1} of ${state.exam.questions.length} · ${question.marks} marks</div>
        <h2>${esc(question.text)}</h2>
        <div class="toolbar tts-controls">
          <button class="secondary" id="listenBtn" aria-label="Read question aloud">🔊 Listen</button>
          <label class="inline">Voice
            <select id="ttsLang">
              <option value="en" ${ttsLang === 'en' ? 'selected' : ''}>English</option>
              <option value="fr" ${ttsLang === 'fr' ? 'selected' : ''}>Français</option>
              <option value="sw" ${ttsLang === 'sw' ? 'selected' : ''}>Kiswahili</option>
              <option value="am" ${ttsLang === 'am' ? 'selected' : ''}>Amharic</option>
              <option value="ha" ${ttsLang === 'ha' ? 'selected' : ''}>Hausa</option>
              <option value="ar" ${ttsLang === 'ar' ? 'selected' : ''}>العربية</option>
            </select>
          </label>
          <label class="inline">Speed
            <select id="ttsRate">
              <option value="0.75" ${ttsRate === 0.75 ? 'selected' : ''}>0.75×</option>
              <option value="1" ${ttsRate === 1 ? 'selected' : ''}>1×</option>
              <option value="1.25" ${ttsRate === 1.25 ? 'selected' : ''}>1.25×</option>
            </select>
          </label>
        </div>
        <p class="status" id="ttsStatus"></p>
        ${isMcq ? `
          <div class="options">${question.options.map((option, i) => `
            <label class="option"><input type="radio" name="mcq" value="${esc(option)}" ${answer.text === option ? 'checked' : ''}>
              ${String.fromCharCode(65 + i)}. ${esc(option)}</label>`).join('')}
          </div>` : `
          <div class="toolbar">
            <button class="secondary" data-mode="keyboard">Keyboard</button>
            <button class="secondary" data-mode="handwriting">Handwriting</button>
          </div>
          <div id="writing">${mode === 'keyboard'
            ? `<textarea class="answer" id="txt" placeholder="Write your answer here...">${esc(answer.text)}</textarea>`
            : `<canvas class="canvas" id="pad"></canvas><button class="secondary" id="clearPad">Clear handwriting</button>`}
          </div>`}
        <div class="toolbar">
          <button class="secondary" id="flagBtn">${isFlagged ? 'Unflag question' : 'Flag question'}</button>
          <button class="secondary" data-goto="${Math.max(0, state.idx - 1)}">Previous</button>
          <button data-goto="${Math.min(state.exam.questions.length - 1, state.idx + 1)}">Next</button>
          <button data-review>Review &amp; submit</button>
        </div>
        <p class="status" id="saveStatus">Autosave enabled</p>
      </section>
      <aside>
        <div class="timer" id="clock">30:00</div>
        <p class="muted">Remaining. The server closes the exam when time expires.</p>
        <button data-review>Submit</button>
      </aside>
    </div>`;

  root.querySelectorAll('[data-goto]').forEach(button => {
    button.onclick = () => goto(Number(button.dataset.goto));
  });
  root.querySelectorAll('[data-mode]').forEach(button => {
    button.onclick = () => switchMode(button.dataset.mode);
  });
  root.querySelectorAll('[data-review]').forEach(button => { button.onclick = review; });
  el('flagBtn').onclick = toggleFlag;
  el('listenBtn').onclick = toggleListen;
  el('downloadSheet').onclick = () => downloadAnswerSheet().catch(error => setSaveStatus(`Download failed: ${error.message}`));
  el('openWorksheet').onclick = openWorksheet;
  el('ttsLang').onchange = event => {
    ttsLang = event.target.value;
    localStorage.setItem('mnhTtsLang', ttsLang);
    stopSpeech();
  };
  el('ttsRate').onchange = event => {
    ttsRate = Number(event.target.value);
    localStorage.setItem('mnhTtsRate', String(ttsRate));
    if (audio) audio.playbackRate = ttsRate;
  };
  if (isMcq) {
    root.querySelectorAll('input[name="mcq"]').forEach(input => {
      input.onchange = () => {
        const record = getAnswer(question.id);
        record.text = input.value;
        setAnswer(question.id, record);
        scheduleSave();
        renderNavigatorState();
      };
    });
  } else if (mode === 'keyboard') {
    el('txt').oninput = event => {
      const record = getAnswer(question.id);
      record.text = event.target.value;
      setAnswer(question.id, record);
      scheduleSave();
      renderNavigatorState();
    };
  } else {
    setupPad();
  }
  startTimer();
}

/* Only refresh the navigator counters, so typing does not re-render the editor. */
function renderNavigatorState() {
  const counter = root.querySelector('.nav p');
  if (counter) counter.textContent = `${answeredCount()} answered of ${state.exam.questions.length}`;
  root.querySelectorAll('.grid button').forEach(button => {
    const q = state.exam.questions[Number(button.dataset.goto)];
    button.classList.toggle('done', hasAnswer(q.id));
  });
}

function goto(index) { collect(); state.idx = index; render(); }
function switchMode(mode) { collect(); state.mode = mode; render(); }

function toggleFlag() {
  const id = questionId();
  state.flagged[id] = !state.flagged[id];
  el('flagBtn').textContent = state.flagged[id] ? 'Unflag question' : 'Flag question';
  const navButton = root.querySelector(`.grid button[data-goto="${state.idx}"]`);
  if (navButton) navButton.classList.toggle('flagged', Boolean(state.flagged[id]));
}

function collect() {
  if (!state.exam || !state.session) return;
  const id = questionId();
  const textarea = el('txt');
  if (textarea) {
    const record = getAnswer(id);
    record.text = textarea.value;
    setAnswer(id, record);
  }
}

/* --------------------------------------------------------------- handwriting */
function setupPad() {
  const canvas = el('pad');
  const ctx = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const logicalWidth = () => canvas.width / ratio;
  const logicalHeight = () => canvas.height / ratio;

  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#12233f';

  const savedImage = getAnswer(questionId()).image;
  if (savedImage) {
    const image = new Image();
    image.onload = () => ctx.drawImage(image, 0, 0, logicalWidth(), logicalHeight());
    image.src = savedImage;
  }

  const point = event => {
    const bounds = canvas.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  };
  let drawing = false;
  canvas.onpointerdown = event => {
    event.preventDefault();
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    const [x, y] = point(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  canvas.onpointermove = event => {
    if (!drawing) return;
    event.preventDefault();
    const [x, y] = point(event);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const finish = () => {
    if (!drawing) return;
    drawing = false;
    const record = getAnswer(questionId());
    record.image = canvas.toDataURL('image/png');
    setAnswer(questionId(), record);
    scheduleSave();
    renderNavigatorState();
  };
  canvas.onpointerup = finish;
  canvas.onpointercancel = finish;
  el('clearPad').onclick = () => {
    ctx.clearRect(0, 0, logicalWidth(), logicalHeight());
    const record = getAnswer(questionId());
    record.image = null;
    setAnswer(questionId(), record);
    scheduleSave();
    renderNavigatorState();
  };
}

/* ------------------------------------------------------ editable worksheet */
function safeFilePart(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'examination';
}

async function downloadAnswerSheet() {
  const response = await fetch('/api/exam/answer-sheet.docx');
  if (!response.ok) throw new Error(await errorText(response));
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFilePart(state.exam.title)}-answer-sheet.docx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setSaveStatus('Editable answer sheet downloaded');
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  String(text || '').split(/\r?\n/).forEach(paragraph => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); return; }
    let line = '';
    words.forEach(word => {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(candidate).width <= maxWidth) line = candidate;
      else { lines.push(line); line = word; }
    });
    if (line) lines.push(line);
  });
  return lines;
}

function worksheetPageBackgrounds() {
  const pages = [];
  let canvas;
  let ctx;
  let y;

  const newPage = () => {
    canvas = document.createElement('canvas');
    canvas.width = WS_W;
    canvas.height = WS_H;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WS_W, WS_H);
    ctx.fillStyle = '#12233f';
    ctx.font = 'bold 22px Arial, sans-serif';
    ctx.fillText(state.exam.title || 'Examination', WS_MARGIN, WS_MARGIN);
    ctx.fillStyle = '#52627a';
    ctx.font = '14px Arial, sans-serif';
    ctx.fillText(
      `Duration: ${state.exam.duration_minutes} minutes    Total marks: ${state.exam.total_marks}`,
      WS_MARGIN, WS_MARGIN + 26
    );
    ctx.fillText('Name: ______________________________    Date: ______________', WS_MARGIN, WS_MARGIN + 50);
    y = WS_MARGIN + 84;
    pages.push(canvas);
  };

  const ensure = needed => { if (y + needed > WS_H - WS_MARGIN) newPage(); };

  newPage();
  state.exam.questions.forEach((question, index) => {
    ensure(30);
    ctx.fillStyle = '#12233f';
    ctx.font = 'bold 16px Arial, sans-serif';
    ctx.fillText(`Question ${index + 1} (${question.marks} marks)`, WS_MARGIN, y);
    y += 22;

    ctx.font = '15px Arial, sans-serif';
    wrapText(ctx, question.text, WS_W - WS_MARGIN * 2).forEach(line => {
      ensure(20);
      ctx.fillText(line, WS_MARGIN, y);
      y += 19;
    });

    if (question.type === 'mcq') {
      (question.options || []).forEach((option, optionIndex) => {
        ensure(20);
        ctx.fillText(`${String.fromCharCode(65 + optionIndex)}. ${option}`, WS_MARGIN + 12, y);
        y += 19;
      });
    }

    const ruleCount = question.type === 'mcq' ? 3 : 5;
    for (let line = 0; line < ruleCount; line += 1) {
      ensure(26);
      ctx.strokeStyle = '#c8d2e0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(WS_MARGIN, y + 8);
      ctx.lineTo(WS_W - WS_MARGIN, y + 8);
      ctx.stroke();
      y += 24;
    }
    ensure(32);
    y += 16;
  });
  return pages;
}

function worksheetKey(index) { return `__worksheet_p${index + 1}`; }

function makeLayerCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = WS_W;
  canvas.height = WS_H;
  return canvas;
}

function compositeWorksheetLayer(index) {
  const layer = worksheet.layers[index];
  const output = makeLayerCanvas();
  const ctx = output.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WS_W, WS_H);
  ctx.drawImage(layer.bg, 0, 0);
  ctx.drawImage(layer.saved, 0, 0);
  ctx.drawImage(layer.ink, 0, 0);
  return output;
}

function drawInkLayer(index) {
  const layer = worksheet.layers[index];
  const ctx = layer.ink.getContext('2d');
  ctx.clearRect(0, 0, WS_W, WS_H);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  layer.strokes.forEach(stroke => {
    if (!stroke.points.length) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.beginPath();
    ctx.moveTo(...stroke.points[0]);
    if (stroke.points.length === 1) ctx.lineTo(stroke.points[0][0] + 0.01, stroke.points[0][1]);
    else stroke.points.slice(1).forEach(point => ctx.lineTo(...point));
    ctx.stroke();
  });
}

function updateWorksheetPage(index) {
  if (!worksheet) return;
  const record = getAnswer(worksheetKey(index));
  record.image = compositeWorksheetLayer(index).toDataURL('image/jpeg', 0.82);
  setAnswer(worksheetKey(index), record);
  scheduleSave();
  renderNavigatorState();
}

function attachInkHandlers(canvas, index) {
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return [
      (event.clientX - rect.left) * canvas.width / rect.width,
      (event.clientY - rect.top) * canvas.height / rect.height
    ];
  };
  let active = null;
  canvas.addEventListener('pointerdown', event => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    active = { color: worksheet.color, size: worksheet.size, points: [point(event)] };
    worksheet.layers[index].strokes.push(active);
    drawInkLayer(index);
  });
  canvas.addEventListener('pointermove', event => {
    if (!active) return;
    event.preventDefault();
    active.points.push(point(event));
    drawInkLayer(index);
  });
  const finish = () => {
    if (!active) return;
    active = null;
    updateWorksheetPage(index);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
}

function renderWorksheetPage() {
  if (!worksheet) return;
  const stage = worksheet.modal.querySelector('.sheet-stage');
  const layer = worksheet.layers[worksheet.index];
  stage.replaceChildren(layer.bg, layer.saved, layer.ink);
  worksheet.modal.querySelector('#sheetPageLabel').textContent =
    `Page ${worksheet.index + 1} of ${worksheet.layers.length}`;
  worksheet.modal.querySelector('#sheetPrev').disabled = worksheet.index === 0;
  worksheet.modal.querySelector('#sheetNext').disabled = worksheet.index === worksheet.layers.length - 1;
}

function undoWorksheet() {
  if (!worksheet) return;
  const strokes = worksheet.layers[worksheet.index].strokes;
  if (!strokes.length) return;
  strokes.pop();
  drawInkLayer(worksheet.index);
  updateWorksheetPage(worksheet.index);
}

function clearWorksheetPage(index) {
  const layer = worksheet.layers[index];
  layer.strokes = [];
  layer.ink.getContext('2d').clearRect(0, 0, WS_W, WS_H);
  layer.saved.getContext('2d').clearRect(0, 0, WS_W, WS_H);
  delete state.answers[worksheetKey(index)];
  scheduleSave();
  renderNavigatorState();
}

function saveAllWorksheetPages() {
  worksheet.layers.forEach((_, index) => updateWorksheetPage(index));
}

function downloadWorksheetPage(index) {
  const url = compositeWorksheetLayer(index).toDataURL('image/jpeg', 0.9);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFilePart(state.exam.title)}-page-${index + 1}.jpg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function closeWorksheet() {
  if (!worksheet) return;
  worksheet.modal.remove();
  worksheet = null;
}

function openWorksheet() {
  if (!state.exam || worksheet) return;
  collect();
  const backgrounds = worksheetPageBackgrounds();
  const layers = backgrounds.map((bg, index) => {
    const saved = makeLayerCanvas();
    const previous = getAnswer(worksheetKey(index)).image;
    if (previous) {
      const image = new Image();
      image.onload = () => saved.getContext('2d').drawImage(image, 0, 0, WS_W, WS_H);
      image.src = previous;
    }
    const ink = makeLayerCanvas();
    ink.className = 'sheet-ink';
    return { bg, saved, ink, strokes: [] };
  });

  const modal = document.createElement('div');
  modal.className = 'sheet-backdrop';
  modal.innerHTML = `
    <div class="sheet-dialog">
      <div class="sheet-top">
        <strong>Write on your answer sheet</strong>
        <span id="sheetPageLabel" class="muted"></span>
        <button type="button" class="secondary" id="sheetPrev">Previous</button>
        <button type="button" class="secondary" id="sheetNext">Next</button>
        <label class="inline">Pen <input id="sheetColor" type="color" value="#12233f"></label>
        <label class="inline">Size <input id="sheetSize" type="range" min="1" max="8" value="2"></label>
        <button type="button" class="secondary" id="sheetUndo">Undo</button>
        <button type="button" class="secondary" id="sheetClear">Clear page</button>
        <button type="button" id="sheetSave">Save answers</button>
        <button type="button" class="secondary" id="sheetDownload">Download page</button>
        <button type="button" class="secondary" id="sheetClose">Close</button>
      </div>
      <div class="sheet-stage"></div>
      <p class="muted">Write anywhere on the sheet with a mouse, touch screen or stylus. Each page is saved with your answers.</p>
    </div>`;
  document.body.appendChild(modal);
  worksheet = { modal, layers, index: 0, color: '#12233f', size: 2 };
  layers.forEach((layer, index) => attachInkHandlers(layer.ink, index));

  modal.querySelector('#sheetPrev').onclick = () => { worksheet.index -= 1; renderWorksheetPage(); };
  modal.querySelector('#sheetNext').onclick = () => { worksheet.index += 1; renderWorksheetPage(); };
  modal.querySelector('#sheetColor').oninput = event => { worksheet.color = event.target.value; };
  modal.querySelector('#sheetSize').oninput = event => { worksheet.size = Number(event.target.value); };
  modal.querySelector('#sheetUndo').onclick = undoWorksheet;
  modal.querySelector('#sheetClear').onclick = () => {
    if (confirm('Clear all writing on this page?')) clearWorksheetPage(worksheet.index);
  };
  modal.querySelector('#sheetSave').onclick = () => {
    saveAllWorksheetPages();
    setSaveStatus('Written sheet saved');
  };
  modal.querySelector('#sheetDownload').onclick = () => downloadWorksheetPage(worksheet.index);
  modal.querySelector('#sheetClose').onclick = closeWorksheet;
  renderWorksheetPage();
}

/* -------------------------------------------------------------- save / timer */
function setSaveStatus(text) { const node = el('saveStatus'); if (node) node.textContent = text; }
function scheduleSave() {
  setSaveStatus('Saving…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveNow(), 500);
}

function saveNow() {
  clearTimeout(state.saveTimer);
  collect();
  state.saving = state.saving.then(async () => {
    if (!state.session || state.session.submitted) return true;
    try {
      const response = await fetch(`/api/session/${state.session.session_id}/answers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: state.answers })
      });
      if (!response.ok) {
        setSaveStatus(`Save failed: ${await errorText(response)}`);
        return false;
      }
      setSaveStatus('Saved to server');
      return true;
    } catch {
      setSaveStatus('Save failed - check your connection');
      return false;
    }
  }).catch(() => false);
  return state.saving;
}

function startTimer() {
  clearInterval(state.timer);
  const tick = () => {
    const remaining = Math.max(0, Math.ceil(state.session.expires_at - Date.now() / 1000));
    const node = el('clock');
    if (node) node.textContent = clockText(remaining);
    if (remaining === 0) {
      clearInterval(state.timer);
      submitExam(true);
    }
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

/* ------------------------------------------------------------------ submit */
function review() {
  if (state.submitting) return;
  stopSpeech();
  collect();
  const summary = state.exam.questions.map((q, i) => {
    const status = state.flagged[q.id] ? 'Flagged' : hasAnswer(q.id) ? 'Answered' : 'Unanswered';
    return `<li><button class="link-button" data-goto="${i}">Question ${i + 1}</button> - ${status}</li>`;
  }).join('');
  root.innerHTML = `<section class="welcome"><h1>Review your examination</h1>
    <ul class="review-list">${summary}</ul>
    <div class="toolbar"><button id="backToExam">Back to examination</button><button id="confirmSubmit">Submit examination</button></div>
    <p class="muted">Submission is final in this demo. Answers are saved as you work.</p></section>`;
  root.querySelectorAll('[data-goto]').forEach(button => {
    button.onclick = () => { state.idx = Number(button.dataset.goto); render(); };
  });
  el('backToExam').onclick = render;
  el('confirmSubmit').onclick = () => {
    if (confirm('Submit your examination now? This cannot be undone.')) submitExam(false);
  };
}

async function submitExam(auto) {
  if (state.submitting) return;
  stopSpeech();
  state.submitting = true;
  clearInterval(state.timer);
  await saveNow();
  try {
    const response = await fetch(`/api/session/${state.session.session_id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: state.answers })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Submission failed');
    root.innerHTML = `<section class="welcome"><h1>Examination submitted</h1>
      <p>Your demo submission receipt: <strong>${esc(data.receipt)}</strong></p>
      <p>${auto ? 'Time expired, so your saved answers were submitted automatically.' : 'Submitted successfully to the demonstration backend.'}</p>
      <p class="muted">${esc(data.exam_title || state.exam.title)}</p></section>`;
  } catch (error) {
    root.innerHTML = `<section class="welcome"><h1>Submission failed</h1><p class="error">${esc(error.message)}</p>
      <button id="retrySubmit">Try again</button></section>`;
    el('retrySubmit').onclick = () => { state.submitting = false; startTimer(); };
  }
}
