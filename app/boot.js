/*
 * Plain ES5, loaded before the app: if the app has not started after a few seconds (an old
 * Android System WebView / Huawei browser engine cannot run it), say what to do instead of
 * leaving a white screen.
 */
(function () {
  setTimeout(function () {
    if (window.__miStarted) return;
    var app = document.getElementById('app');
    if (!app) return;
    app.innerHTML =
      '<div style="padding:32px 24px;font:16px/1.6 sans-serif;color:#111;background:#fff;min-height:100%">' +
      '<h2 style="font-size:20px">需要更新手机的网页组件</h2>' +
      '<p>这台手机的“Android System WebView”（华为手机是“华为浏览器内核”）版本太旧，运行不了本软件。</p>' +
      '<p>请在应用商店搜索并更新“Android System WebView”或“Chrome”，然后重新打开本软件。</p>' +
      '<p style="color:#666">Necesitas actualizar “Android System WebView” (o Chrome) desde la tienda de aplicaciones.</p>' +
      '</div>';
  }, 4000);
})();
