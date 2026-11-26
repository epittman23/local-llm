"""Stub OpenAI-compatible model for the throwaway stack. No real model, no data.

Run through stub.sh. STUB_PORT (default 4190) is the port; STUB_LOG, when set,
is a file that gets each chat request's messages as one JSON line.

The reply follows the last user message (matched case-insensitively):

  generate/concise + title   a JSON title            (the chat-title task)
  tags + categor             a JSON tags list         (the tags task)
  follow + question + json   a JSON follow-ups list   (the follow-up task)
  "show the page"            tool call `cat /workspace/outputs/page.html`,
                             then the tool's output echoed as `CAT: ...`
  "rewrite the page"         tool call that rewrites outputs/page.html
  "list files"               tool call `ls /workspace/outputs`
  "make outputs"             tool call that writes page.html, data.csv and a
                             report.pdf into /workspace/outputs
  "quote the edit"           the tail of the messages it was sent, as `CTX: ...`
  "write a page"             a reply holding one fenced html block
  "ext script"               a fenced html block with an external script
  "long script"              a fenced python block of 2000 lines
  "short"                    a one-line reply
  "please fail" + "error"    HTTP 503
  "slowly" anywhere          the default reply streamed at 4 chunks a second
  anything else              a long Markdown reply (math, table, code, list)

After a tool result the reply is `Done.`, except for "show the page". The
tool-call replies use the native `bash` tool, so the sandbox's code
interpreter runs them for real.
"""

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = ['qwen/qwen-2.5-coder-32b-instruct', 'qwen/qwen3.6-27b']
RICH = r'''Here is a worked answer.

## Sample mean and variance

For observations $x_1, \dots, x_n$ the unbiased estimator of the variance is

$$s^2 = \frac{1}{n-1}\sum_{i=1}^{n}(x_i - \bar{x})^2$$

| Statistic | Formula | Value |
|---|---|---|
| Mean | $\bar{x}$ | 4.20 |
| Variance | $s^2$ | 1.37 |
| Std. error | $s/\sqrt{n}$ | 0.26 |

```python
import numpy as np

def summarize(x: np.ndarray) -> dict[str, float]:
    """Return the mean, the unbiased variance and the standard error of x."""
    n = len(x)
    return {"mean": x.mean(), "var": x.var(ddof=1), "se": x.std(ddof=1) / np.sqrt(n)}

print(summarize(np.array([3.1, 4.4, 5.0, 4.3, 4.2])))
```

1. Compute the mean.
2. Subtract it from each observation and square.
3. Divide by $n-1$, not $n$.

> Dividing by $n$ underestimates the variance because the mean was estimated from the same data.

A very long unbroken token to test wrapping: `averyveryverylongidentifier_that_does_not_break_anywhere_and_keeps_going_and_going_and_going_until_the_bubble_overflows_or_not`
'''
HTML = (
    '<!doctype html>\n<html>\n<head><title>Demo</title>\n<style>\n'
    'body{font-family:sans-serif;background:#fff;color:#111}\n</style>\n</head>\n'
    '<body>\n<h1>Demo page</h1>\n<p id=x>hi</p>\n<ul>\n'
    + ''.join(f'<li>item {i}</li>\n' for i in range(1, 8))
    + "</ul>\n<script>document.getElementById('x').textContent='ran'</script>\n</body>\n</html>\n"
)
PAGE = f'Here is a page.\n\n```html\n{HTML}```\n\nDone.'
EXT = (
    'x\n\n```html\n<!doctype html>\n<html>\n<body>\n<p id=y>a</p>'
    '<script src="https://example.com/x.js"></script>'
    '<script>fetch("https://example.com/").catch(function(){'
    'document.getElementById("y").textContent="blocked"})</script>\n</body>\n</html>\n```\n'
)
BIG = 'Here is a long script.\n\n```python\n' + ''.join(f'x_{i} = {i}  # line {i}\n' for i in range(2000)) + '```\n'
BASH = (
    'mkdir -p /workspace/outputs && cd /workspace/outputs && '
    "printf '<!doctype html><title>t</title><p id=x>hi</p>"
    '<script>document.getElementById("x").textContent="ran"</script>\' > page.html && '
    "printf 'a,b\\n1,2\\n3,4\\n' > data.csv && python - <<'EOF2'\n"
    "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\n"
    "plt.plot([1,2,3]); plt.savefig('report.pdf')\nEOF2"
)
REWRITE = (
    "mkdir -p /workspace/outputs && printf '<!doctype html><title>m</title>"
    "<p id=x>MODEL REWROTE</p>' > /workspace/outputs/page.html"
)
SHORT = 'Sure. The answer is 42.'


