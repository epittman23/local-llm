(function () {
  "use strict";

  var API = "/ops/api";

  function api(path, opts) {
    opts = Object.assign({headers: {"Content-Type": "application/json"}}, opts || {});
    return fetch(API + path, opts).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        if (!res.ok) {
          var message = (body && (body.error || body.detail)) || res.statusText;
          throw new Error(message);
        }
        return body;
      });
    });
  }
  function apiGet(path) { return api(path); }
  function apiPost(path, data) {
    return api(path, {method: "POST", body: JSON.stringify(data || {})});
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function renderTable(columns, rows, opts) {
    opts = opts || {};
    var wrap = el("div", {class: "table-scroll"});
    var table = el("table");
    var thead = el("thead");
    thead.appendChild(el("tr", {}, columns.map(function (c) { return el("th", {text: c}); })));
    table.appendChild(thead);
    var tbody = el("tbody");
    rows.forEach(function (row, i) {
      var tr = el("tr", opts.onRowClick ? {class: "selectable", onclick: function () { opts.onRowClick(row, i); }} : {});
      row.forEach(function (cell) {
        tr.appendChild(el("td", {text: cell === null || cell === undefined ? "" : String(cell)}));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function notesBlock(notes) {
    var frag = document.createDocumentFragment();
    (notes || []).forEach(function (n) {
      var isWarn = /^warning:/.test(n);
      frag.appendChild(el("div", {class: "note" + (isWarn ? " warn" : ""), text: n}));
    });
    return frag;
  }

  function renderMarkdown(text) {
    if (window.marked && window.marked.parse) return window.marked.parse(text);
    var div = document.createElement("div");
    div.textContent = text;
    return "<pre>" + div.innerHTML + "</pre>";
  }

  // -- router -----------------------------------------------------------
  var routes = {};
  var current = null;

  function register(path, page) { routes[path] = page; }

  function navigate(path) {
    history.pushState({}, "", path);
    render(path);
  }

  function render(path) {
    if (current && current.cleanup) current.cleanup();
    document.querySelectorAll(".nav-link").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-route") === path);
    });
    var page = routes[path] || routes["/ops/serve"];
    var container = document.getElementById("content");
    container.innerHTML = "";
    current = page;
    page.mount(container);
  }

  document.addEventListener("click", function (ev) {
    var a = ev.target.closest ? ev.target.closest("a[data-route]") : null;
    if (!a) return;
    ev.preventDefault();
    navigate(a.getAttribute("href"));
  });
  window.addEventListener("popstate", function () { render(location.pathname); });

  // -----------------------------------------------------------------------
  // Serve
  // -----------------------------------------------------------------------
  register("/ops/serve", (function () {
    var es = null;

    function fieldsBody(container, name, profile) {
      var body = container.querySelector("#serve-fields");
      body.innerHTML = "";
      function textField(id, label, value) {
        return el("div", {class: "field"}, [
          el("label", {text: label}),
          el("input", {id: id, value: value === null || value === undefined ? "" : String(value)}),
        ]);
      }
      body.appendChild(el("div", {class: "row"}, [
        textField("f-ngl", "-ngl", profile.ngl),
        textField("f-ctx", "context", profile.ctx),
        textField("f-threads", "threads", profile.threads),
        textField("f-parallel", "--parallel", profile.parallel),
      ]));
      body.appendChild(el("div", {class: "row"}, [
        el("div", {class: "field", style: "flex:1;min-width:260px"}, [
          el("label", {text: "-ot (tensor overrides)"}),
          el("input", {id: "f-ot", value: profile.ot || ""}),
        ]),
      ]));
      var specSel = el("select", {id: "f-spec"}, [
        el("option", {value: "on", text: "profile default"}),
        el("option", {value: "off", text: "off (LLAMA_SPEC=off)"}),
      ]);
      var reasoningSel = el("select", {id: "f-reasoning"},
        ["low", "medium", "high", "xhigh"].map(function (v) { return el("option", {value: v, text: v}); }));
      reasoningSel.value = profile.reasoning || "medium";
      reasoningSel.disabled = !profile.reasoning;
      body.appendChild(el("div", {class: "row"}, [
        el("div", {class: "field"}, [el("label", {text: "speculative decoding"}), specSel]),
        el("div", {class: "field"}, [el("label", {text: "reasoning effort"}), reasoningSel]),
      ]));
      if (profile && profile.weights_present === false) {
        body.appendChild(el("div", {class: "note warn",
          text: "note: " + name + "'s weights are not on disk (" + (profile.model || "?") +
                "). llama-fetch " + name + " downloads them."}));
      }
    }

    function loadProfile(name, container) {
      return apiGet("/serve/profile/" + encodeURIComponent(name)).then(function (profile) {
        fieldsBody(container, name, profile || {});
      });
    }

    function formPayload(name) {
      var reasoningEl = document.getElementById("f-reasoning");
      return {
        profile: name,
        ngl: document.getElementById("f-ngl").value,
        ctx: document.getElementById("f-ctx").value,
        threads: document.getElementById("f-threads").value,
        parallel: document.getElementById("f-parallel").value,
        ot: document.getElementById("f-ot").value,
        spec: document.getElementById("f-spec").value,
        reasoning: reasoningEl.disabled ? "" : reasoningEl.value,
      };
    }

    function streamLog(log) {
      if (es) es.close();
      es = new EventSource(API + "/serve/stream");
      es.onmessage = function (ev) {
        log.textContent += JSON.parse(ev.data) + "\n";
        log.scrollTop = log.scrollHeight;
      };
      es.addEventListener("done", function (ev) {
        log.textContent += "[server exited: " + ev.data + "]\n";
        if (es) { es.close(); es = null; }
      });
      es.onerror = function () { /* the browser retries; a closed stream is expected on stop */ };
    }

    return {
      mount: function (container) {
        container.appendChild(el("h1", {text: "Serve"}));
        container.appendChild(el("p", {class: "page-sub",
          text: "Start llama-server from a profile, with the overrides that matter on 6 GB."}));

        var select = el("select", {id: "f-profile"});
        container.appendChild(el("div", {class: "row"}, [
          el("div", {class: "field"}, [el("label", {text: "profile"}), select]),
        ]));
        container.appendChild(el("div", {id: "serve-fields"}));
        var startBtn = el("button", {class: "primary", text: "Start server"});
        var stopBtn = el("button", {class: "warn", text: "Stop"});
        var checkBtn = el("button", {text: "Check"});
        container.appendChild(el("div", {class: "row"}, [startBtn, stopBtn, checkBtn]));
        var log = el("div", {class: "log", id: "serve-log"});
        container.appendChild(log);

        apiGet("/serve/profiles").then(function (data) {
          (data.profiles || []).forEach(function (name) {
            select.appendChild(el("option", {value: name, text: name}));
          });
          if (data.profiles && data.profiles.length) {
            select.value = data.profiles[0];
            loadProfile(select.value, container);
          }
        });
        select.addEventListener("change", function () { loadProfile(select.value, container); });

        startBtn.addEventListener("click", function () {
          log.textContent = "";
          apiPost("/serve/start", formPayload(select.value)).then(function () {
            streamLog(log);
          }).catch(function (err) { log.textContent += "[" + err.message + "]\n"; });
        });
        stopBtn.addEventListener("click", function () {
          apiPost("/serve/stop").then(function (r) {
            log.textContent += r.stopped ? "[stopping: SIGTERM to the process group]\n"
                                          : "[nothing running from this dashboard]\n";
          });
        });
        checkBtn.addEventListener("click", function () {
          apiGet("/serve/check").then(function (r) { log.textContent += r.output + "\n"; });
        });
      },
      cleanup: function () { if (es) { es.close(); es = null; } },
    };
  })());

  // -----------------------------------------------------------------------
  // Live
  // -----------------------------------------------------------------------
  register("/ops/live", (function () {
    var timer = null;

    function refresh(container) {
      return apiGet("/live").then(function (data) {
        var body = container.querySelector("#live-body");
        body.innerHTML = "";
        if (!data.run) {
          body.appendChild(el("p", {class: "note",
            text: "No serving run recorded yet. Start one on the Serve page."}));
          return;
        }
        var run = data.run;
        var state = run.ended_at ? "ended " + run.ended_at + " (" + (run.ended_reason || "clean") + ")" : "serving";
        body.appendChild(el("p", {}, [
          el("strong", {text: run.model + "-" + run.quant}),
          "  config " + run.config_id + "  build " + run.build + "  port " + run.port,
        ]));
        body.appendChild(el("p", {class: "note",
          text: "started " + run.started_at + "   " + state + "   " +
                ((data.recent_samples || []).length) + " recent samples   " + data.requests + " requests"}));

        var grid = el("div", {class: "stat-grid"});
        var s = data.summary || {};
        ["util_active_avg", "util_p50", "util_p95", "util_max", "temp_max", "power_p50",
         "power_p95", "sm_p50", "sm_max", "mem_max", "vram_headroom_mib", "throttle"].forEach(function (key) {
          var v = s[key];
          if (v === undefined || v === null || v === "") return;
          grid.appendChild(el("div", {class: "stat"}, [
            el("div", {class: "label", text: key.replace(/_/g, " ")}),
            el("div", {class: "value", text: typeof v === "number" ? v.toFixed(1) : String(v)}),
          ]));
        });
        Object.keys(data.deltas || {}).sort().forEach(function (k) {
          grid.appendChild(el("div", {class: "stat"}, [
            el("div", {class: "label", text: k.replace("llamacpp:", "")}),
            el("div", {class: "value", text: Number(data.deltas[k]).toFixed(0)}),
          ]));
        });
        body.appendChild(grid);

        if (data.recent_samples && data.recent_samples.length) {
          body.appendChild(el("h2", {text: "recent samples"}));
          var rows = data.recent_samples.map(function (s2) {
            return [(s2.at || "").slice(11, 19), s2.util_pct, s2.mem_used_mib, s2.power_w, s2.sm_mhz, s2.temp_c];
          });
          body.appendChild(renderTable(["at", "util %", "mem MiB", "power W", "SM MHz", "temp C"], rows));
        }
        if (data.warning) body.appendChild(el("div", {class: "note warn", text: data.warning}));
      });
    }

    return {
      mount: function (container) {
        container.appendChild(el("h1", {text: "Live"}));
        container.appendChild(el("p", {class: "page-sub",
          text: "The run being recorded right now, refreshed every 5s to match the recorder's own sample interval."}));
        container.appendChild(el("div", {id: "live-body"}));
        refresh(container);
        timer = setInterval(function () { refresh(container); }, 5000);
      },
      cleanup: function () { if (timer) { clearInterval(timer); timer = null; } },
    };
  })());

  // -----------------------------------------------------------------------
  // Tests
  // -----------------------------------------------------------------------
  register("/ops/tests", (function () {
    var es = null;

    return {
      mount: function (container) {
        container.appendChild(el("h1", {text: "Tests"}));
        container.appendChild(el("p", {class: "page-sub", text: "Run a tier and watch results land, item by item."}));

        var tierSel = el("select", {id: "t-tier"},
          ["smoke", "standard", "full"].map(function (v) { return el("option", {value: v, text: v}); }));
        var benchSel = el("select", {id: "t-bench"});
        var resumeSel = el("select", {id: "t-resume"}, [
          el("option", {value: "", text: "no"}), el("option", {value: "1", text: "yes"}),
        ]);
        var systemSel = el("select", {id: "t-system"});
        container.appendChild(el("div", {class: "row"}, [
          el("div", {class: "field"}, [el("label", {text: "tier"}), tierSel]),
          el("div", {class: "field"}, [el("label", {text: "benchmark"}), benchSel]),
          el("div", {class: "field"}, [el("label", {text: "resume"}), resumeSel]),
          el("div", {class: "field"}, [el("label", {text: "system prompt"}), systemSel]),
        ]));
        var runBtn = el("button", {class: "primary", text: "Run suite"});
        var cancelBtn = el("button", {class: "warn", text: "Cancel"});
        container.appendChild(el("div", {class: "row"}, [runBtn, cancelBtn]));
        var progress = el("p", {class: "note", id: "t-progress"});
        container.appendChild(progress);
        var log = el("div", {class: "log", id: "t-log"});
        container.appendChild(log);

        apiGet("/tests/options").then(function (data) {
          (data.benchmarks || []).forEach(function (b) {
            benchSel.appendChild(el("option", {value: b, text: b || "all"}));
          });
          systemSel.appendChild(el("option", {value: "", text: "none"}));
          (data.systems || []).forEach(function (s) {
            systemSel.appendChild(el("option", {value: s, text: s}));
          });
        });

        function connect() {
          if (es) es.close();
          es = new EventSource(API + "/tests/stream");
          es.onmessage = function (ev) {
            var msg = JSON.parse(ev.data);
            if (msg.type === "start") {
              log.textContent = "== " + msg.total + " to run, " + msg.skipped + " excluded\n";
            } else if (msg.type === "item") {
              log.textContent += "[" + (msg.i + 1) + "/" + msg.total + "] " + msg.benchmark + "/" + msg.item_id +
                ": " + msg.outcome + (msg.reason ? " - " + msg.reason.slice(0, 120) : "") +
                "   [" + msg.passed + "/" + msg.attempted + " passing]\n";
              progress.textContent = (msg.i + 1) + "/" + msg.total + " done, " + msg.passed + "/" + msg.attempted + " passing";
            } else if (msg.type === "done") {
              log.textContent += "== " + (msg.cancelled ? "cancelled" : "done") + ": " +
                msg.passed + "/" + msg.attempted + " passing\n";
              if (es) { es.close(); es = null; }
            } else if (msg.type === "error") {
              log.textContent += "[error: " + msg.message + "]\n";
              if (es) { es.close(); es = null; }
            }
            log.scrollTop = log.scrollHeight;
          };
          es.onerror = function () {};
        }

        runBtn.addEventListener("click", function () {
          log.textContent = "";
          progress.textContent = "";
          apiPost("/tests/run", {
            tier: tierSel.value, benchmark: benchSel.value || null,
            resume: !!resumeSel.value, system: systemSel.value || null,
          }).then(connect).catch(function (err) { log.textContent += "[" + err.message + "]\n"; });
        });
        cancelBtn.addEventListener("click", function () {
          apiPost("/tests/cancel").then(function (r) {
            log.textContent += r.cancelled
              ? "[cancel requested; the item in flight finishes, then the run stops -- resumable]\n"
              : "[nothing running]\n";
          });
        });
      },
      cleanup: function () { if (es) { es.close(); es = null; } },
    };
  })());

  // -----------------------------------------------------------------------
  // Compare
  // -----------------------------------------------------------------------
  register("/ops/compare", (function () {
    function reload(container) {
      var by = container.querySelector("#c-by").value;
      var tier = container.querySelector("#c-tier").value;
      return apiGet("/compare?by=" + encodeURIComponent(by) + "&tier=" + encodeURIComponent(tier))
        .then(function (data) {
          var body = container.querySelector("#c-body");
          body.innerHTML = "";
          body.appendChild(renderTable(data.columns, data.rows));
          if (data.derived_columns) {
            body.appendChild(el("h2", {text: "derived"}));
            body.appendChild(renderTable(data.derived_columns, data.derived));
          }
          body.appendChild(notesBlock(data.notes));
        });
    }

    return {
      mount: function (container) {
        container.appendChild(el("h1", {text: "Compare"}));
        container.appendChild(el("p", {class: "page-sub",
          text: "Models and serving configurations, ranked on test results."}));
        var bySel = el("select", {id: "c-by"}, [
          ["config", "configuration"], ["benchmark", "benchmark"],
          ["failures", "failures"], ["serving", "serving"],
        ].map(function (p) { return el("option", {value: p[0], text: p[1]}); }));
        var tierSel = el("select", {id: "c-tier"}, [
          ["", "all"], ["smoke", "smoke"], ["standard", "standard"], ["full", "full"],
        ].map(function (p) { return el("option", {value: p[0], text: p[1]}); }));
        var refreshBtn = el("button", {class: "primary", text: "Refresh"});
        var exportBtn = el("button", {text: "Export answers"});
        container.appendChild(el("div", {class: "row"}, [
          el("div", {class: "field"}, [el("label", {text: "group by"}), bySel]),
          el("div", {class: "field"}, [el("label", {text: "tier"}), tierSel]),
          refreshBtn, exportBtn,
        ]));
        container.appendChild(el("div", {id: "c-body"}));
        bySel.addEventListener("change", function () { reload(container); });
        tierSel.addEventListener("change", function () { reload(container); });
        refreshBtn.addEventListener("click", function () { reload(container); });
        exportBtn.addEventListener("click", function () {
          apiPost("/compare/export-answers").then(function (r) {
            var body = container.querySelector("#c-body");
            var note = el("p", {class: "note",
              text: r.written ? ("exported " + r.written + " answers to " + r.dir) : (r.note || "nothing exported")});
            body.insertBefore(note, body.firstChild);
          });
        });
        reload(container);
      },
      cleanup: function () {},
    };
  })());

  // -----------------------------------------------------------------------
  // Answers
  // -----------------------------------------------------------------------
  register("/ops/answers", (function () {
    var rows = [];
    var currentRow = null;

    function showAnswer(container, row) {
      if (!row) return;
      var run = container.querySelector("#a-run").value;
      var thinking = container.querySelector("#a-think").checked ? 1 : 0;
      return apiGet("/answers/one?run=" + encodeURIComponent(run) +
          "&benchmark=" + encodeURIComponent(row.benchmark) + "&item_id=" + encodeURIComponent(row.item_id) +
          "&thinking=" + thinking).then(function (data) {
        var body = container.querySelector("#a-body");
        body.innerHTML = "";
        if (data.error) {
          body.appendChild(el("p", {class: "note error", text: data.error}));
          return;
        }
        var div = el("div", {class: "answer-body markdown-body"});
        div.innerHTML = renderMarkdown(data.markdown);
        body.appendChild(div);
      });
    }

    function reload(container) {
      var run = container.querySelector("#a-run").value;
      var filterVal = container.querySelector("#a-filter").value;
      return apiGet("/answers?run=" + encodeURIComponent(run) + "&filter=" + encodeURIComponent(filterVal))
        .then(function (data) {
          rows = data.rows || [];
          var table = container.querySelector("#a-table");
          table.innerHTML = "";
          table.appendChild(renderTable(["benchmark", "item", "outcome", "why", "thinking"],
            rows.map(function (r) {
              return [r.benchmark, r.item_id, r.outcome, (r.reason || "").slice(0, 60),
                     r.reasoning_chars === null || r.reasoning_chars === undefined ? "" : r.reasoning_chars];
            }),
            {onRowClick: function (row, i) { currentRow = rows[i]; showAnswer(container, currentRow); }}));
          if (rows.length) {
            currentRow = rows[0];
            showAnswer(container, currentRow);
          } else {
            currentRow = null;
            container.querySelector("#a-body").innerHTML =
              "<p class=\"note\">Nothing matching this filter.</p>";
          }
        });
    }

    function loadRuns(container) {
      return apiGet("/answers/runs").then(function (data) {
        var select = container.querySelector("#a-run");
        select.innerHTML = "";
        (data.runs || []).forEach(function (r) {
          var label = (r.started_at || "").slice(0, 19) + "  " + r.model + "  " + r.tier + "  " +
                     r.passed + "/" + r.attempted;
          select.appendChild(el("option", {value: r.suite_run_id, text: label}));
        });
        if (data.runs && data.runs.length) return reload(container);
        container.querySelector("#a-body").innerHTML =
          "<p class=\"note\">No suite run recorded yet. Run one on the Tests page.</p>";
      });
    }

    return {
      mount: function (container) {
        container.appendChild(el("h1", {text: "Answers"}));
        container.appendChild(el("p", {class: "page-sub",
          text: "What the model actually said, for one recorded item."}));
        var runSel = el("select", {id: "a-run", style: "min-width:320px"});
        var filterSel = el("select", {id: "a-filter"}, [
          ["failures", "failures"], ["all", "all items"], ["pass", "passes"],
        ].map(function (p) { return el("option", {value: p[0], text: p[1]}); }));
        var thinkInput = el("input", {type: "checkbox", id: "a-think"});
        var refreshBtn = el("button", {text: "Refresh"});
        container.appendChild(el("div", {class: "row"}, [
          el("div", {class: "field"}, [el("label", {text: "suite run"}), runSel]),
          el("div", {class: "field"}, [el("label", {text: "show"}), filterSel]),
          el("label", {}, [thinkInput, " show thinking"]),
          refreshBtn,
        ]));
        container.appendChild(el("div", {id: "a-table"}));
        container.appendChild(el("div", {id: "a-body"}));

        runSel.addEventListener("change", function () { reload(container); });
        filterSel.addEventListener("change", function () { reload(container); });
        thinkInput.addEventListener("change", function () { showAnswer(container, currentRow); });
        refreshBtn.addEventListener("click", function () { loadRuns(container); });
        loadRuns(container);
      },
      cleanup: function () {},
    };
  })());

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------
  register("/ops/report", (function () {
    return {
      mount: function (container) {
        container.appendChild(el("h1", {text: "Report"}));
        container.appendChild(el("p", {class: "page-sub",
          text: "A statistical report over logs/llama.db -- design audit, paired tests, power, throughput."}));
        var tierSel = el("select", {id: "r-tier"}, [
          ["", "all"], ["smoke", "smoke"], ["standard", "standard"], ["full", "full"],
        ].map(function (p) { return el("option", {value: p[0], text: p[1]}); }));
        var modelInput = el("input", {id: "r-model", placeholder: "model alias"});
        var benchSel = el("select", {id: "r-bench"}, [
          ["", "all"], ["humaneval", "humaneval"], ["mbpp", "mbpp"], ["ds1000", "ds1000"],
        ].map(function (p) { return el("option", {value: p[0], text: p[1]}); }));
        var noFigInput = el("input", {type: "checkbox", id: "r-nofig"});
        var genBtn = el("button", {class: "primary", text: "Generate"});
        container.appendChild(el("div", {class: "row"}, [
          el("div", {class: "field"}, [el("label", {text: "tier"}), tierSel]),
          el("div", {class: "field"}, [el("label", {text: "model"}), modelInput]),
          el("div", {class: "field"}, [el("label", {text: "benchmark"}), benchSel]),
          el("label", {}, [noFigInput, " no figures"]),
          genBtn,
        ]));
        var status = el("p", {class: "note", id: "r-status"});
        container.appendChild(status);
        var body = el("div", {id: "r-body", class: "markdown-body"});
        container.appendChild(body);

        genBtn.addEventListener("click", function () {
          status.textContent = "generating (scipy + matplotlib -- can take a few seconds)...";
          status.className = "note";
          body.innerHTML = "";
          apiPost("/report", {
            tier: tierSel.value || null, model: modelInput.value || null,
            benchmark: benchSel.value || null, no_figures: noFigInput.checked,
          }).then(function (data) {
            if (data.error) {
              status.textContent = data.error;
              status.className = "note error";
              return null;
            }
            status.textContent = "generated " + data.date + " (" + data.figures.length + " figures)";
            return fetch(data.markdown_url).then(function (r) { return r.text(); });
          }).then(function (md) {
            if (md === null || md === undefined) return;
            body.innerHTML = renderMarkdown(md);
            body.querySelectorAll("img").forEach(function (img) { img.classList.add("figure"); });
          }).catch(function (err) {
            status.textContent = err.message;
            status.className = "note error";
          });
        });
      },
      cleanup: function () {},
    };
  })());

  // -----------------------------------------------------------------------
  // Tune
  // -----------------------------------------------------------------------
  register("/ops/tune", (function () {
    var timer = null;
    var es = null;

    function refreshStatus(container) {
      var sweepId = container.querySelector("#tu-sweepid").value;
      return apiGet("/tune/status" + (sweepId ? "?sweep_id=" + encodeURIComponent(sweepId) : ""))
        .then(function (data) {
          var body = container.querySelector("#tu-status");
          body.innerHTML = "";
          if (!data.sweep) {
            body.appendChild(el("p", {class: "note", text: "no sweeps recorded"}));
            return;
          }
          var s = data.sweep;
          body.appendChild(el("p", {}, [
            el("strong", {text: s.sweep_id}),
            "  profile " + s.profile + "  tier " + s.tier + "  budget " + s.budget_mode + "  " +
            (s.verdict || s.ended_reason || "running"),
          ]));
          body.appendChild(el("h2", {text: "rounds"}));
          body.appendChild(renderTable(["round", "stage", "started", "ended"], (data.rounds || []).map(function (r) {
            return [r.round_no, r.stage, r.started_at, r.ended_at || "-"];
          })));
          body.appendChild(el("h2", {text: "candidates"}));
          body.appendChild(renderTable(["sha", "stage", "status", "config-id"], (data.candidates || []).map(function (c) {
            return [(c.candidate_sha || "").slice(0, 8), c.stage, c.status, c.config_id || "-"];
          })));
        });
    }

    function connectLog(log) {
      if (es) es.close();
      es = new EventSource(API + "/tune/log");
      es.onmessage = function (ev) {
        log.textContent += JSON.parse(ev.data) + "\n";
        log.scrollTop = log.scrollHeight;
      };
      es.addEventListener("done", function (ev) {
        log.textContent += "[exited: " + ev.data + "]\n";
        if (es) { es.close(); es = null; }
      });
      es.onerror = function () {};
    }

    return {
      mount: function (container) {
        container.appendChild(el("h1", {text: "Tune"}));
        container.appendChild(el("p", {class: "page-sub",
          text: "Search the serving configuration space: rank on throughput, guard on correctness."}));

        var profileInput = el("input", {id: "tu-profile", placeholder: "profile (e.g. qwen38)"});
        var tierSel = el("select", {id: "tu-tier"},
          ["smoke", "standard", "full"].map(function (v) { return el("option", {value: v, text: v}); }));
        var budgetSel = el("select", {id: "tu-budget"},
          ["interactive", "overnight", "unattended"].map(function (v) { return el("option", {value: v, text: v}); }));
        var systemInput = el("input", {id: "tu-system", placeholder: "system prompt (optional)"});
        var extraInput = el("input", {id: "tu-extra", placeholder: "extra flags, e.g. --candidates 6"});
        container.appendChild(el("div", {class: "row"}, [
          el("div", {class: "field"}, [el("label", {text: "profile"}), profileInput]),
          el("div", {class: "field"}, [el("label", {text: "tier"}), tierSel]),
          el("div", {class: "field"}, [el("label", {text: "budget"}), budgetSel]),
          el("div", {class: "field"}, [el("label", {text: "system prompt"}), systemInput]),
        ]));
        container.appendChild(el("div", {class: "row"}, [
          el("div", {class: "field", style: "flex:1;min-width:280px"}, [
            el("label", {text: "extra flags"}), extraInput]),
        ]));
        var startBtn = el("button", {class: "primary", text: "Start sweep"});
        var stopBtn = el("button", {class: "warn", text: "Stop"});
        container.appendChild(el("div", {class: "row"}, [startBtn, stopBtn]));

        var sweepIdInput = el("input", {id: "tu-sweepid", placeholder: "sweep id (blank = latest)"});
        var resumeBtn = el("button", {text: "Resume"});
        var statusBtn = el("button", {text: "Refresh status"});
        container.appendChild(el("div", {class: "row"}, [
          el("div", {class: "field"}, [el("label", {text: "sweep id"}), sweepIdInput]),
          resumeBtn, statusBtn,
        ]));
        var log = el("div", {class: "log", id: "tu-log"});
        container.appendChild(log);
        container.appendChild(el("div", {id: "tu-status"}));

        startBtn.addEventListener("click", function () {
          log.textContent = "";
          apiPost("/tune/start", {
            profile: profileInput.value || null, tier: tierSel.value, budget: budgetSel.value,
            system: systemInput.value || null, extra_args: extraInput.value || null,
          }).then(function () { connectLog(log); })
            .catch(function (err) { log.textContent += "[" + err.message + "]\n"; });
        });
        stopBtn.addEventListener("click", function () {
          apiPost("/tune/stop").then(function (r) {
            log.textContent += r.stopped ? "[stopping: SIGTERM to the process group]\n"
                                          : "[nothing running from this dashboard]\n";
          });
        });
        resumeBtn.addEventListener("click", function () {
          log.textContent = "";
          apiPost("/tune/resume", {sweep_id: sweepIdInput.value || null})
            .then(function () { connectLog(log); })
            .catch(function (err) { log.textContent += "[" + err.message + "]\n"; });
        });
        statusBtn.addEventListener("click", function () { refreshStatus(container); });

        refreshStatus(container);
        timer = setInterval(function () { refreshStatus(container); }, 5000);
      },
      cleanup: function () {
        if (timer) { clearInterval(timer); timer = null; }
        if (es) { es.close(); es = null; }
      },
    };
  })());

  // -- boot -----------------------------------------------------------
  var start = location.pathname;
  if (!routes[start]) start = "/ops/serve";
  if (start !== location.pathname) history.replaceState({}, "", start);
  render(start);
})();
