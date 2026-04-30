"""
ambi ask — talk to your second brain

Usage:
    python3 ask.py                        # interactive mode (default)
    python3 ask.py "your question here"   # single question mode
"""

import sys
import os
import json
import datetime
from embedchain import App

MEMORY_LOG = "./ambi_memory_log.jsonl"

PURPLE  = "\033[94m"
GREEN   = "\033[92m"
RED     = "\033[91m"
YELLOW  = "\033[93m"
GRAY    = "\033[90m"
RESET   = "\033[0m"
BOLD    = "\033[1m"

def load_app():
    return App.from_config("config.yaml")

def save_to_log(question, answer):
    entry = {
        "timestamp": datetime.datetime.now().isoformat(),
        "question": question,
        "answer": answer
    }
    with open(MEMORY_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")

def ask(app, question):
    print(f"\n{GRAY}ambi — thinking...{RESET}\n")
    try:
        answer = app.chat(question)
        print(f"{BOLD}{PURPLE}ambi:{RESET} {PURPLE}{answer}{RESET}")

        save_to_log(question, answer)
        app.add(f"Q: {question}\nA: {answer}", data_type="text")

        print(f"\n{GREEN}✓ saved to memory{RESET}\n")
        return answer

    except Exception as e:
        print(f"{RED}✗ error: {e}{RESET}")
        return None

def interactive_mode(app):
    print(f"\n{BOLD}{PURPLE}ambi — ready{RESET}")
    print(f"{GRAY}type your question and press enter{RESET}")
    print(f"{GRAY}type 'quit' or press ctrl+c to exit{RESET}")
    print(f"{GRAY}{'─' * 40}{RESET}")

    while True:
        try:
            question = input(f"\nyou: ").strip()

            if not question:
                continue

            if question.lower() in ["quit", "exit", "q"]:
                print(f"\n{PURPLE}ambi — goodbye{RESET}\n")
                break

            ask(app, question)

        except KeyboardInterrupt:
            print(f"\n\n{PURPLE}ambi — goodbye{RESET}\n")
            break

def main():
    app = load_app()

    if len(sys.argv) > 1:
        question = " ".join(sys.argv[1:])
        ask(app, question)
    else:
        interactive_mode(app)

if __name__ == "__main__":
    main()
