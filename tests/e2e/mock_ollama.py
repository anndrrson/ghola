#!/usr/bin/env python3
"""Minimal Ollama /api/generate mock for the e2e test.

Streams a fixed 3-chunk response so the provider has something to
seal back to the relay. We avoid pulling a real model — the test is
about transport + receipts, not about model output quality.
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (stdlib signature)
        if self.path != "/api/generate":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        _ = self.rfile.read(length)  # discard; mock ignores the prompt

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()

        for word in ["hello", " from", " the", " mock", " enclave."]:
            chunk = {"response": word, "done": False}
            self.wfile.write((json.dumps(chunk) + "\n").encode())
            self.wfile.flush()
        self.wfile.write(
            (json.dumps({"response": "", "done": True}) + "\n").encode()
        )

    def log_message(self, fmt, *args):  # quieter logs
        return


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 11434), Handler).serve_forever()
