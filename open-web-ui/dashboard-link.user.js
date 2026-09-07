// ==UserScript==
// @name         local-llm dashboard link
// @namespace    https://github.com/epittman23/local-llm
// @version      1.0.0
// @description  A small "Dashboard" link on Open WebUI, pointing at /ops. Client-side only -- see open-web-ui/Caddyfile and CLAUDE.md's 2026-09-06 decisions-log entry for why this exists instead of a fork of Open WebUI or a server-side rewrite of its HTML.
// @match        http://localhost:4000/*
// @exclude      http://localhost:4000/ops*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // A fixed-position pill in the corner, not a surgical insert into Open
  // WebUI's own sidebar markup. That is deliberate: Open WebUI's DOM is not
  // something this repo controls or pins a version of, so a selector aimed at
  // one of its internal containers would be exactly as fragile as the
  // server-side HTML rewrite this script replaced -- it would just break in
  // the browser instead of on the proxy. A fixed element with no dependency
  // on Open WebUI's structure can only ever fail by not appearing at all,
  // never by corrupting the page underneath it.
  if (document.getElementById("local-llm-dashboard-link")) return;

  var link = document.createElement("a");
  link.id = "local-llm-dashboard-link";
  link.href = "/ops";
  link.textContent = "Dashboard";
  link.title = "local-llm dashboard: serve, tests, compare, answers, report, tune";
  link.style.cssText = [
    "position:fixed", "right:14px", "bottom:14px", "z-index:2147483647",
    "background:#1f2430", "color:#e6e8ec", "border:1px solid #3a4050",
    "border-radius:20px", "padding:7px 16px", "font:13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "text-decoration:none", "box-shadow:0 2px 10px rgba(0,0,0,0.35)", "opacity:0.85",
  ].join(";");
  link.addEventListener("mouseenter", function () { link.style.opacity = "1"; });
  link.addEventListener("mouseleave", function () { link.style.opacity = "0.85"; });

  document.body.appendChild(link);
})();
