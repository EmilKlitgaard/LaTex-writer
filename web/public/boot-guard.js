// Plain old JavaScript on purpose: this must run even in a browser too old for the app itself.
// If the app fails to start, say so on the page instead of leaving it blank.
(function () {
  var shown = false
  function show(detail) {
    var app = document.getElementById('app')
    if (shown || !app || app.childElementCount) return
    shown = true
    var box = document.createElement('div')
    box.style.cssText = 'max-width:420px;margin:15vh auto;padding:24px;font:15px/1.5 -apple-system,system-ui,sans-serif'
    var title = document.createElement('h1')
    title.style.cssText = 'font-size:20px;margin:0 0 10px'
    title.textContent = 'LaTeX Writer could not start'
    var text = document.createElement('p')
    text.textContent = 'This browser could not run the editor. Update the browser, or try a recent Safari or Chrome.'
    var code = document.createElement('p')
    code.style.cssText = 'font:12px ui-monospace,Menlo,monospace;opacity:.7;word-break:break-word'
    code.textContent = detail || ''
    box.appendChild(title)
    box.appendChild(text)
    box.appendChild(code)
    app.appendChild(box)
  }
  window.addEventListener('error', function (e) {
    var target = e.target
    if (target && target !== window && target.tagName === 'SCRIPT') show('A script failed to load: ' + target.src)
    else show(e.message || 'Unknown error')
  }, true)
  window.addEventListener('unhandledrejection', function (e) {
    show(String((e.reason && e.reason.message) || e.reason || 'Unknown error'))
  })
  window.addEventListener('load', function () {
    setTimeout(function () { show('The page loaded but nothing appeared.') }, 6000)
  })
})()
