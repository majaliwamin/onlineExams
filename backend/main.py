"""MNH Examination demo API.

Demonstration only: the admin key is a shared demo secret, not real identity
management. See README.md for the exam upload format and quick start.
"""

from __future__ import annotations

import base64
import binascii
import csv
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as xml_escape

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "backend" / "exam_demo.db"
DEFAULT_ADMIN_KEY = "demo-admin-change-me"
ADMIN_KEY = os.getenv("MNH_ADMIN_KEY", DEFAULT_ADMIN_KEY)
TOKEN_TTL = 8 * 60 * 60
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_ANSWERS_CHARS = 12 * 1024 * 1024   # allows several written worksheet pages
ALLOWED_ATTACHMENT_TYPES = {"application/pdf", "image/png", "image/jpeg"}
AUDIO_CACHE = ROOT / "backend" / "audio_cache"
TTS_LANGUAGES = {"en", "fr", "sw", "am", "ha", "ar"}
MAX_TTS_CHARS = 20000          # roughly 3000 words
MAX_QUESTION_CHARS = 20000     # allow long passage questions
TTS_CHUNK_CHARS = 800          # sentence-sized pieces for caching
MAX_TTS_GET_CHARS = 1500       # keep GET URLs within server limits
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

app = FastAPI(title="MNH Examination Demo")
app.mount("/assets", StaticFiles(directory=ROOT / "frontend"), name="assets")

# Server-side admin sessions (in memory: a server restart invalidates them).
_tokens: dict[str, float] = {}
_tts_locks: dict[str, threading.Lock] = {}


# ---------------------------------------------------------------------------
# Built-in fallback exam (also used to seed the database on first run).
# ---------------------------------------------------------------------------
BUILTIN_QUESTIONS: list[dict[str, Any]] = [
    {"id": 1, "text": "What is the value of 2³ + 4²?", "type": "mcq", "options": ["12", "16", "20", "24"], "marks": 5, "answer": 1},
    {"id": 2, "text": "Define epidemiology.", "type": "text", "marks": 10},
    {"id": 3, "text": "Describe two functions of the placenta.", "type": "text", "marks": 10},
    {"id": 4, "text": "Explain the difference between incidence and prevalence.", "type": "text", "marks": 10},
    {"id": 5, "text": "List four components of antenatal care.", "type": "text", "marks": 10},
    {"id": 6, "text": "What is the role of haemoglobin?", "type": "text", "marks": 10},
    {"id": 7, "text": "Describe the transmission of malaria.", "type": "text", "marks": 10},
    {"id": 8, "text": "State three principles of infection prevention.", "type": "text", "marks": 10},
    {"id": 9, "text": "What is informed consent?", "type": "text", "marks": 10},
    {"id": 10, "text": "Describe one approach to improve maternal health outcomes.", "type": "text", "marks": 10},
]


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class StartPayload(BaseModel):
    student: str = "Demo Student"


class AnswerPayload(BaseModel):
    answers: dict


class SubmitPayload(BaseModel):
    answers: dict


class LoginPayload(BaseModel):
    key: str


class TTSRequest(BaseModel):
    text: str
    lang: str = "en"


class AttachmentPayload(BaseModel):
    filename: str
    content_type: str
    data: str  # base64-encoded file bytes


