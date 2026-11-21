FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    poppler-utils \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

RUN python -m pip install --upgrade pip setuptools wheel

RUN pip install --no-cache-dir -r requirements.txt

# Bake the small embedding model into the image. Render Free erases runtime
# cache files when it sleeps, so downloading this on every cold start would be
# slow and would create unnecessary outbound traffic.
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"


COPY . .

EXPOSE 2020

RUN mkdir -p data

CMD ["sh", "-c", "uvicorn MainApplicationRunner:app --host 0.0.0.0 --port ${PORT:-2020}"]
