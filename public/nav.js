// The tab bar every page shares. Each page has <nav class="navtabs" id="navtabs" data-current="…">
// followed by this script, so the bar is drawn before the page is shown.
// Scan, Label and Find are parts of the phone page (/): it switches between them without
// reloading. Board, Plan and Lists are pages of their own.
(function () {
  var TABS = [["scan", "/", "Scan"], ["label", "/label", "Label"], ["find", "/find", "Find"], ["board", "/board", "Board"], ["plan", "/plan", "Plan"], ["lists", "/lists", "Lists"]];
  var nav = document.getElementById("navtabs");
  if (!nav) return;
  var path = location.pathname.replace(/\/+$/, "");
  var cur = nav.getAttribute("data-current");
  if (cur === "phone") cur = path === "/label" ? "label" : path === "/find" ? "find" : "scan";
  nav.setAttribute("aria-label", "Move pages");
  nav.innerHTML = '<div class="navtabs-in">' + TABS.map(function (t) {
    return '<a href="' + t[1] + '" data-tab="' + t[0] + '"' + (t[0] === cur ? ' aria-current="page"' : "") + ">" + t[2] + "</a>";
  }).join("") + "</div>";
})();
