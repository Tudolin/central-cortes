#!/usr/bin/env python3
"""
Viral Clip Generator - local/offline short-form clip maker.

README
======

What it does
------------
Takes a local MP4 file or a YouTube URL, transcribes it locally with
faster-whisper, asks a local Ollama model to score viral moments across 18
criteria, cuts the best clips, converts them to 1080x1920 vertical video, and
burns word-highlighted ASS subtitles into each clip.

Install
-------
1. Install Python 3.10+.
2. Install ffmpeg and make sure `ffmpeg` and `ffprobe` are available in PATH:
   - Windows: https://www.gyan.dev/ffmpeg/builds/
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`
3. Install Ollama and pull a local model:
   - https://ollama.com/
   - `ollama pull llama3`
   - Optional: `ollama pull mistral`
4. Install Python dependencies:
   - `python -m pip install -r requirements.txt`

Usage
-----
Local file:
    python main.py "C:\\videos\\podcast.mp4" --language pt --output output

YouTube URL:
    python main.py "https://www.youtube.com/watch?v=VIDEO_ID" --language en

Useful options:
    --max-duration 60
    --min-duration 20
    --context-padding 18
    --skip-start 90
    --clip-count 12
    --analysis-mode debate
    --model qwen3:14b
    --ollama-context 16384
    --whisper-model small
    --device cpu
    --no-face-crop

Notes
-----
- Everything runs locally/offline except YouTube downloading.
- If Ollama is not running, the script falls back to a local heuristic scorer.
- If OpenCV is not installed or no face is found, the script uses center crop.
- The first faster-whisper run may download the model weights.
- Outputs are saved under ./output/<video_title>/ with clips.json,
  transcript.txt, transcript.json, argument_map.json, and rendered clips.
- `--analysis-mode debate` asks Ollama to map complete argument blocks before
  scoring clips. This is better for podcasts, interviews, and political debates.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    from rich.console import Console
    from rich.progress import Progress, SpinnerColumn, TextColumn
    from rich.table import Table
except ImportError:  # pragma: no cover - only used before dependencies exist.
    Console = None


OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
FFMPEG_BIN = "ffmpeg"
FFPROBE_BIN = "ffprobe"
VIRAL_PARAMETERS = [
    "Humor / joke presence",
    "Emotional peak (excitement, anger, sadness)",
    "Surprising or unexpected statement",
    "Strong opinion or controversial take",
    "Call to action or rhetorical question",
    "Storytelling hook",
    "Relatability score",
    "Information density (value per second)",
    "Tension or conflict",
    "Resolution or punchline",
    "Curiosity gap (cliffhanger)",
    "Social proof or credibility signal",
    "Repetition for emphasis",
    "Novelty / unique insight",
    "Energy level inferred from speech pace and punctuation",
    "Clear beginning-middle-end structure",
    "Shareability",
    "Platform fit score for short-form vertical video",
]


@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: list[Word]


@dataclass
class ClipCandidate:
    start_time: float
    end_time: float
    score: int
    title: str
    reason: str = ""


def get_console() -> Any:
    if Console is None:
        print("Missing dependency: rich. Run `python -m pip install -r requirements.txt`.")
        sys.exit(1)
    return Console()


console = get_console()


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=check,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def resolve_binary(name: str, explicit_path: str | None = None) -> str:
    candidates: list[Path | str] = []
    env_name = f"{name.upper()}_PATH"
    env_dir = os.environ.get("FFMPEG_DIR")

    if explicit_path:
        candidates.append(Path(explicit_path).expanduser())
    if os.environ.get(env_name):
        candidates.append(Path(os.environ[env_name]).expanduser())
    if env_dir:
        candidates.append(Path(env_dir).expanduser() / f"{name}.exe")
        candidates.append(Path(env_dir).expanduser() / name)

    found = shutil.which(name)
    if found:
        candidates.append(found)

    if os.name == "nt":
        candidates.extend(
            [
                Path(r"C:\ffmpeg\bin") / f"{name}.exe",
                Path(r"C:\Program Files\ffmpeg\bin") / f"{name}.exe",
                Path(r"C:\Program Files (x86)\ffmpeg\bin") / f"{name}.exe",
            ]
        )

    for candidate in candidates:
        candidate_path = Path(candidate)
        if candidate_path.exists() and candidate_path.is_file():
            return str(candidate_path)
        if isinstance(candidate, str):
            found_candidate = shutil.which(candidate)
            if found_candidate:
                return found_candidate

    install_hint = (
        "Install ffmpeg, then either add its bin folder to PATH or pass "
        f"`--{name} C:\\path\\to\\{name}.exe`. On Windows you can also set "
        "`FFMPEG_DIR=C:\\ffmpeg\\bin`."
    )
    raise RuntimeError(f"Missing required binary `{name}`. {install_hint}")


def configure_binaries(ffmpeg_path: str | None, ffprobe_path: str | None) -> None:
    global FFMPEG_BIN, FFPROBE_BIN
    FFMPEG_BIN = resolve_binary("ffmpeg", ffmpeg_path)
    FFPROBE_BIN = resolve_binary("ffprobe", ffprobe_path)


def sanitize_filename(value: str, max_len: int = 60) -> str:
    value = re.sub(r'[\\/*?:"<>|]', "", value)
    value = re.sub(r"\s+", "_", value.strip().lower())
    value = re.sub(r"[^a-z0-9._-]+", "", value)
    return (value[:max_len].strip("._-") or "clip")


def is_youtube_url(value: str) -> bool:
    return bool(re.match(r"^https?://(www\.)?(youtube\.com|youtu\.be)/", value, re.I))


def format_time(seconds: float) -> str:
    seconds = max(0, seconds)
    mins = int(seconds // 60)
    secs = seconds - mins * 60
    return f"{mins:02d}:{secs:05.2f}"


def download_youtube(url: str, downloads_dir: Path) -> Path:
    try:
        import yt_dlp
    except ImportError as exc:
        raise RuntimeError("Missing yt-dlp. Run `python -m pip install -r requirements.txt`.") from exc

    downloads_dir.mkdir(parents=True, exist_ok=True)
    ydl_opts = {
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
        "merge_output_format": "mp4",
        "outtmpl": str(downloads_dir / "%(title).180s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = Path(ydl.prepare_filename(info)).with_suffix(".mp4")
    except Exception as exc:
        raise RuntimeError(f"Could not download YouTube URL: {exc}") from exc

    if not path.exists():
        raise RuntimeError("yt-dlp finished but the MP4 file was not found.")
    return path


def resolve_input(source: str, output_dir: Path) -> Path:
    if is_youtube_url(source):
        console.print("[cyan]Downloading YouTube video with yt-dlp...[/cyan]")
        return download_youtube(source, output_dir / "downloads")

    path = Path(source).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Input file not found: {path}")
    if path.suffix.lower() != ".mp4":
        console.print("[yellow]Input is not .mp4; ffmpeg will still try to process it.[/yellow]")
    return path


def transcribe(
    video_path: Path,
    language: str,
    whisper_model: str,
    device: str,
    compute_type: str,
) -> list[Segment]:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "Missing faster-whisper. Run `python -m pip install -r requirements.txt`."
        ) from exc

    try:
        model = WhisperModel(whisper_model, device=device, compute_type=compute_type)
    except Exception as exc:
        message = str(exc).lower()
        cuda_error = "cublas" in message or "cuda" in message or "cudnn" in message
        if device != "cpu" and cuda_error:
            console.print(
                "[yellow]CUDA libraries were not found. Falling back to CPU/int8 transcription.[/yellow]"
            )
            model = WhisperModel(whisper_model, device="cpu", compute_type="int8")
        else:
            raise
    raw_segments, _info = model.transcribe(
        str(video_path),
        language=language or None,
        vad_filter=True,
        word_timestamps=True,
    )

    segments: list[Segment] = []
    for seg in raw_segments:
        words: list[Word] = []
        for word in seg.words or []:
            clean = word.word.strip()
            if clean:
                words.append(Word(float(word.start), float(word.end), clean))
        text = (seg.text or " ".join(w.text for w in words)).strip()
        if text:
            segments.append(Segment(float(seg.start), float(seg.end), text, words))
    if not segments:
        raise RuntimeError("No speech was detected in the video.")
    return segments


def group_segments(
    segments: list[Segment],
    min_duration: int,
    max_duration: int,
    context_padding: int,
) -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []
    flexible_max = max_duration + context_padding
    stride = max(1, len(segments) // 700)
    for start_idx, start_segment in enumerate(segments):
        if start_idx % stride != 0:
            continue
        context_start_idx = find_context_start(segments, start_idx, context_padding)
        context_start_segment = segments[context_start_idx]
        text_parts: list[str] = []
        best_window: dict[str, Any] | None = None
        for seg in segments[context_start_idx:]:
            duration = seg.end - context_start_segment.start
            if duration > flexible_max and duration >= min_duration:
                break
            text_parts.append(seg.text)
            text = " ".join(text_parts)
            if duration >= min_duration:
                candidate = {
                    "start_time": context_start_segment.start,
                    "end_time": seg.end,
                    "duration": duration,
                    "text": text,
                    "complete_score": completeness_score(text, duration, seg),
                }
                if (
                    best_window is None
                    or candidate["complete_score"] > best_window["complete_score"]
                    or duration >= flexible_max * 0.92
                ):
                    best_window = candidate
                if is_natural_ending(seg.text) and duration >= min_duration:
                    windows.append(candidate)
            if duration >= flexible_max:
                break
        if best_window:
            windows.append(best_window)
    return dedupe_windows(windows)


def find_context_start(segments: list[Segment], start_idx: int, context_padding: int) -> int:
    idx = start_idx
    start = segments[start_idx].start
    while idx > 0:
        previous = segments[idx - 1]
        current = segments[idx]
        gap = current.start - previous.end
        if gap > 2.5 or start - previous.start > context_padding:
            break
        if idx == start_idx and not starts_like_continuation(current.text):
            break
        idx -= 1
    return idx


def starts_like_continuation(text: str) -> bool:
    lower = text.lower().strip()
    markers = (
        "e ", "mas ", "só que", "so que", "porque", "por isso", "então",
        "entao", "aí", "ai", "daí", "dai", "isso", "essa", "esse", "ele",
        "ela", "eles", "elas", "também", "tambem", "inclusive",
    )
    return any(lower.startswith(marker) for marker in markers)


def is_natural_ending(text: str) -> bool:
    text = text.strip()
    if not text:
        return False
    lower = text.lower()
    ending_markers = (
        ".", "!", "?", "...",
        "né", "entendeu", "sabe", "certo", "beleza", "fim",
        "portanto", "então", "por isso", "ou seja", "em resumo",
    )
    return text.endswith((".", "!", "?")) or any(lower.endswith(marker) for marker in ending_markers)


def has_beginning_marker(text: str) -> bool:
    lower = text.lower().strip()
    markers = (
        "olha", "então", "assim", "primeiro", "a questão", "o ponto", "o problema",
        "a pergunta", "eu acho", "na verdade", "por exemplo", "cara",
    )
    return any(lower.startswith(marker) for marker in markers)


def completeness_score(text: str, duration: float, last_segment: Segment) -> float:
    lower = text.lower()
    score = 0.0
    if has_beginning_marker(text):
        score += 10
    if is_natural_ending(last_segment.text):
        score += 18
    if 30 <= duration <= 85:
        score += 12
    if 85 < duration <= 140:
        score += 8
    if "?" in text and any(marker in lower for marker in ("eu acho", "porque", "a questão", "o ponto", "na verdade", "olha")):
        score += 14
    if any(marker in lower for marker in ("porque", "por isso", "então", "ou seja", "mas", "só que")):
        score += 12
    if any(marker in lower for marker in ("por exemplo", "um exemplo", "quer dizer", "isso significa", "a resposta")):
        score += 8
    if any(marker in lower for marker in ("pt", "partido", "governo", "lula", "bolsonaro", "direita", "esquerda", "política", "congresso", "estado")):
        score += 8
    if lower.count(" que ") > 18 and duration < 35:
        score -= 8
    return score


def dedupe_windows(windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[int, int]] = set()
    unique: list[dict[str, Any]] = []
    for win in windows:
        key = (round(win["start_time"]), round(win["end_time"]))
        if key not in seen:
            unique.append(win)
            seen.add(key)
    return unique


def quick_window_score(win: dict[str, Any]) -> float:
    text = win["text"]
    normalized = normalize_text(text)
    words = re.findall(r"\w+", normalized)
    word_count = len(words)
    duration = max(1.0, float(win["duration"]))
    hook_words = {
        "why", "how", "secret", "never", "always", "best", "worst", "crazy",
        "surprising", "important", "urgent", "truth", "problem", "question",
        "porque", "como", "segredo", "nunca", "sempre", "melhor", "pior",
        "incrivel", "importante", "urgente", "verdade", "problema", "pergunta",
    }
    political_words = {
        "politica", "partido", "governo", "estado", "congresso", "eleicao",
        "lula", "bolsonaro", "pt", "direita", "esquerda", "classe", "povo",
        "democracia", "capital", "poder", "ministro", "racismo", "cotas",
        "genero", "escola", "crianca", "educacao",
    }
    conflict_words = {
        "discordo", "concordo", "mentira", "errado", "calar", "debate",
        "racista", "preconceito", "fraude", "problema", "absurdo", "nao",
    }
    specificity_words = {
        "estudo", "cientifico", "dados", "casos", "mil", "milhao", "lei",
        "tribunal", "justica", "deputado", "escola", "universidade",
    }

    duration_score = max(0, 14 - abs(duration - 75) / 7)
    density_score = min(10, word_count / duration * 3.2)
    hook_score = min(10, sum(1 for word in words if word in hook_words) * 2)
    politics_score = min(12, sum(1 for word in words if word in political_words) * 1.6)
    conflict_score = min(12, sum(1 for word in words if word in conflict_words) * 1.5)
    specificity_score = min(12, sum(1 for word in words if word in specificity_words) * 1.7)
    structure_score = min(18, float(win.get("complete_score", 0)) * 0.45)
    question_score = 7 if "?" in text else 0
    repetition_penalty = min(8, max(0, word_count - len(set(words)) * 2) / 12)
    filler_penalty = min(8, sum(1 for word in words if word in {"tipo", "cara", "ne", "assim"}) * 0.8)

    score = (
        34
        + duration_score
        + density_score
        + hook_score
        + politics_score
        + conflict_score
        + specificity_score
        + structure_score
        + question_score
        - repetition_penalty
        - filler_penalty
    )
    return max(35, min(96, score))


def make_clip_title(text: str) -> str:
    normalized = normalize_text(text)
    topic_title = title_from_known_topic(normalized)
    if topic_title:
        return topic_title

    question = extract_question_title(text)
    if question:
        return question

    claim = extract_claim_title(text)
    if claim:
        return claim

    return title_from_keywords(normalized)


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text.lower())
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", normalized).strip()


def title_from_known_topic(normalized: str) -> str | None:
    topic_rules = [
        (("ideologia de genero", "escola"), "Ideologia de gênero nas escolas"),
        (("ideologia de genero",), "Ideologia de gênero existe?"),
        (("abuso sexual", "crianca"), "Educação sexual protege crianças?"),
        (("hiv", "escola"), "Escola deve falar sobre HIV?"),
        (("cotas", "racismo"), "Cotas raciais e racismo"),
        (("cotas",), "O debate das cotas raciais"),
        (("sistema educacao",), "O sistema educacional falhou?"),
        (("magistratura",), "Privilégios da magistratura"),
        (("tribunal", "justica"), "Privilégios no Tribunal de Justiça"),
        (("nazista",), "Nazismo e liberdade de expressão"),
        (("fascista",), "Fascismo no debate político"),
        (("burgues", "empresario"), "A esquerda contra os empresários?"),
        (("direita", "esquerda"), "Direita e esquerda no confronto"),
        (("saude", "educacao"), "Saúde e educação em disputa"),
    ]
    for needles, title in topic_rules:
        if all(needle in normalized for needle in needles):
            return title
    return None


def extract_question_title(text: str) -> str | None:
    chunks = re.split(r"(?<=[?])\s+", text)
    for chunk in chunks:
        if "?" not in chunk:
            continue
        clean = clean_title_text(chunk)
        words = clean.split()
        if 4 <= len(words) <= 12:
            return clean[:1].upper() + clean[1:]
    return None


def extract_claim_title(text: str) -> str | None:
    markers = (
        "o problema é", "a questão é", "o ponto é", "na verdade", "eu acho que",
        "isso é", "isso significa", "a gente tem", "não existe", "existe sim",
    )
    lower = text.lower()
    for marker in markers:
        idx = lower.find(marker)
        if idx == -1:
            continue
        snippet = text[idx : idx + 95]
        clean = clean_title_text(snippet)
        words = clean.split()
        if len(words) >= 4:
            return " ".join(words[:10]).rstrip(",.;:")
    return None


def title_from_keywords(normalized: str) -> str:
    stopwords = {
        "a", "o", "os", "as", "um", "uma", "de", "da", "do", "das", "dos",
        "que", "e", "em", "no", "na", "nos", "nas", "pra", "para", "por",
        "com", "se", "eu", "voce", "ele", "ela", "isso", "essa", "esse",
        "ne", "entao", "assim", "cara", "tipo", "tambem", "gente", "vou",
        "pode", "sobre", "onde", "estava", "falando",
    }
    words = re.findall(r"\w+", normalized)
    keywords: list[str] = []
    for word in words:
        if len(word) < 3 or word in stopwords:
            continue
        if word not in keywords:
            keywords.append(word)
        if len(keywords) == 6:
            break
    if not keywords:
        return "Momento forte do debate"
    return " ".join(keywords).capitalize()


def clean_title_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip(" ,.;:-")
    text = re.sub(r"\b(né|tipo|assim|cara|gente)\b", "", text, flags=re.I)
    text = re.sub(r"\s+", " ", text).strip(" ,.;:-")
    words = text.split()
    return " ".join(words[:12]).rstrip(",.;:")


def preselect_windows_for_ollama(
    windows: list[dict[str, Any]],
    max_windows: int = 120,
) -> list[dict[str, Any]]:
    if len(windows) <= max_windows:
        return windows

    scored = sorted(
        ((quick_window_score(win), idx, win) for idx, win in enumerate(windows)),
        key=lambda item: item[0],
        reverse=True,
    )
    top_count = int(max_windows * 0.7)
    top_by_score = [item[2] for item in scored[:top_count]]

    duration = max(win["end_time"] for win in windows)
    bucket_count = max_windows - len(top_by_score)
    bucketed: list[dict[str, Any]] = []
    for bucket in range(bucket_count):
        start = duration * bucket / bucket_count
        end = duration * (bucket + 1) / bucket_count
        bucket_windows = [win for win in windows if start <= win["start_time"] < end]
        if bucket_windows:
            bucketed.append(max(bucket_windows, key=quick_window_score))

    selected: dict[tuple[int, int], dict[str, Any]] = {}
    for win in top_by_score + bucketed:
        selected[(round(win["start_time"]), round(win["end_time"]))] = win
        if len(selected) >= max_windows:
            break

    return sorted(selected.values(), key=lambda win: win["start_time"])


def ollama_generate(
    model: str,
    prompt: str,
    timeout: int = 240,
    num_ctx: int = 8192,
) -> str:
    payload = json.dumps(
        {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": 0.2,
                "top_p": 0.85,
                "num_ctx": num_ctx,
            },
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data.get("response", "")


def build_scoring_prompt(
    windows: list[dict[str, Any]],
    language: str,
    clip_count: int,
) -> str:
    compact = [
        {
            "id": idx,
            "start_time": round(win["start_time"], 2),
            "end_time": round(win["end_time"], 2),
            "duration": round(win["duration"], 2),
            "text": win["text"][:1400],
        }
        for idx, win in enumerate(windows)
    ]
    params = "\n".join(f"- {item}" for item in VIRAL_PARAMETERS)
    clip_instruction = (
        "Pick every strong non-overlapping clip you can find"
        if clip_count == 0
        else f"Pick the top {clip_count}"
    )
    return textwrap.dedent(
        f"""
        You are selecting viral short-form clips from a transcript.
        Language hint: {language}
        The source is often political commentary or interviews in Portuguese.

        Score each candidate from 0 to 100 using these 18 parameters:
        {params}

        Extra rules for political clips:
        - Prefer complete arguments, not isolated phrases.
        - A good clip should include the political context, the speaker's thesis,
          at least one reason/example, and a clear conclusion or punchline.
        - Penalize cuts that end before the speaker finishes explaining the point.
        - Penalize clips that start after the context has already been established.
        - Favor moments with a clear claim about parties, government, ideology,
          elections, public policy, conflict, contradiction, or power.
        - Keep timestamps inside the candidate, but choose the broadest useful
          span when the whole argument fits under the max duration.

        Return only valid JSON with this exact shape:
        {{
          "clips": [
            {{
              "id": 0,
              "start_time": 12.3,
              "end_time": 52.1,
              "score": 91,
              "title": "editorial title with conflict or thesis",
              "reason": "brief reason"
            }}
          ]
        }}

        {clip_instruction}. Prefer complete moments with a hook, payoff, and no
        abrupt mid-sentence ending. Do not invent timestamps outside candidates.
        Titles must be natural Portuguese titles, not raw keywords. Use 4 to 9
        words, name the central conflict or claim, and avoid filler words like
        "gente", "cara", "assim", "né", "posso seguir", or "estava falando".

        Candidates:
        {json.dumps(compact, ensure_ascii=False)}
        """
    ).strip()


def build_debate_map_prompt(
    windows: list[dict[str, Any]],
    language: str,
    clip_count: int,
    min_duration: int,
    max_duration: int,
) -> str:
    compact = [
        {
            "id": idx,
            "start_time": round(win["start_time"], 2),
            "end_time": round(win["end_time"], 2),
            "duration": round(win["duration"], 2),
            "text": win["text"][:2200],
        }
        for idx, win in enumerate(windows)
    ]
    clip_instruction = (
        "Return every strong argument block you find"
        if clip_count == 0
        else f"Return the best {clip_count} argument blocks"
    )
    return textwrap.dedent(
        f"""
        You are an expert short-form editor for Brazilian political podcasts,
        debates, and confrontational interviews.

        Language: {language}
        Desired clip duration: {min_duration} to {max_duration} seconds, but a
        complete argument is more important than exact duration.

        Your first job is NOT to pick random viral phrases. Your job is to map
        complete debate units:
        - setup/context
        - question or accusation
        - thesis/answer
        - reason, evidence, example, or confrontation
        - conclusion, punchline, reversal, or clean handoff

        Penalize:
        - clips that start in the middle of a thought
        - clips that end before the answer or argument lands
        - titles that are just raw transcript words
        - generic tension with no clear political topic

        Favor:
        - ideological conflict
        - accusation + reply
        - clear disagreement
        - concrete examples, numbers, laws, institutions, parties, government,
          class, labor, taxes, education, public policy, or moral contradiction
        - a viewer who can understand the clip without watching the previous minute

        Return only valid JSON with this exact shape:
        {{
          "arguments": [
            {{
              "id": 0,
              "start_time": 123.4,
              "end_time": 245.6,
              "topic": "central political topic",
              "question_or_accusation": "what starts the argument",
              "thesis": "main answer or claim",
              "counterpoint": "opposition or conflict",
              "resolution": "how the moment lands",
              "score": 87,
              "title": "4-9 word Portuguese editorial title",
              "reason": "why this is a strong complete clip"
            }}
          ]
        }}

        {clip_instruction}. Use the candidate id, keep timestamps inside that
        candidate, and prefer the broadest useful span when the whole argument
        fits. Titles must be natural Portuguese titles with a claim or conflict.

        Candidates:
        {json.dumps(compact, ensure_ascii=False)}
        """
    ).strip()


def parse_debate_arguments(
    raw: str,
    windows: list[dict[str, Any]],
    clip_count: int,
) -> tuple[list[ClipCandidate], list[dict[str, Any]]]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.S)
        if not match:
            raise
        data = json.loads(match.group(0))

    by_id = {idx: win for idx, win in enumerate(windows)}
    clips: list[ClipCandidate] = []
    arguments: list[dict[str, Any]] = []
    for item in data.get("arguments", []):
        try:
            win = by_id.get(int(item.get("id", -1)))
        except (TypeError, ValueError):
            win = None
        if win is None:
            continue

        start = float(item.get("start_time", win["start_time"]))
        end = float(item.get("end_time", win["end_time"]))
        start = max(win["start_time"], min(start, win["end_time"]))
        end = max(start + 8, min(end, win["end_time"]))
        title = clean_title_text(str(item.get("title") or make_clip_title(win["text"])))
        reason = str(item.get("reason") or "argumento completo de debate")
        score = max(0, min(100, int(item.get("score", quick_window_score(win)))))

        arguments.append(
            {
                "id": item.get("id"),
                "start_time": round(start, 2),
                "end_time": round(end, 2),
                "score": score,
                "title": title,
                "topic": item.get("topic", ""),
                "question_or_accusation": item.get("question_or_accusation", ""),
                "thesis": item.get("thesis", ""),
                "counterpoint": item.get("counterpoint", ""),
                "resolution": item.get("resolution", ""),
                "reason": reason,
            }
        )
        clips.append(ClipCandidate(start, end, score, title, reason))

    return select_non_overlapping(clips, limit=clip_count), arguments


def parse_ollama_clips(
    raw: str,
    windows: list[dict[str, Any]],
    clip_count: int,
) -> list[ClipCandidate]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.S)
        if not match:
            raise
        data = json.loads(match.group(0))

    by_id = {idx: win for idx, win in enumerate(windows)}
    clips: list[ClipCandidate] = []
    for item in data.get("clips", []):
        try:
            win = by_id.get(int(item.get("id", -1)))
        except (TypeError, ValueError):
            win = None
        if win is None:
            continue
        start = float(item.get("start_time", win["start_time"] if win else 0))
        end = float(item.get("end_time", win["end_time"] if win else start + 20))
        start = max(win["start_time"], min(start, win["end_time"]))
        end = max(start + 5, min(end, win["end_time"]))
        clips.append(
            ClipCandidate(
                start_time=start,
                end_time=end,
                score=max(0, min(100, int(item.get("score", 0)))),
                title=str(item.get("title") or "viral moment"),
                reason=str(item.get("reason") or ""),
            )
        )
    return select_non_overlapping(clips, limit=clip_count)


def heuristic_score_windows(windows: list[dict[str, Any]], clip_count: int) -> list[ClipCandidate]:
    scored: list[ClipCandidate] = []
    for win in windows:
        text = win["text"]
        score = int(min(100, quick_window_score(win)))
        title = make_clip_title(text)
        scored.append(
            ClipCandidate(win["start_time"], win["end_time"], score, title, build_score_reason(win))
        )
    return select_non_overlapping(sorted(scored, key=lambda c: c.score, reverse=True), limit=clip_count)


def build_score_reason(win: dict[str, Any]) -> str:
    normalized = normalize_text(win["text"])
    reasons: list[str] = []
    if "?" in win["text"]:
        reasons.append("pergunta/resposta")
    if any(word in normalized for word in ("racismo", "cotas", "genero", "escola", "governo", "direita", "esquerda")):
        reasons.append("tema politico claro")
    if any(word in normalized for word in ("discordo", "concordo", "errado", "problema", "calar", "absurdo")):
        reasons.append("conflito de debate")
    if any(word in normalized for word in ("dados", "casos", "estudo", "cientifico", "mil", "lei")):
        reasons.append("exemplo ou dado concreto")
    if float(win.get("complete_score", 0)) >= 30:
        reasons.append("argumento mais completo")
    return ", ".join(reasons) or "momento com densidade de fala"


def select_non_overlapping(clips: list[ClipCandidate], limit: int) -> list[ClipCandidate]:
    selected: list[ClipCandidate] = []
    for clip in sorted(clips, key=lambda c: c.score, reverse=True):
        if clip.end_time <= clip.start_time:
            continue
        overlaps = any(
            max(clip.start_time, kept.start_time) < min(clip.end_time, kept.end_time)
            for kept in selected
        )
        if not overlaps:
            selected.append(clip)
        if limit > 0 and len(selected) == limit:
            break
    return sorted(selected, key=lambda c: c.start_time)


def score_clips(
    segments: list[Segment],
    language: str,
    min_duration: int,
    max_duration: int,
    context_padding: int,
    skip_start: int,
    model: str,
    clip_count: int,
    analysis_mode: str,
    ollama_context: int,
    ollama_timeout: int,
    output_dir: Path,
) -> list[ClipCandidate]:
    if skip_start > 0:
        segments = [segment for segment in segments if segment.end >= skip_start]
        if not segments:
            raise RuntimeError("No transcript segments remain after --skip-start.")

    windows = group_segments(segments, min_duration, max_duration, context_padding)
    if not windows:
        raise RuntimeError("Could not form clip candidates from transcript.")

    ollama_windows = preselect_windows_for_ollama(
        windows,
        max_windows=90 if analysis_mode == "debate" else 120,
    )
    prompt = (
        build_debate_map_prompt(ollama_windows, language, clip_count, min_duration, max_duration)
        if analysis_mode == "debate"
        else build_scoring_prompt(ollama_windows, language, clip_count)
    )
    try:
        raw = ollama_generate(model, prompt, timeout=ollama_timeout, num_ctx=ollama_context)
        if analysis_mode == "debate":
            clips, argument_map = parse_debate_arguments(raw, ollama_windows, clip_count)
            write_argument_map(argument_map, output_dir)
        else:
            clips = parse_ollama_clips(raw, ollama_windows, clip_count)
        target_count = clip_count if clip_count > 0 else min(12, len(windows))
        if clips and len(clips) >= min(target_count, len(windows)):
            return clips
        if clips:
            console.print(
                f"[yellow]Ollama returned only {len(clips)} usable clip(s). Completing with local heuristic fallback.[/yellow]"
            )
            fallback = heuristic_score_windows(windows, clip_count)
            merged = select_non_overlapping(clips + fallback, limit=clip_count)
            if merged:
                return merged
        raise RuntimeError("Ollama returned no usable clips.")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError, ValueError) as exc:
        console.print(
            f"[yellow]Ollama scoring unavailable or invalid ({exc}). Using local heuristic fallback.[/yellow]"
        )
        return heuristic_score_windows(windows, clip_count)


def ffprobe_json(path: Path) -> dict[str, Any]:
    result = run(
        [
            FFPROBE_BIN,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(path),
        ]
    )
    if not result.stdout:
        raise RuntimeError(f"ffprobe returned no metadata for {path}. stderr: {result.stderr}")
    return json.loads(result.stdout)


def get_video_size(path: Path) -> tuple[int, int]:
    data = ffprobe_json(path)
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            return int(stream["width"]), int(stream["height"])
    raise RuntimeError("No video stream found.")


def detect_face_crop_x(video_path: Path, start: float, end: float, width: int, crop_w: int) -> int | None:
    try:
        import cv2
    except ImportError:
        return None

    model_path = Path(__file__).with_name("face_detection_yunet_2023mar.onnx")
    use_yunet = model_path.exists() and hasattr(cv2, "FaceDetectorYN")
    detector = None
    cascade = None

    if use_yunet:
        try:
            detector = cv2.FaceDetectorYN.create(str(model_path), "", (320, 320), 0.75, 0.3, 5000)
        except Exception:
            detector = None

    if detector is None:
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return None

    centers: list[tuple[float, float]] = []
    for t in sample_times(start, end, count=12):
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        h_orig, w_orig = frame.shape[:2]
        if detector is not None:
            resized = cv2.resize(frame, (320, 320))
            detector.setInputSize((320, 320))
            _retval, faces = detector.detect(resized)
            if faces is not None:
                for face in faces:
                    x, _y, w, h = face[:4]
                    centers.append(((x + w / 2) * w_orig / 320, w * h))
        else:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            for x, _y, w, h in cascade.detectMultiScale(gray, 1.1, 4):
                centers.append((x + w / 2, w * h))
    cap.release()

    if not centers:
        return None
    weighted = sum(center * area for center, area in centers) / sum(area for _center, area in centers)
    return int(max(0, min(width - crop_w, weighted - crop_w / 2)))


def sample_times(start: float, end: float, count: int) -> Iterable[float]:
    if end <= start:
        return []
    step = (end - start) / max(1, count)
    return (start + step * (idx + 0.5) for idx in range(count))


def ass_time(seconds: float) -> str:
    seconds = max(0, seconds)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours}:{minutes:02d}:{secs:05.2f}"


def ass_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", r"\{").replace("}", r"\}")


def words_for_clip(segments: list[Segment], clip: ClipCandidate) -> list[Word]:
    selected: list[Word] = []
    for seg in segments:
        if seg.end < clip.start_time or seg.start > clip.end_time:
            continue
        for word in seg.words:
            if clip.start_time <= word.start <= clip.end_time:
                selected.append(
                    Word(
                        start=max(0, word.start - clip.start_time),
                        end=max(0.05, min(word.end, clip.end_time) - clip.start_time),
                        text=word.text,
                    )
                )
    return selected


def write_ass_subtitles(words: list[Word], ass_path: Path, width: int = 1080, height: int = 1920) -> None:
    header = textwrap.dedent(
        f"""
        [Script Info]
        ScriptType: v4.00+
        PlayResX: {width}
        PlayResY: {height}
        WrapStyle: 2
        ScaledBorderAndShadow: yes

        [V4+ Styles]
        Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
        Style: Default,Arial,82,&H00FFFFFF,&H0000FFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,7,0,2,70,70,210,1

        [Events]
        Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
        """
    ).strip()

    lines = [header]
    for idx in range(0, len(words), 2):
        pair = words[idx : idx + 2]
        if not pair:
            continue
        for active_index, active_word in enumerate(pair):
            text_parts = []
            for word_index, word in enumerate(pair):
                color = r"{\c&H00FFFF&}" if word_index == active_index else r"{\c&HFFFFFF&}"
                text_parts.append(color + ass_escape(word.text))
            text = r"{\an2}" + " ".join(text_parts)
            lines.append(
                f"Dialogue: 0,{ass_time(active_word.start)},{ass_time(active_word.end)},Default,,0,0,0,,{text}"
            )
    ass_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def ffmpeg_ass_path(path: Path) -> str:
    resolved = path.resolve().as_posix()
    if re.match(r"^[A-Za-z]:/", resolved):
        resolved = resolved[0] + r"\:" + resolved[2:]
    return resolved.replace("'", r"\'")


def build_vertical_filter(input_path: Path, clip: ClipCandidate, face_crop: bool) -> str:
    width, height = get_video_size(input_path)
    target_ratio = 9 / 16
    source_ratio = width / height
    crop_x = 0
    crop_y = 0

    if source_ratio > target_ratio:
        crop_h = height
        crop_w = int(height * target_ratio)
        if face_crop:
            crop_x = detect_face_crop_x(input_path, clip.start_time, clip.end_time, width, crop_w)
        if crop_x is None:
            crop_x = max(0, int((width - crop_w) / 2))
    else:
        crop_w = width
        crop_h = int(width / target_ratio)
        crop_y = max(0, int((height - crop_h) / 2))

    return f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y},scale=1080:1920:flags=lanczos"


def render_clip(
    input_path: Path,
    output_path: Path,
    ass_path: Path,
    clip: ClipCandidate,
    face_crop: bool,
) -> None:
    video_filter = build_vertical_filter(input_path, clip, face_crop)
    video_filter = f"{video_filter},ass='{ffmpeg_ass_path(ass_path)}'"
    duration = clip.end_time - clip.start_time
    command = [
        FFMPEG_BIN,
        "-y",
        "-ss",
        f"{clip.start_time:.3f}",
        "-i",
        str(input_path),
        "-t",
        f"{duration:.3f}",
        "-vf",
        video_filter,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    try:
        run(command)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"ffmpeg failed for {output_path.name}:\n{exc.stderr}") from exc


def write_clips_json(clips: list[ClipCandidate], output_dir: Path) -> None:
    payload = {
        "clips": [
            {
                "start_time": round(clip.start_time, 2),
                "end_time": round(clip.end_time, 2),
                "score": clip.score,
                "title": clip.title,
                "reason": clip.reason,
            }
            for clip in clips
        ]
    }
    (output_dir / "clips.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def write_argument_map(argument_map: list[dict[str, Any]], output_dir: Path) -> None:
    if not argument_map:
        return
    (output_dir / "argument_map.json").write_text(
        json.dumps({"arguments": argument_map}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def write_transcript_files(segments: list[Segment], output_dir: Path) -> None:
    transcript_json = {
        "segments": [
            {
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": segment.text,
            }
            for segment in segments
        ]
    }
    (output_dir / "transcript.json").write_text(
        json.dumps(transcript_json, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    lines = [
        f"[{format_time(segment.start)} - {format_time(segment.end)}] {segment.text}"
        for segment in segments
    ]
    (output_dir / "transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def make_video_output_dir(base_output_dir: Path, input_path: Path) -> Path:
    folder_name = sanitize_filename(input_path.stem, max_len=100)
    output_dir = base_output_dir / folder_name
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def print_summary(clips: list[ClipCandidate], output_paths: list[Path]) -> None:
    table = Table(title="Top viral clips")
    table.add_column("#", justify="right")
    table.add_column("Time range")
    table.add_column("Score", justify="right")
    table.add_column("Title")
    table.add_column("File")
    for idx, (clip, path) in enumerate(zip(clips, output_paths), 1):
        table.add_row(
            str(idx),
            f"{format_time(clip.start_time)} - {format_time(clip.end_time)}",
            str(clip.score),
            clip.title,
            str(path),
        )
    console.print(table)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate local viral clips with burned-in karaoke subtitles."
    )
    parser.add_argument("input", help="Local MP4 path or YouTube URL.")
    parser.add_argument("--output", "-o", default="output", help="Output folder. Default: ./output")
    parser.add_argument("--language", "-l", default="pt", help="Transcription language, e.g. pt, en, es.")
    parser.add_argument("--clip-count", type=int, default=5, help="Number of clips to generate. Use 0 for no fixed limit. Default: 5")
    parser.add_argument("--max-duration", type=int, default=60, help="Maximum clip duration in seconds.")
    parser.add_argument("--min-duration", type=int, default=20, help="Minimum clip duration in seconds.")
    parser.add_argument("--context-padding", type=int, default=18, help="Extra seconds allowed to recover context and finish arguments. Default: 18")
    parser.add_argument("--skip-start", type=int, default=0, help="Ignore transcript before this timestamp in seconds. Useful to skip intros.")
    parser.add_argument("--model", default="qwen3:14b", help="Ollama model name. Default: qwen3:14b")
    parser.add_argument("--analysis-mode", default="debate", choices=["debate", "score"], help="LLM analysis strategy. Default: debate")
    parser.add_argument("--ollama-context", type=int, default=8192, help="Ollama num_ctx option. Use 16384+ for stronger local models.")
    parser.add_argument("--ollama-timeout", type=int, default=300, help="Ollama request timeout in seconds. Default: 300")
    parser.add_argument("--whisper-model", default="small", help="faster-whisper model. Default: small")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "auto"], help="faster-whisper device. Default: cpu")
    parser.add_argument("--compute-type", default="int8", help="faster-whisper compute type. Default: int8")
    parser.add_argument("--no-face-crop", action="store_true", help="Disable OpenCV face-aware crop.")
    parser.add_argument("--ffmpeg", help="Path to ffmpeg executable if it is not in PATH.")
    parser.add_argument("--ffprobe", help="Path to ffprobe executable if it is not in PATH.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    start_time = time.time()
    base_output_dir = Path(args.output).resolve()
    base_output_dir.mkdir(parents=True, exist_ok=True)

    if args.min_duration <= 0 or args.max_duration <= 0 or args.min_duration > args.max_duration:
        console.print("[red]Invalid duration settings: min must be positive and <= max.[/red]")
        return 2
    if args.clip_count < 0:
        console.print("[red]Invalid clip count: it must be zero or positive.[/red]")
        return 2
    if args.context_padding < 0:
        console.print("[red]Invalid context padding: it must be zero or positive.[/red]")
        return 2
    if args.skip_start < 0:
        console.print("[red]Invalid skip start: it must be zero or positive.[/red]")
        return 2
    if args.ollama_context < 2048:
        console.print("[red]Invalid Ollama context: use at least 2048.[/red]")
        return 2

    try:
        configure_binaries(args.ffmpeg, args.ffprobe)
        input_path = resolve_input(args.input, base_output_dir)
        output_dir = make_video_output_dir(base_output_dir, input_path)

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
            transient=True,
        ) as progress:
            progress.add_task("Transcribing locally with faster-whisper...", total=None)
            segments = transcribe(
                input_path,
                args.language,
                args.whisper_model,
                args.device,
                args.compute_type,
            )

        console.print(f"[green]Transcribed {len(segments)} segments.[/green]")
        write_transcript_files(segments, output_dir)
        clips = score_clips(
            segments,
            args.language,
            args.min_duration,
            args.max_duration,
            args.context_padding,
            args.skip_start,
            args.model,
            args.clip_count,
            args.analysis_mode,
            args.ollama_context,
            args.ollama_timeout,
            output_dir,
        )
        if not clips:
            raise RuntimeError("No clip candidates were selected.")

        write_clips_json(clips, output_dir)

        output_paths: list[Path] = []
        with tempfile.TemporaryDirectory(prefix="viral_clips_") as temp_dir_name:
            temp_dir = Path(temp_dir_name)
            for idx, clip in enumerate(clips, 1):
                title = sanitize_filename(clip.title)
                output_path = output_dir / f"clip_{idx:02d}_{title}.mp4"
                ass_path = temp_dir / f"clip_{idx:02d}.ass"
                words = words_for_clip(segments, clip)
                if not words:
                    words = [Word(0, max(1, clip.end_time - clip.start_time), clip.title)]
                write_ass_subtitles(words, ass_path)
                console.print(f"[cyan]Rendering clip {idx}/{len(clips)}: {clip.title}[/cyan]")
                render_clip(input_path, output_path, ass_path, clip, not args.no_face_crop)
                output_paths.append(output_path)

        print_summary(clips, output_paths)
        console.print(f"[green]Done in {time.time() - start_time:.1f}s. Output saved to {output_dir}[/green]")
        return 0
    except KeyboardInterrupt:
        console.print("\n[yellow]Cancelled.[/yellow]")
        return 130
    except Exception as exc:
        console.print(f"[red]Error:[/red] {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
