FROM python:3.12-slim
WORKDIR /app

# System deps for ffmpeg + build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Demucs (CPU build - slower but works without GPU)
# Comment out for lighter image; system gracefully skips when missing.
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir demucs \
    || echo "Demucs install skipped — vocal removal disabled"

COPY app ./app

ENV KTV_DATA_DIR=/data
VOLUME /data
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
