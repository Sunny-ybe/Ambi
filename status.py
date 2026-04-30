"""
ambi status — see what's in your brain

Usage:
    python3 status.py
"""

import os
import json

MEMORY_LOG = "./ambi_memory_log.jsonl"
DB_DIR     = "./ambi_db"

PURPLE  = "\033[94m"
GREEN   = "\033[92m"
RED     = "\033[91m"
YELLOW  = "\033[93m"
GRAY    = "\033[90m"
RESET   = "\033[0m"
BOLD    = "\033[1m"

def main():
    print(f"\n{BOLD}{PURPLE}ambi — status{RESET}")
    print(f"{GRAY}{'─' * 40}{RESET}")

    # vector db
    if os.path.exists(DB_DIR):
        size = sum(
            os.path.getsize(os.path.join(dp, f))
            for dp, _, files in os.walk(DB_DIR)
            for f in files
        )
        size_mb = round(size / (1024 * 1024), 2)
        print(f"{PURPLE}vector db:{RESET}     {GREEN}✓ exists ({size_mb} MB){RESET}")
    else:
        print(f"{PURPLE}vector db:{RESET}     {RED}✗ empty — nothing ingested yet{RESET}")

    # memory log
    if os.path.exists(MEMORY_LOG):
        with open(MEMORY_LOG) as f:
            lines = [l for l in f.readlines() if l.strip()]
        print(f"{PURPLE}conversations:{RESET} {GREEN}✓ {len(lines)} saved{RESET}")
        if lines:
            last = json.loads(lines[-1])
            q = last['question']
            preview = q[:60] + "..." if len(q) > 60 else q
            print(f"{PURPLE}last query:{RESET}    {GRAY}{last['timestamp'][:16]}{RESET}")
            print(f"               {GRAY}\"{preview}\"{RESET}")
    else:
        print(f"{PURPLE}conversations:{RESET} {GRAY}none yet{RESET}")

    # ollama
    print(f"\n{GRAY}checking ollama...{RESET}")
    ollama_ok = os.system("ollama list > /dev/null 2>&1") == 0
    if ollama_ok:
        print(f"{PURPLE}ollama:{RESET}        {GREEN}✓ running{RESET}")
    else:
        print(f"{PURPLE}ollama:{RESET}        {RED}✗ not running — start with: ollama serve{RESET}")
    print()

if __name__ == "__main__":
    main()
