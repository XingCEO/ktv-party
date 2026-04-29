import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
API = os.path.normpath(os.path.join(HERE, "..", "api"))
os.chdir(API)
sys.path.insert(0, API)
import uvicorn
uvicorn.run("app.main:app", host="0.0.0.0", port=8000, log_level="info")
