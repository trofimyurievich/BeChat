"""Transcribe one voice note on the BeChat server. No network requests."""
import json
import subprocess
import sys
from vosk import KaldiRecognizer, Model, SetLogLevel


def transcribe():
    data = sys.stdin.buffer.read(8388609)
    if len(data) > 8388608:
        raise ValueError("size")
    formats = [(b"OggS", "ogg"), (bytes.fromhex("1a45dfa3"), "matroska"), (b"RIFF", "wav"), (b"ID3", "mp3")]
    fmt = next((value for magic, value in formats if data.startswith(magic)), None)
    if data[4:8] == b"ftyp":
        fmt = "mov"
    if not fmt:
        raise ValueError("audio format")
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-protocol_whitelist", "pipe",
                          "-f", fmt, "-i", "pipe:0", "-map", "0:a:0", "-vn", "-t", "600",
                          "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
                         input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=True).stdout
    SetLogLevel(-1)
    recognizer = KaldiRecognizer(Model("/opt/bechat-speech/ru"), 16000)
    parts = []
    for offset in range(0, len(pcm), 8000):
        if recognizer.AcceptWaveform(pcm[offset:offset+8000]):
            parts.append(json.loads(recognizer.Result())["text"])
    parts.append(json.loads(recognizer.FinalResult())["text"])
    print(json.dumps({"text": " ".join(filter(None, parts))}))


if __name__ == "__main__":
    transcribe()