class ExamPayload(BaseModel):
    title: str
    duration_minutes: int
    questions: list[dict]
    attachment: AttachmentPayload | None = None
    activate: bool = True


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
@contextmanager
def db():
    conn = sqlite3.connect(DB, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS exams(
                 id TEXT PRIMARY KEY,
                 title TEXT NOT NULL,
                 duration_minutes INTEGER NOT NULL,
                 total_marks INTEGER NOT NULL,
                 questions TEXT NOT NULL,
                 attachment_name TEXT,
                 attachment_type TEXT,
                 attachment_data BLOB,
                 active INTEGER NOT NULL DEFAULT 0,
                 created REAL NOT NULL
               )"""
        )
        c.execute(
            """CREATE TABLE IF NOT EXISTS sessions(
                 id TEXT PRIMARY KEY,
                 student TEXT NOT NULL,
                 exam_id TEXT,
                 exam_title TEXT,
                 duration_minutes INTEGER DEFAULT 30,
                 started REAL NOT NULL,
                 expires REAL NOT NULL,
                 submitted REAL,
                 answers TEXT NOT NULL DEFAULT '{}'
               )"""
        )
        # Upgrade databases created by earlier versions of the demo.
        existing = {row["name"] for row in c.execute("PRAGMA table_info(sessions)")}
        for column, definition in (
            ("exam_id", "TEXT"),
            ("exam_title", "TEXT"),
            ("duration_minutes", "INTEGER DEFAULT 30"),
        ):
            if column not in existing:
                c.execute(f"ALTER TABLE sessions ADD COLUMN {column} {definition}")

        if c.execute("SELECT COUNT(*) FROM exams").fetchone()[0] == 0:
            c.execute(
                """INSERT INTO exams
                   (id, title, duration_minutes, total_marks, questions,
                    attachment_name, attachment_type, attachment_data, active, created)
                   VALUES(?,?,?,?,?,?,?,?,1,?)""",
                (
                    "builtin",
                    "MNH Practice Examination",
                    30,
                    sum(q["marks"] for q in BUILTIN_QUESTIONS),
                    json.dumps(BUILTIN_QUESTIONS),
                    None,
                    None,
                    None,
                    time.time(),
                ),
            )


init_db()
AUDIO_CACHE.mkdir(parents=True, exist_ok=True)
(AUDIO_CACHE / "chunks").mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
def issue_token() -> tuple[str, float]:
    token = secrets.token_urlsafe(32)
    expires_at = time.time() + TOKEN_TTL
    _tokens[token] = expires_at
    for old_token, expiry in list(_tokens.items()):
        if expiry <= time.time():
            _tokens.pop(old_token, None)
    return token, expires_at


def require_admin(
    authorization: str = Header(default=""), x_admin_key: str = Header(default="")
) -> None:
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if token and _tokens.get(token, 0) > time.time():
        return
    # Legacy header support: useful for scripts and backwards compatibility.
    if x_admin_key and secrets.compare_digest(x_admin_key, ADMIN_KEY):
        return
    raise HTTPException(401, "Admin key required. Sign in on the admin page.")


@app.get("/api/admin/demo-access")
def demo_access():
    """Let the admin UI offer one-tap sign-in only while the default key is active."""
    return {"enabled": secrets.compare_digest(ADMIN_KEY, DEFAULT_ADMIN_KEY)}


@app.post("/api/admin/login")
def login(payload: LoginPayload):
    # Copy/paste often adds a trailing space; accept it without weakening the key.
    supplied = (payload.key or "").strip()
    if not supplied or not secrets.compare_digest(supplied, ADMIN_KEY):
        raise HTTPException(401, "Invalid admin key. Check for extra spaces; the key is case-sensitive.")
    token, expires_at = issue_token()
    return {"token": token, "expires_at": expires_at}


# ---------------------------------------------------------------------------
# Exam validation / serialisation
# ---------------------------------------------------------------------------
def normalise_answer(raw: Any, options: list[str], question_number: int) -> int:
    """Accept a 0-based index, an A-H letter, or the exact correct option text."""
    if isinstance(raw, bool):
        raise HTTPException(400, f"Question {question_number} answer must identify an option")
    if isinstance(raw, int):
        index = raw
    elif isinstance(raw, str):
        value = raw.strip()
        if not value:
            raise HTTPException(400, f"Question {question_number} answer cannot be empty")
        if len(value) == 1 and value.upper() in "ABCDEFGH":
            index = ord(value.upper()) - ord("A")
        elif value.isdigit():
            index = int(value)
        else:
            matches = [i for i, option in enumerate(options) if option.casefold() == value.casefold()]
            if len(matches) != 1:
                raise HTTPException(400, f"Question {question_number} answer must match one option exactly")
            index = matches[0]
    else:
        raise HTTPException(400, f"Question {question_number} answer must be an index, letter or option text")
    if not 0 <= index < len(options):
        raise HTTPException(400, f"Question {question_number} answer is outside the available options")
    return index


def student_questions(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Never reveal the stored correct answer to a student."""
    return [{key: value for key, value in question.items() if key != "answer"} for question in questions]


def normalise_exam(payload: ExamPayload) -> dict[str, Any]:
    title = (payload.title or "").strip()
    if not title or len(title) > 160:
        raise HTTPException(400, "Title must be 1-160 characters")

    duration = payload.duration_minutes
    if isinstance(duration, bool) or not isinstance(duration, int) or not 1 <= duration <= 480:
        raise HTTPException(400, "Duration must be an integer from 1 to 480 minutes")

    questions = payload.questions
    if not isinstance(questions, list) or not 1 <= len(questions) <= 200:
        raise HTTPException(400, "Provide between 1 and 200 questions")

    normalised: list[dict[str, Any]] = []
    for index, question in enumerate(questions, start=1):
        if not isinstance(question, dict):
            raise HTTPException(400, f"Question {index} must be an object")
        text = str(question.get("text", "")).strip()
        if not text or len(text) > MAX_QUESTION_CHARS:
            raise HTTPException(400, f"Question {index} text must be 1-{MAX_QUESTION_CHARS} characters")
        qtype = str(question.get("type", "text")).strip().lower()
        if qtype not in {"mcq", "text"}:
            raise HTTPException(400, f"Question {index} type must be 'mcq' or 'text'")
        marks = question.get("marks", 1)
        if isinstance(marks, bool) or not isinstance(marks, int) or not 1 <= marks <= 1000:
            raise HTTPException(400, f"Question {index} marks must be an integer from 1 to 1000")

        item: dict[str, Any] = {"id": index, "text": text, "type": qtype, "marks": marks}
        if qtype == "mcq":
            raw_options = question.get("options")
            if not isinstance(raw_options, list) or not 2 <= len(raw_options) <= 8:
                raise HTTPException(400, f"Question {index} needs 2-8 options")
            options = [str(option).strip() for option in raw_options]
            if any(not option for option in options):
                raise HTTPException(400, f"Question {index} has an empty option")
            if len(set(options)) != len(options):
                raise HTTPException(400, f"Question {index} has duplicate options")
            item["options"] = options
            if "answer" in question and question["answer"] is not None:
                item["answer"] = normalise_answer(question["answer"], options, index)
        normalised.append(item)

    attachment: dict[str, Any] | None = None
    if payload.attachment is not None:
        filename = re.sub(r"[^A-Za-z0-9._ -]", "_", Path(payload.attachment.filename).name).strip()
        filename = filename[:120] or "attachment"
        content_type = payload.attachment.content_type.strip().lower()
        if content_type not in ALLOWED_ATTACHMENT_TYPES:
            raise HTTPException(400, "Attachment must be a PDF, PNG or JPEG file")
        try:
            raw = base64.b64decode(payload.attachment.data, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(400, "Attachment data is not valid base64")
        if not raw or len(raw) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(400, "Attachment must be non-empty and at most 10 MB")
        attachment = {"filename": filename, "content_type": content_type, "data": raw}

    return {
        "title": title,
        "duration_minutes": duration,
        "total_marks": sum(q["marks"] for q in normalised),
        "questions": normalised,
        "attachment": attachment,
    }


def exam_summary(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "duration_minutes": row["duration_minutes"],
        "total_marks": row["total_marks"],
        "question_count": len(json.loads(row["questions"])),
        "has_attachment": bool(row["attachment_data"]),
        "attachment_name": row["attachment_name"],
        "active": bool(row["active"]),
        "created_at": row["created"],
    }


def active_exam_row(c: sqlite3.Connection) -> sqlite3.Row | None:
    return c.execute("SELECT * FROM exams WHERE active=1 ORDER BY created DESC LIMIT 1").fetchone()


def public_exam(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        # Graceful fallback if every uploaded exam was deleted.
        return {
            "id": "builtin",
            "title": "MNH Practice Examination",
            "duration_minutes": 30,
            "total_marks": sum(q["marks"] for q in BUILTIN_QUESTIONS),
            "questions": student_questions(BUILTIN_QUESTIONS),
            "has_attachment": False,
        }
    return {
        "id": row["id"],
        "title": row["title"],
        "duration_minutes": row["duration_minutes"],
        "total_marks": row["total_marks"],
        "questions": student_questions(json.loads(row["questions"])),
        "has_attachment": bool(row["attachment_data"]),
        "attachment_url": "/api/exam/attachment" if row["attachment_data"] else None,
    }


# ---------------------------------------------------------------------------
# Editable answer sheet (.docx generated without extra dependencies)
# ---------------------------------------------------------------------------
def docx_text(value: str) -> str:
    return xml_escape(str(value or "")).replace("\r\n", "\n").replace("\n", "<w:br/>")


def docx_para(text: str = "", bold: bool = False, size: int = 22, after: int = 120) -> str:
    run_props = "<w:rPr>"
    if bold:
        run_props += "<w:b/>"
    run_props += f'<w:sz w:val="{size}"/></w:rPr>'
    return (
        f'<w:p><w:pPr><w:spacing w:after="{after}" w:line="276" w:lineRule="auto"/></w:pPr>'
        f'<w:r>{run_props}<w:t xml:space="preserve">{docx_text(text)}</w:t></w:r></w:p>'
    )


def docx_rule() -> str:
    return docx_para("_" * 76, size=20, after=170)


def safe_filename(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", value or "").strip("_")
    return name[:60] or "examination"


def build_answer_sheet_docx(exam: dict[str, Any]) -> bytes:
    """Create a Word-compatible worksheet with questions and blank answer space."""
    body = [
        docx_para(exam.get("title") or "Examination", bold=True, size=34, after=80),
        docx_para(
            f"Duration: {exam.get('duration_minutes', 30)} minutes    "
            f"Total marks: {exam.get('total_marks', 0)}",
            size=20,
            after=80,
        ),
        docx_para("Name: ______________________________    Date: ____________________", size=20, after=160),
        docx_para(
            "Answer all questions in the spaces provided. You may type into this file "
            "or print it and write by hand.",
            size=18,
            after=240,
        ),
    ]

    for index, question in enumerate(exam.get("questions", []), 1):
        body.append(
            docx_para(f"Question {index} ({question.get('marks', 0)} marks)", bold=True, size=25, after=70)
        )
        body.append(docx_para(question.get("text", ""), size=22, after=100))
        if question.get("type") == "mcq":
            for option_index, option in enumerate(question.get("options", [])):
                body.append(docx_para(f"{chr(65 + option_index)}. {option}", size=21, after=50))
        body.extend(docx_rule() for _ in range(3 if question.get("type") == "mcq" else 5))
        body.append(docx_para("", after=120))

    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + "".join(body)
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
          '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" '
          'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>'
    )
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"""
    root_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""
    styles = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>"""
    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f'<dc:title>{xml_escape(str(exam.get("title") or "Examination"))} - Answer Sheet</dc:title>'
        "</cp:coreProperties>"
    )
    app = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>MNH Examination Demo</Application>
</Properties>"""

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("word/document.xml", document_xml)
        archive.writestr("word/styles.xml", styles)
        archive.writestr("docProps/core.xml", core)
        archive.writestr("docProps/app.xml", app)
    return buffer.getvalue()


def answer_sheet_response(exam: dict[str, Any]) -> Response:
    filename = f"{safe_filename(exam.get('title', ''))}-answer-sheet.docx"
    return Response(
        build_answer_sheet_docx(exam),
        media_type=DOCX_MIME,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Static pages and student API
# ---------------------------------------------------------------------------
@app.get("/")
def home():
    return FileResponse(ROOT / "frontend" / "index.html")


@app.get("/admin")
def admin_page():
    return FileResponse(ROOT / "frontend" / "admin.html")


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.get("/api/sample-exam", dependencies=[Depends(require_admin)])
def sample_exam():
    """Return the bundled example exam so admins can load it with one click."""
    path = ROOT / "examples" / "sample-exam.json"
    if not path.exists():
        raise HTTPException(404, "Sample exam file is missing")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/exam")
def exam():
    with db() as c:
        return public_exam(active_exam_row(c))


@app.get("/api/exam/answer-sheet.docx")
def exam_answer_sheet():
    """Download the active examination as an editable Word worksheet."""
    with db() as c:
        row = active_exam_row(c)
        if row is None:
            raise HTTPException(404, "No active examination")
        return answer_sheet_response(public_exam(row))


@app.get("/api/exam/attachment")
def exam_attachment():
    with db() as c:
        row = active_exam_row(c)
        if row is None or not row["attachment_data"]:
            raise HTTPException(404, "This examination has no attached document")
        filename = row["attachment_name"] or "examination"
        return Response(
            bytes(row["attachment_data"]),
            media_type=row["attachment_type"],
            headers={"Content-Disposition": f'inline; filename="{filename}"'},
        )


def validate_tts(text: str, lang: str) -> str:
    text = " ".join((text or "").split())
    if not text or len(text) > MAX_TTS_CHARS:
        raise HTTPException(400, f"Text must be 1-{MAX_TTS_CHARS} characters")
    if lang not in TTS_LANGUAGES:
        raise HTTPException(400, "Unsupported language code")
    return text


def split_tts_text(text: str, limit: int = TTS_CHUNK_CHARS) -> list[str]:
    """Split on sentence boundaries, then on words for over-long sentences."""
    chunks: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        while len(sentence) > limit:
            cut = sentence.rfind(" ", 0, limit)
            if cut <= 0:
                cut = limit
            chunks.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            chunks.append(sentence)
    return [chunk for chunk in chunks if chunk]


def tts_chunk_path(text: str, lang: str) -> Path:
    """Return a cached MP3 for one chunk, generating it if needed."""
    key = hashlib.sha256(f"{lang}|{text}".encode("utf-8")).hexdigest()
    cached = AUDIO_CACHE / "chunks" / f"{key}.mp3"
    if cached.exists():
        return cached

    lock = _tts_locks.setdefault(f"chunk:{key}", threading.Lock())
    with lock:
        if cached.exists():
            return cached
        temporary = AUDIO_CACHE / "chunks" / f"{key}.{uuid.uuid4().hex}.tmp"
        try:
            from gtts import gTTS
            gTTS(text=text, lang=lang).save(str(temporary))
            temporary.replace(cached)
        except ImportError as exc:
            temporary.unlink(missing_ok=True)
            raise HTTPException(503, "gTTS is not installed on the server") from exc
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            raise HTTPException(
                503, "Speech generation is unavailable. Check the server's internet connection."
            ) from exc
    return cached


def synthesise_speech(text: str, lang: str) -> Path:
    """Generate or reuse a complete MP3, built from cached sentence chunks."""
    key = hashlib.sha256(f"{lang}|{text}".encode("utf-8")).hexdigest()
    final = AUDIO_CACHE / f"{key}.mp3"
    if final.exists():
        return final

    lock = _tts_locks.setdefault(f"full:{key}", threading.Lock())
    with lock:
        if final.exists():
            return final
        temporary = AUDIO_CACHE / f"{key}.{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("wb") as output:
                for chunk in split_tts_text(text):
                    output.write(tts_chunk_path(chunk, lang).read_bytes())
            temporary.replace(final)
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(503, "Could not assemble the audio file.") from exc
    return final


def tts_response(path: Path) -> FileResponse:
    return FileResponse(
        path,
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/tts")
def text_to_speech(text: str = "", lang: str = "en"):
    """Short-text endpoint; use POST /api/tts for long passages."""
    text = validate_tts(text, lang)
    if len(text) > MAX_TTS_GET_CHARS:
        raise HTTPException(413, "Use POST /api/tts for text over 1500 characters")
    return tts_response(synthesise_speech(text, lang))


@app.post("/api/tts")
def text_to_speech_long(payload: TTSRequest):
    """Generate speech for passages up to ~3000 words (JSON body)."""
    text = validate_tts(payload.text, payload.lang)
    return tts_response(synthesise_speech(text, lang=payload.lang))


@app.post("/api/session/start")
def start(payload: StartPayload):
    student = (payload.student or "").strip() or "Demo Student"
    if len(student) > 80:
        raise HTTPException(400, "Student name must be at most 80 characters")
    with db() as c:
        current = active_exam_row(c)
        if current is None:
            current_data = public_exam(None)
            exam_id, exam_title, duration = current_data["id"], current_data["title"], current_data["duration_minutes"]
        else:
            exam_id, exam_title, duration = current["id"], current["title"], current["duration_minutes"]

        sid = str(uuid.uuid4())
        now = time.time()
        expires = now + duration * 60
        c.execute(
            """INSERT INTO sessions
               (id, student, exam_id, exam_title, duration_minutes, started, expires, submitted, answers)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (sid, student, exam_id, exam_title, duration, now, expires, None, "{}"),
        )
        return {
            "session_id": sid,
            "student": student,
            "exam_id": exam_id,
            "exam_title": exam_title,
            "started_at": now,
            "expires_at": expires,
        }


def session_row(c: sqlite3.Connection, sid: str) -> sqlite3.Row:
    row = c.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    if row is None:
        raise HTTPException(404, "Session not found")
    return row


@app.get("/api/session/{sid}")
def get_session(sid: str):
    with db() as c:
        r = session_row(c, sid)
        return {
            "session_id": sid,
            "student": r["student"],
            "exam_id": r["exam_id"] or "builtin",
            "exam_title": r["exam_title"] or "MNH Practice Examination",
            "started_at": r["started"],
            "expires_at": r["expires"],
            "submitted": bool(r["submitted"]),
            "answers": json.loads(r["answers"] or "{}"),
        }


def ensure_writable(row: sqlite3.Row) -> None:
    if row["submitted"]:
        raise HTTPException(409, "This examination has already been submitted")
    if time.time() > row["expires"]:
        raise HTTPException(410, "Time expired. The examination has been closed.")


@app.put("/api/session/{sid}/answers")
def save_answers(sid: str, payload: AnswerPayload):
    encoded = json.dumps(payload.answers, ensure_ascii=False)
    if len(encoded) > MAX_ANSWERS_CHARS:
        raise HTTPException(413, "Answers are too large")
    with db() as c:
        ensure_writable(session_row(c, sid))
        c.execute("UPDATE sessions SET answers=? WHERE id=?", (encoded, sid))
        return {"saved": True, "saved_at": time.time()}


@app.post("/api/session/{sid}/submit")
def submit(sid: str, payload: SubmitPayload):
    encoded = json.dumps(payload.answers, ensure_ascii=False)
    if len(encoded) > MAX_ANSWERS_CHARS:
        raise HTTPException(413, "Answers are too large")
    with db() as c:
        row = session_row(c, sid)
        if row["submitted"]:
            return {
                "submitted": True,
                "receipt": "MNH-" + sid[:8].upper(),
                "submitted_at": row["submitted"],
            }
        # After the deadline, keep the last autosaved answers rather than
        # accepting a late overwrite from a client-side timer.
        expired = time.time() > row["expires"]
        answers = row["answers"] if expired else encoded
        submitted_at = row["expires"] if expired else time.time()
        c.execute(
            "UPDATE sessions SET answers=?, submitted=? WHERE id=?",
            (answers, submitted_at, sid),
        )
        return {
            "submitted": True,
            "receipt": "MNH-" + sid[:8].upper(),
            "submitted_at": submitted_at,
            "exam_title": row["exam_title"] or "MNH Practice Examination",
        }


# ---------------------------------------------------------------------------
# Admin API
# ---------------------------------------------------------------------------
@app.get("/api/admin/exams", dependencies=[Depends(require_admin)])
def list_exams():
    with db() as c:
        return [exam_summary(row) for row in c.execute("SELECT * FROM exams ORDER BY created DESC")]


@app.post("/api/admin/exams", status_code=201, dependencies=[Depends(require_admin)])
def upload_exam(payload: ExamPayload):
    data = normalise_exam(payload)
    exam_id = str(uuid.uuid4())
    with db() as c:
        if payload.activate or c.execute("SELECT COUNT(*) FROM exams").fetchone()[0] == 0:
            c.execute("UPDATE exams SET active=0")
            active = 1
        else:
            active = 0
        c.execute(
            """INSERT INTO exams
               (id, title, duration_minutes, total_marks, questions,
                attachment_name, attachment_type, attachment_data, active, created)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                exam_id,
                data["title"],
                data["duration_minutes"],
                data["total_marks"],
                json.dumps(data["questions"], ensure_ascii=False),
                data["attachment"]["filename"] if data["attachment"] else None,
                data["attachment"]["content_type"] if data["attachment"] else None,
                sqlite3.Binary(data["attachment"]["data"]) if data["attachment"] else None,
                active,
                time.time(),
            ),
        )
        row = c.execute("SELECT * FROM exams WHERE id=?", (exam_id,)).fetchone()
        return exam_summary(row)


@app.get("/api/admin/exams/{exam_id}", dependencies=[Depends(require_admin)])
def get_admin_exam(exam_id: str):
    with db() as c:
        row = c.execute("SELECT * FROM exams WHERE id=?", (exam_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Examination not found")
        # Admins need the private answer key when they edit an exam.
        data = {
            "id": row["id"],
            "title": row["title"],
            "duration_minutes": row["duration_minutes"],
            "total_marks": row["total_marks"],
            "questions": json.loads(row["questions"]),
            "has_attachment": bool(row["attachment_data"]),
            "attachment_url": "/api/admin/exams/" + row["id"] + "/attachment" if row["attachment_data"] else None,
        }
        data.update(exam_summary(row))
        return data


@app.get("/api/admin/exams/{exam_id}/answer-sheet.docx", dependencies=[Depends(require_admin)])
def admin_answer_sheet(exam_id: str):
    """Download any uploaded examination as an editable Word worksheet."""
    with db() as c:
        row = c.execute("SELECT * FROM exams WHERE id=?", (exam_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Examination not found")
        return answer_sheet_response(public_exam(row))


@app.put("/api/admin/exams/{exam_id}", dependencies=[Depends(require_admin)])
def replace_exam(exam_id: str, payload: ExamPayload):
    data = normalise_exam(payload)
    with db() as c:
        row = c.execute("SELECT * FROM exams WHERE id=?", (exam_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Examination not found")
        active = 1 if payload.activate else row["active"]
        if active:
            c.execute("UPDATE exams SET active=0 WHERE id<>?", (exam_id,))
        c.execute("DELETE FROM exams WHERE id=?", (exam_id,))
        c.execute(
            """INSERT INTO exams
               (id, title, duration_minutes, total_marks, questions,
                attachment_name, attachment_type, attachment_data, active, created)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                exam_id,
                data["title"],
                data["duration_minutes"],
                data["total_marks"],
                json.dumps(data["questions"], ensure_ascii=False),
                data["attachment"]["filename"] if data["attachment"] else None,
                data["attachment"]["content_type"] if data["attachment"] else None,
                sqlite3.Binary(data["attachment"]["data"]) if data["attachment"] else None,
                active,
                time.time(),
            ),
        )
        return exam_summary(c.execute("SELECT * FROM exams WHERE id=?", (exam_id,)).fetchone())


