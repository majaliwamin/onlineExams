/* MNH Examination - admin portal: sign in, upload exams, review submissions */
const el = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));
const TOKEN_KEY = 'mnhDemoAdminToken';
const DEMO_KEY = 'demo-admin-change-me';
const setText = (id, text) => { const node = el(id); if (node) node.textContent = text; };

let token = sessionStorage.getItem(TOKEN_KEY) || '';
let exams = [];
let submissions = [];
let editingId = null;
let titleEdited = false;
let durationEdited = false;

// Values in an uploaded JSON file win unless the admin edits these fields.
el('examTitle').addEventListener('input', () => { titleEdited = true; });
el('examDuration').addEventListener('input', () => { durationEdited = true; });

async function request(path, options = {}) {
  const { retry, ...rest } = options;
  const headers = new Headers(rest.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...rest, headers });
  if (response.status === 401 && retry !== false) {
    token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    el('authPanel').hidden = false;
    el('workspace').hidden = true;
    setText('authStatus', 'Your session expired. Sign in again.');
  }
  return response;
}

async function jsonRequest(path, options = {}) {
  const response = await request(path, options);
  let data = null;
  try { data = await response.json(); } catch { /* no JSON body */ }
  if (!response.ok) throw new Error((data && data.detail) || `Request failed (${response.status})`);
  return data;
}

/* ------------------------------------------------------------------ sign in */
async function signIn(keyOverride = '', options = {}) {
  const { silent = false } = options;
  if (!silent) setText('authStatus', 'Signing in…');
  try {
    const key = (keyOverride || el('adminKey').value).trim();
    if (!key) throw new Error('Enter the admin key.');
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Sign in failed');
    token = data.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    el('authPanel').hidden = true;
    el('workspace').hidden = false;
    setText('authStatus', '');
    el('adminKey').value = '';
    await loadExams();
    await loadSubmissions();
    return true;
  } catch (error) {
    setText('authStatus', !silent || keyOverride ? error.message : 'Ready to sign in.');
    return false;
  }
}

el('signIn').onclick = () => signIn();
el('demoSignIn').onclick = () => signIn(DEMO_KEY);
el('adminKey').addEventListener('keydown', event => {
  if (event.key === 'Enter') signIn();
});

async function init() {
  if (!token) {
    el('authPanel').hidden = false;
    el('workspace').hidden = true;
    try {
      const response = await fetch('/api/admin/demo-access');
      const info = await response.json();
      if (info.enabled) {
        el('demoSignIn').hidden = false;
        // Development convenience: opening /admin signs straight in.
        await signIn(DEMO_KEY, { silent: true });
      }
    } catch { /* keep manual sign-in available */ }
    return;
  }
  try {
    await loadExams();
    await loadSubmissions();
    el('authPanel').hidden = true;
    el('workspace').hidden = false;
  } catch (error) {
    if (!token) { el('authPanel').hidden = false; el('workspace').hidden = true; }
    setText('authStatus', error.message);
  }
}
init();

/* -------------------------------------------------------------------- exams */
async function loadExams() {
  exams = await jsonRequest('/api/admin/exams');
  renderExams();
  updateExamFilter();
}

