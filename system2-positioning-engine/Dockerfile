FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY system2/ system2/
COPY cameras.yaml .

CMD ["uvicorn", "system2.main:app", "--host", "0.0.0.0", "--port", "8000"]
