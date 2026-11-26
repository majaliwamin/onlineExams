# MNH Examination full-stack demo

A small FastAPI + vanilla JavaScript demonstration of an examination portal: students take a timed exam with autosaved answers (including handwriting), and administrators upload/manage exams and review submissions.

## Windows quick start
1. Extract the ZIP.
2. Double-click **START-DEMO.bat**.
3. It installs dependencies (first run), starts the server and opens the browser at http://127.0.0.1:8088.

Or run manually from PowerShell in this folder:
```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
uvicorn backend.main:app --reload --port 8088
```

- Student portal: http://127.0.0.1:8088
- Admin: http://127.0.0.1:8088/admin — opens straight in with the demo key `demo-admin-change-me`
- Change the demo key with the `MNH_ADMIN_KEY` environment variable before starting the server.

## Uploading an examination (admin)
1. Open `/admin` — it signs in automatically while the default demo key is active.
2. In **Upload an examination**:
   - Click **Use sample exam** to load a ready exam instantly, or choose your own `.json` file. There is no JSON text box to fill in.
   - Optionally attach a `.pdf`, `.png` or `.jpg` question paper (max 10 MB). Students can open it from the exam screen.
   - Leave **Make this the active examination** checked so students receive it.
3. Click **Upload examination**. The list below shows uploaded exams; use **Set active**, **Edit**, **Editable sheet** or **Delete** to manage them.

A ready-to-upload example is also in [`examples/sample-exam.json`](examples/sample-exam.json).

### Exam JSON format
```json
{
  "title": "Antenatal Care Assessment",
  "duration_minutes": 45,
  "questions": [
    {
      "type": "mcq",
      "text": "How often is antenatal care recommended?",
      "marks": 5,
      "options": ["Once", "At least four visits", "Only if unwell", "Never"],
      "answer": 1
    },
    {
      "type": "text",
      "text": "Describe two danger signs in pregnancy.",
      "marks": 10
    }
  ]
}
```

- `type` must be `mcq` (requires 2–8 unique `options`) or `text`.
- `marks` must be a positive integer. Question ids are assigned in order by the server.
- For MCQs, `answer` is optional and may be a 0-based index (`1` = option B), a letter (`"B"`) or the exact option text. It is stored privately, never sent to students, and used for automatic marking.
- Limits: 1–200 questions, 1–480 minutes, title up to 160 characters, question text up to 20,000 characters (~3,000 words).
- The server validates everything; invalid uploads return a clear error message.
- A built-in practice exam is seeded on first run so the student portal always works.

## API overview
| Endpoint | Purpose |
| --- | --- |
| `GET /api/sample-exam` | Bundled example exam for the one-click admin button (admin token required) |
| `GET /api/exam` | Active exam (what the student receives) |
| `GET /api/exam/answer-sheet.docx` | Editable Word worksheet for the active exam |
| `GET /api/exam/attachment` | Attached question paper, if any |
| `POST /api/session/start` | Start a timed session for the active exam |
| `GET /api/session/{id}` | Session state |
| `PUT /api/session/{id}/answers` | Autosave answers (rejected after the deadline) |
| `POST /api/session/{id}/submit` | Submit; late submissions keep the last autosaved answers |
| `GET /api/admin/demo-access` | Reports whether one-tap demo sign-in is available |
| `POST /api/admin/login` | Exchange the admin key for an 8-hour bearer token |
| `GET/POST/PUT/DELETE /api/admin/exams...` | Upload, list, edit, activate and delete exams |
| `GET /api/admin/submissions` | Review all sessions, answers and MCQ scores |
| `GET /api/admin/submissions.csv` | Download student/exam/submission summary and MCQ scores as CSV |

Admin endpoints accept either `Authorization: Bearer <token>` or the legacy `X-Admin-Key` header.

For development, opening `/admin` signs in automatically with `demo-admin-change-me` while that default key is active. There is also a **Use demo key** button if a session expires. If `MNH_ADMIN_KEY` is set, the button is hidden and the custom key must be typed (leading/trailing spaces are ignored).

## Student names, MCQ marking and results export
Students enter their name on the welcome screen before starting. The name is remembered in that browser and shown in the admin submission list; if left blank the session is recorded as `Demo Student`.

MCQs with an `answer` key are marked automatically. Admin submissions show the score (`MCQ correct/total · marks/max`) and correct each MCQ answer block; text and handwritten answers still require human review. Click **Download CSV** in the Submissions panel to export session, student, exam, submitted time, status and MCQ scores.

## Read questions aloud (voice generator)
Each question has a **🔊 Listen** button. It reads the question (and all MCQ options) using gTTS, with a language selector (English, Français, Kiswahili, Amharic, Hausa, العربية) and playback speed (0.75× / 1× / 1.25×). Choices are remembered in the browser.

Long passages are supported: text is split on sentence boundaries into ~800-character pieces, each piece is cached separately, and the pieces are assembled into one MP3. The limit is 20,000 characters (~3,000 words), so 2,000-word questions work. Generation is slower the first time because gTTS makes many small requests to Google; repeat listens are instant thanks to the cache.

API: `POST /api/tts` with JSON `{"text": "...", "lang": "en"}` is the long-text endpoint (no URL-length limit). `GET /api/tts?text=...&lang=en` remains for short text up to 1,500 characters. Generated audio is cached in `backend/audio_cache/` (with per-chunk files in `audio_cache/chunks/`). The server needs internet access for gTTS; if unavailable, the button shows a clear error instead of breaking the exam. Add more languages by extending `TTS_LANGUAGES` in `backend/main.py`.

## Editable answer sheets (students can write on them)
Two ways to write on the examination are included:

1. **Word-compatible file** — students click **⬇ Editable sheet** in the student portal, or an admin clicks **Editable sheet** beside any uploaded exam. The server generates a `.docx` containing the questions, options and blank ruled answer space. Students can type into it, or print it and write by hand.
2. **Write directly in the browser** — students click **✍ Write on sheet** to open a paginated A4 worksheet. They can draw with a mouse, touch screen or stylus, change pen colour/size, undo, clear a page, download a page as JPEG, and save each page with their answers. Saved pages appear in the admin submission review as **Editable worksheet · page N**.

Endpoints: `GET /api/exam/answer-sheet.docx` (active exam) and `GET /api/admin/exams/{id}/answer-sheet.docx` (admin token required). Written worksheet pages are stored as JPEG data URLs in the answers JSON, so the answer payload limit is 12 MB.

The admin key input is trimmed automatically, so a copied key with a trailing space still works. If `MNH_ADMIN_KEY` is set on the server, use that value instead of the default shown on the sign-in page.

## Demo limitations
This is a prototype, not production-ready. It has no real identity checks, invigilation or MNH Calendar-v13 integration. The admin key is a shared secret and admin tokens live in server memory (a restart signs everyone out). Data is stored in a local SQLite file (`backend/exam_demo.db`); handwriting and worksheet pages are stored as PNG/JPEG data URLs in that database, suitable only for small demos. Use HTTPS, real accounts/roles, file storage and audit logging before any real deployment.
