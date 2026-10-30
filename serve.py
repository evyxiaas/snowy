# Tiny local web server for Snowy/Cloudy Music. Serves the "github" folder at http://localhost:8765
# and tells the browser NOT to cache, so you always see the newest design.
import http.server, os, sys

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "github"))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()
    def log_message(self, *args):
        pass

try:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
except OSError as e:
    print("Could not start on port 8765:", e)
    print("Another server is probably still running. Close its black window and try again.")
    sys.exit(1)
print("Serving", os.getcwd())
server.serve_forever()