function renderExams() {
  const list = el('examList');
  if (!exams.length) { list.innerHTML = '<p class="muted">No examinations uploaded yet.</p>'; return; }
  list.innerHTML = exams.map(item => `
    <div class="card exam-row">
      <div><strong>${esc(item.title)}</strong> ${item.active ? '<span class="badge">Active</span>' : ''}</div>
      <p class="muted">${item.question_count} question${item.question_count === 1 ? '' : 's'} · ${item.total_marks} marks · ${item.duration_minutes} min · uploaded ${new Date(item.created_at * 1000).toLocaleString()}${item.has_attachment ? ` · <a href="/api/admin/exams/${encodeURIComponent(item.id)}/attachment" target="_blank" rel="noopener">${esc(item.attachment_name || 'document')}</a>` : ''}</p>
      <div class="toolbar">
        <button class="secondary" data-activate="${esc(item.id)}" ${item.active ? 'disabled' : ''}>Set active</button>
        <button class="secondary" data-edit="${esc(item.id)}">Edit</button>
        <button class="secondary" data-sheet="${esc(item.id)}">Editable sheet</button>
        <button class="secondary danger" data-delete="${esc(item.id)}">Delete</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-activate]').forEach(button => {
    button.onclick = async () => {
      try {
        await jsonRequest(`/api/admin/exams/${encodeURIComponent(button.dataset.activate)}/activate`, { method: 'POST' });
        await loadExams();
      } catch (error) { setText('uploadStatus', error.message); }
    };
  });
  list.querySelectorAll('[data-edit]').forEach(button => {
    button.onclick = () => startEdit(button.dataset.edit).catch(error => setText('uploadStatus', error.message));
  });
  list.querySelectorAll('[data-delete]').forEach(button => {
    button.onclick = async () => {
      if (!confirm('Delete this examination? Existing sessions and submissions are kept.')) return;
      try {
        await jsonRequest(`/api/admin/exams/${encodeURIComponent(button.dataset.delete)}`, { method: 'DELETE' });
        await loadExams();
        await loadSubmissions();
      } catch (error) { setText('uploadStatus', error.message); }
    };
  });
  list.querySelectorAll('[data-sheet]').forEach(button => {
    button.onclick = () => downloadAnswerSheet(button.dataset.sheet, itemTitle(button.dataset.sheet))
      .catch(error => setText('uploadStatus', error.message));
  });
}

function itemTitle(id) {
  const found = exams.find(item => item.id === id);
  return found ? found.title : 'examination';
}

async function downloadAnswerSheet(id, title) {
  const response = await request(`/api/admin/exams/${encodeURIComponent(id)}/answer-sheet.docx`);
  if (!response.ok) {
    let detail = `Download failed (${response.status})`;
    try { detail = (await response.json()).detail || detail; } catch { /* keep default */ }
    throw new Error(detail);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'examination'}-answer-sheet.docx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setText('uploadStatus', 'Editable answer sheet downloaded.');
}

async function startEdit(id) {
  const exam = await jsonRequest(`/api/admin/exams/${encodeURIComponent(id)}`);
  el('examTitle').value = exam.title;
  el('examDuration').value = exam.duration_minutes;
  el('examJson').value = JSON.stringify({
    title: exam.title,
    duration_minutes: exam.duration_minutes,
    questions: exam.questions
  }, null, 2);
  el('examFile').value = '';
  el('attachmentFile').value = '';
  el('activate').checked = Boolean(exam.active);
  editingId = id;
  titleEdited = false;
  durationEdited = false;
  el('uploadHeading').textContent = 'Replace examination';
  el('uploadButton').textContent = 'Save changes';
  el('cancelEdit').hidden = false;
  setText('uploadStatus', 'Loaded. Edit the JSON and save, or cancel to upload a new exam.');
  el('examTitle').scrollIntoView({ behavior: 'smooth' });
}

function resetUploadForm() {
  el('uploadForm').reset();
  el('examDuration').value = 30;
  el('activate').checked = true;
  editingId = null;
  titleEdited = false;
  durationEdited = false;
  el('uploadHeading').textContent = 'Upload an examination';
  el('uploadButton').textContent = 'Upload examination';
  el('cancelEdit').hidden = true;
}
el('cancelEdit').onclick = () => { resetUploadForm(); setText('uploadStatus', ''); };
el('refreshExams').onclick = () => loadExams().catch(error => setText('uploadStatus', error.message));

el('loadSample').onclick = async () => {
  try {
    const sample = await jsonRequest('/api/sample-exam');
    el('examJson').value = JSON.stringify(sample, null, 2);
    el('examTitle').value = sample.title || '';
    el('examDuration').value = sample.duration_minutes || 30;
    el('examFile').value = '';
    titleEdited = false;
    durationEdited = false;
    setText('uploadStatus', `Sample loaded: ${sample.title}. Click Upload examination to activate it.`);
  } catch (error) {
    setText('uploadStatus', `Could not load sample: ${error.message}`);
  }
};

el('examFile').onchange = () => {
  if (el('examFile').files[0]) el('examJson').value = '';
  setText('uploadStatus', '');
};

/* ------------------------------------------------------------------- upload */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function mimeFor(file) {
  if (file.type) return file.type;
  const extension = file.name.toLowerCase().split('.').pop();
  return { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[extension] || 'application/octet-stream';
}

el('uploadForm').onsubmit = async event => {
  event.preventDefault();
  const status = message => setText('uploadStatus', message);
  el('uploadButton').disabled = true;
  try {
    const definitionFile = el('examFile').files[0];
    const sampleJson = el('examJson').value.trim();
    if (definitionFile && !/\.json$/i.test(definitionFile.name) && definitionFile.type !== 'application/json') {
      throw new Error('Choose a .json exam definition file. A PDF/image goes in the "Optional question paper" field.');
    }
    const source = definitionFile ? await definitionFile.text() : sampleJson;
    if (!source) throw new Error('Provide an exam: click "Use sample exam" or choose a .json file.');

    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error('The exam definition is not valid JSON. Check commas, quotes and brackets.');
    }
    const base = Array.isArray(parsed) ? { questions: parsed } : (parsed.exam || parsed);
    const enteredTitle = el('examTitle').value.trim();
    const enteredDuration = Number(el('examDuration').value);
    const payload = {
      title: (titleEdited && enteredTitle) || base.title || base.name || enteredTitle,
      duration_minutes: (durationEdited && enteredDuration) || base.duration_minutes || base.duration || enteredDuration || 30,
      questions: base.questions || [],
      activate: el('activate').checked
    };

    const attachment = el('attachmentFile').files[0];
    if (attachment) {
      if (!['application/pdf', 'image/png', 'image/jpeg'].includes(mimeFor(attachment))) {
        throw new Error('The question paper must be a PDF, PNG or JPEG file.');
      }
      if (attachment.size > 10 * 1024 * 1024) throw new Error('The question paper must be at most 10 MB.');
      payload.attachment = {
        filename: attachment.name,
        content_type: mimeFor(attachment),
        data: await fileToBase64(attachment)
      };
    }

    status('Uploading…');
    const result = editingId
      ? await jsonRequest(`/api/admin/exams/${encodeURIComponent(editingId)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        })
      : await jsonRequest('/api/admin/exams', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
    status(`${result.title} ${editingId ? 'updated' : 'uploaded'}: ${result.question_count} question${result.question_count === 1 ? '' : 's'}, ${result.total_marks} marks.`);
    resetUploadForm();
    await loadExams();
    await loadSubmissions();
  } catch (error) {
    status(`Error: ${error.message}`);
  } finally {
    el('uploadButton').disabled = false;
  }
};

