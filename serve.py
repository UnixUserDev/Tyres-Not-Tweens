"""Static server for the sim, with caching disabled.

python3 -m http.server sends no Cache-Control header, so browsers are free to
heuristically cache the ES modules - which means a reload can happily run
yesterday's carModel.js. This serves everything with no-store so a reload always
loads what is on disk.
"""

import http.server

PORT = 8099


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter console
        pass


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler).serve_forever()