def last_user_text(msgs):
    for m in reversed(msgs):
        if m.get('role') == 'user':
            c = m.get('content')
            return c if isinstance(c, str) else json.dumps(c)
    return ''


def reply_for(req):
    """A string, a ('TOOL', command) pair, or None for an HTTP 503."""
    msgs = req.get('messages') or []
    low = last_user_text(msgs).lower()
    if 'title' in low and ('generate' in low or 'concise' in low):
        return json.dumps({'title': 'Sample variance walkthrough'})
    if 'tags' in low and 'categor' in low:
        return json.dumps({'tags': ['statistics', 'python']})
    if 'follow' in low and 'question' in low and 'json' in low:
        return json.dumps({'follow_ups': ['Why divide by n-1?', 'Show a bootstrap version', 'What about weighted data?']})
    last_user = max([i for i, m in enumerate(msgs) if m.get('role') == 'user'] or [0])
    tools = [m for m in msgs[last_user + 1 :] if m.get('role') == 'tool']
    if tools:
        return 'CAT: ' + str(tools[-1].get('content')) if 'show the page' in low else 'Done.'
    for phrase, command in (
        ('show the page', 'cat /workspace/outputs/page.html'),
        ('rewrite the page', REWRITE),
        ('list files', 'ls /workspace/outputs'),
        ('make outputs', BASH),
    ):
        if phrase in low:
            return ('TOOL', command)
    if 'quote the edit' in low:
        return 'CTX: ' + json.dumps(msgs)[-1500:]
    for phrase, text in (('write a page', PAGE), ('ext script', EXT), ('long script', BIG), ('short', SHORT)):
        if phrase in low:
            return text
    if 'error' in low and 'please fail' in low:
        return None
    return RICH


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _json(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _stream_start(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Connection', 'close')
        self.end_headers()

    def _chunk(self, model, delta, finish=None, usage=None):
        c = {
            'id': 'stub',
            'object': 'chat.completion.chunk',
            'model': model,
            'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}],
        }
        if usage:
            c['usage'] = usage
        self.wfile.write(f'data: {json.dumps(c)}\n\n'.encode())
        self.wfile.flush()

    def _stream_end(self):
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()
        self.close_connection = True

    def do_GET(self):
        if self.path.rstrip('/').endswith('/models'):
            self._json({'object': 'list', 'data': [{'id': m, 'object': 'model', 'owned_by': 'stub'} for m in MODELS]})
        else:
            self._json({'error': 'not found'}, 404)

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        req = json.loads(self.rfile.read(n) or b'{}')
        if not self.path.rstrip('/').endswith('/chat/completions'):
            return self._json({'error': 'not found'}, 404)
        log = os.environ.get('STUB_LOG')
        if log:
            with open(log, 'a') as f:
                f.write(json.dumps(req.get('messages')) + '\n')
        text = reply_for(req)
        model = req.get('model', MODELS[0])
        if text is None:
            return self._json({'error': {'message': 'The upstream model is overloaded (stub error).', 'type': 'server_error'}}, 503)
        if isinstance(text, tuple):
            self._stream_start()
            self._chunk(model, {'role': 'assistant', 'content': ''})
            call = {'name': 'bash', 'arguments': json.dumps({'command': text[1]})}
            self._chunk(model, {'tool_calls': [{'index': 0, 'id': 'call_1', 'type': 'function', 'function': call}]})
            self._chunk(model, {}, 'tool_calls')
            return self._stream_end()
        usage = {'prompt_tokens': 42, 'completion_tokens': len(text) // 4, 'total_tokens': 42 + len(text) // 4}
        if req.get('stream'):
            self._stream_start()
            slow = 'slowly' in json.dumps(req.get('messages', '')).lower()
            self._chunk(model, {'role': 'assistant', 'content': ''})
            for i in range(0, len(text), 12):
                self._chunk(model, {'content': text[i : i + 12]})
                time.sleep(0.25 if slow else 0.01)
            self._chunk(model, {}, 'stop', usage)
            return self._stream_end()
        self._json(
            {
                'id': 'stub',
                'object': 'chat.completion',
                'model': model,
                'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
                'usage': usage,
            }
        )


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('STUB_PORT', '4190'))), Handler).serve_forever()