/* -------------------------------------------------------------- submissions */
el('loadSubmissions').onclick = () => loadSubmissions().catch(error => setText('authStatus', error.message));
el('downloadCsv').onclick = () => downloadResultsCsv().catch(error => setText('authStatus', error.message));

async function downloadResultsCsv() {
  const response = await request('/api/admin/submissions.csv');
  if (!response.ok) {
    let detail = `Download failed (${response.status})`;
    try { detail = (await response.json()).detail || detail; } catch { /* keep default */ }
    throw new Error(detail);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mnh-results.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setText('authStatus', 'Results CSV downloaded.');
}

async function loadSubmissions() {
  submissions = await jsonRequest('/api/admin/submissions');
  updateExamFilter();
  renderSubmissions();
}

function updateExamFilter() {
  const select = el('examFilter');
  const previous = select.value;
  const names = new Map();
  submissions.forEach(item => names.set(item.exam_id, item.exam_title));
  exams.forEach(item => names.set(item.id, item.title));
  select.innerHTML = '<option value="">All examinations</option>' + [...names].map(([id, title]) =>
    `<option value="${esc(id)}">${esc(title)}</option>`).join('');
  select.value = previous && names.has(previous) ? previous : '';
}
el('examFilter').onchange = renderSubmissions;

function answerLabel(key) {
  const sheetPage = /^__worksheet_p(\d+)$/.exec(String(key));
  return sheetPage ? `Editable worksheet · page ${sheetPage[1]}` : `Question ${key}`;
}

function renderAnswers(answers, grade = null) {
  const entries = Object.entries(answers || {});
  if (!entries.length) return '<p class="muted">No answers saved.</p>';
  const details = (grade && grade.details) || [];
  return entries.map(([key, value]) => {
    const label = answerLabel(key);
    const detail = details.find(item => String(item.question_id) === String(key));
    const mark = detail
      ? ` <span class="badge ${detail.is_correct ? 'ok' : ''}">${detail.is_correct ? 'Correct' : 'Incorrect'} · ${detail.awarded_marks}/${detail.max_marks} marks${detail.is_correct ? '' : ` · key: ${esc(detail.correct)}`}</span>`
      : '';
    let body;
    if (value && typeof value === 'object') {
      body = (value.text ? `<pre>${esc(value.text)}</pre>` : '') +
        (value.image ? `<img class="answer-image worksheet-image" src="${esc(value.image)}" alt="${esc(label)}">` : '');
      if (!body) body = '<pre>(empty)</pre>';
    } else if (typeof value === 'string' && value.startsWith('data:image/')) {
      body = `<img class="answer-image worksheet-image" src="${esc(value)}" alt="${esc(label)}">`;
    } else {
      body = `<pre>${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre>`;
    }
    return `<div class="answer-block"><strong>${esc(label)}</strong>${mark}${body}</div>`;
  }).join('');
}

function renderSubmissions() {
  const selected = el('examFilter').value;
  const rows = submissions.filter(item => !selected || item.exam_id === selected);
  const list = el('submissionList');
  if (!rows.length) { list.innerHTML = '<p class="muted">No submissions found.</p>'; return; }
  list.innerHTML = rows.map(item => {
    const grade = item.grade || {};
    const score = grade.total
      ? `<span class="badge">MCQ ${grade.correct}/${grade.total} · ${grade.marks}/${grade.max_marks} marks</span>`
      : '';
    return `
    <div class="card">
      <div><strong>${esc(item.student)}</strong> ${item.submitted_at ? '<span class="badge ok">Submitted</span>' : '<span class="badge">In progress</span>'} ${score}</div>
      <p class="muted">${esc(item.exam_title)} · Session ${esc(item.session_id)} · Started ${new Date(item.started_at * 1000).toLocaleString()}${item.submitted_at ? ` · Submitted ${new Date(item.submitted_at * 1000).toLocaleString()}` : ''}</p>
      <details ${item.submitted_at ? '' : 'open'}><summary>Answers</summary>${renderAnswers(item.answers, item.grade)}</details>
    </div>`;
  }).join('');
}
