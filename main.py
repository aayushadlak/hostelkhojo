import os
import sys

# Ensure root directory and backend package directory are in python sys.path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(BASE_DIR, "backend")

if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

try:
    from backend.main import app
except ImportError:
    from main import app  # Fallback if executing directly inside backend

if __name__ == "__main__":
    import uvicorn
    # Safely parse PORT environment variable provided by Render or default to 10000
    raw_port = os.environ.get("PORT", "10000")
    try:
        port = int(raw_port)
    except ValueError:
        port = 10000

    print(f"Starting Hostel Khojo FastAPI server on 0.0.0.0:{port}...")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
