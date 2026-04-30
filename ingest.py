"""
ambi ingest — add documents to your second brain

Usage:
    python3 ingest.py path/to/file.pdf
    python3 ingest.py path/to/folder/
    python3 ingest.py https://someurl.com/article
"""

import sys
import os
from embedchain import App

PURPLE  = "\033[94m"
GREEN   = "\033[92m"
RED     = "\033[91m"
YELLOW  = "\033[93m"
GRAY    = "\033[90m"
RESET   = "\033[0m"
BOLD    = "\033[1m"

def load_app():
    return App.from_config("config.yaml")

def ingest_source(app, source):
    try:
        app.add(source)
        print(f"  {GREEN}✓ added:{RESET} {source}")
    except Exception as e:
        print(f"  {RED}✗ error adding {source}: {e}{RESET}")

def ingest_folder(app, folder_path):
    count = 0
    for root, dirs, files in os.walk(folder_path):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for filename in files:
            if filename.startswith('.'):
                continue
            full_path = os.path.join(root, filename)
            ingest_source(app, full_path)
            count += 1
    print(f"\n  {GREEN}✓ done — processed {count} files{RESET}")

def main():
    if len(sys.argv) < 2:
        print(f"{YELLOW}usage: python3 ingest.py <file | folder | url>{RESET}")
        sys.exit(1)

    source = sys.argv[1]

    print(f"\n{BOLD}{PURPLE}ambi — ingesting:{RESET} {source}")
    print(f"{GRAY}{'─' * 40}{RESET}")

    app = load_app()

    if os.path.isdir(source):
        ingest_folder(app, source)
    else:
        ingest_source(app, source)

    print(f"\n{BOLD}{PURPLE}ambi — ingestion complete{RESET}")
    print(f"{GREEN}✓ your memory has been updated{RESET}\n")

if __name__ == "__main__":
    main()