@app.post("/api/admin/exams/{exam_id}/activate", dependencies=[Depends(require_admin)])
def activate_exam(exam_id: str):
    with db() as c:
        if c.execute("SELECT 1 FROM exams WHERE id=?", (exam_id,)).fetchone() is None:
            raise HTTPException(404, "Examination not found")
        c.execute("UPDATE exams SET active=0")
        c.execute("UPDATE exams SET active=1 WHERE id=?", (exam_id,))
        return {"activated": exam_id}


@app.delete("/api/admin/exams/{exam_id}", dependencies=[Depends(require_admin)])
def delete_exam(exam_id: str):
    with db() as c:
        row = c.execute("SELECT * FROM exams WHERE id=?", (exam_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Examination not found")
        c.execute("DELETE FROM exams WHERE id=?", (exam_id,))
        if row["active"]:
            remaining = c.execute("SELECT id FROM exams ORDER BY created DESC LIMIT 1").fetchone()
            if remaining:
                c.execute("UPDATE exams SET active=1 WHERE id=?", (remaining["id"],))
        return {"deleted": exam_id}


@app.get("/api/admin/exams/{exam_id}/attachment", dependencies=[Depends(require_admin)])
def admin_exam_attachment(exam_id: str):
    with db() as c:
        row = c.execute("SELECT * FROM exams WHERE id=?", (exam_id,)).fetchone()
        if row is None or not row["attachment_data"]:
            raise HTTPException(404, "Attachment not found")
        filename = row["attachment_name"] or "attachment"
        return Response(
            bytes(row["attachment_data"]),
            media_type=row["attachment_type"],
            headers={"Content-Disposition": f'inline; filename="{filename}"'},
        )


def known_answer_map() -> dict[tuple[str, tuple[str, ...]], int]:
    """Answer keys for exams uploaded before MCQ marking was added."""
    sources: list[dict[str, Any]] = list(BUILTIN_QUESTIONS)
    sample_path = ROOT / "examples" / "sample-exam.json"
    if sample_path.exists():
        try:
            sources.extend(json.loads(sample_path.read_text(encoding="utf-8")).get("questions", []))
        except (ValueError, OSError):
            pass
    keys: dict[tuple[str, tuple[str, ...]], int] = {}
    for question in sources:
        answer = question.get("answer")
        if answer is None:
            continue
        text = str(question.get("text", "")).strip().casefold()
        options = tuple(str(option).strip().casefold() for option in question.get("options", []))
        keys[(text, options)] = answer
    return keys


def grading_questions(c: sqlite3.Connection, exam_id: str) -> list[dict[str, Any]]:
    """Load the private question key used to mark MCQs."""
    row = c.execute("SELECT questions FROM exams WHERE id=?", (exam_id,)).fetchone()
    if row is None:
        return BUILTIN_QUESTIONS if exam_id == "builtin" else []
    questions = json.loads(row["questions"] or "[]")
    known = known_answer_map()
    for question in questions:
        if question.get("type") == "mcq" and question.get("answer") is None:
            text = str(question.get("text", "")).strip().casefold()
            options = tuple(str(option).strip().casefold() for option in question.get("options", []))
            question["answer"] = known.get((text, options))
    return questions


def submitted_answer_text(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("text") or "")
    if isinstance(value, str) and not value.startswith("data:image/"):
        return value
    return ""


def grade_submission(answers: dict[str, Any], questions: list[dict[str, Any]]) -> dict[str, Any]:
    """Auto-mark MCQs only. Text and written answers still need human review."""
    details: list[dict[str, Any]] = []
    for question in questions:
        if question.get("type") != "mcq" or question.get("answer") is None:
            continue
        options = question.get("options") or []
        index = question["answer"]
        if not isinstance(index, int) or not 0 <= index < len(options):
            continue
        correct = options[index]
        given = submitted_answer_text(answers.get(str(question.get("id")), answers.get(question.get("id"))))
        is_correct = given.strip().casefold() == correct.strip().casefold()
        marks = question.get("marks", 0) if isinstance(question.get("marks", 0), int) else 0
        details.append({
            "question_id": question.get("id"),
            "given": given,
            "correct": correct,
            "is_correct": is_correct,
            "awarded_marks": marks if is_correct else 0,
            "max_marks": marks,
        })
    awarded = sum(item["awarded_marks"] for item in details)
    maximum = sum(item["max_marks"] for item in details)
    return {
        "correct": sum(1 for item in details if item["is_correct"]),
        "total": len(details),
        "marks": awarded,
        "max_marks": maximum,
        "details": details,
    }


@app.get("/api/admin/submissions.csv", dependencies=[Depends(require_admin)])
def submissions_csv():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Session ID", "Student", "Exam", "Started", "Submitted", "Status",
        "MCQ correct", "MCQ questions", "MCQ marks", "MCQ max marks",
    ])
    with db() as c:
        rows = c.execute("SELECT * FROM sessions ORDER BY started DESC").fetchall()
        for r in rows:
            answers = json.loads(r["answers"] or "{}")
            grade = grade_submission(answers, grading_questions(c, r["exam_id"] or "builtin"))
            writer.writerow([
                r["id"],
                r["student"],
                r["exam_title"] or "MNH Practice Examination",
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["started"])),
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["submitted"])) if r["submitted"] else "",
                "Submitted" if r["submitted"] else "In progress",
                grade["correct"],
                grade["total"],
                grade["marks"],
                grade["max_marks"],
            ])
    return Response(
        content="\ufeff" + output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="mnh-results.csv"'},
    )


@app.get("/api/admin/submissions", dependencies=[Depends(require_admin)])
def submissions():
    with db() as c:
        rows = c.execute("SELECT * FROM sessions ORDER BY started DESC").fetchall()
        return [
            {
                "session_id": r["id"],
                "student": r["student"],
                "exam_id": r["exam_id"] or "builtin",
                "exam_title": r["exam_title"] or "MNH Practice Examination",
                "started_at": r["started"],
                "expires_at": r["expires"],
                "submitted_at": r["submitted"],
                "answers": json.loads(r["answers"] or "{}"),
                "grade": grade_submission(
                    json.loads(r["answers"] or "{}"),
                    grading_questions(c, r["exam_id"] or "builtin"),
                ),
            }
            for r in rows
        ]
