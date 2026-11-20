package io.github.crhiscp.meetinginterpreter;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Network for the web UI (window.MiNative): HTTP requests and WebSockets made natively, so they can
 * carry API-key headers and are not limited by the WebView's cross-origin rules. Results come back
 * through window.MiNativeEvents.
 */
final class NativeBridge {
    private final Activity activity;
    private final WebView web;
    private final Map<String, MiniWebSocket> sockets = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool();

    NativeBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    private void js(String call) {
        web.post(() -> web.evaluateJavascript(call, null));
    }

    private static Map<String, String> parseHeaders(String json) {
        Map<String, String> m = new HashMap<>();
        try {
            JSONObject o = new JSONObject(json);
            for (Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                m.put(k, o.getString(k));
            }
        } catch (Exception ignored) {
        }
        return m;
    }

    @JavascriptInterface
    public void wsOpen(String id, String url, String headersJson) {
        final String q = JSONObject.quote(id);
        MiniWebSocket ws = new MiniWebSocket(URI.create(url), parseHeaders(headersJson), new MiniWebSocket.Listener() {
            @Override public void onOpen() { js("MiNativeEvents.ws(" + q + ",'open','')"); }
            @Override public void onText(String text) { js("MiNativeEvents.ws(" + q + ",'text'," + JSONObject.quote(text) + ")"); }
            @Override public void onBinary(byte[] data) { js("MiNativeEvents.ws(" + q + ",'binary','" + Base64.getEncoder().encodeToString(data) + "')"); }
            @Override public void onError(String message) { js("MiNativeEvents.ws(" + q + ",'error'," + JSONObject.quote(message) + ")"); }
            @Override public void onClose(int code, String reason) {
                sockets.remove(id);
                js("MiNativeEvents.ws(" + q + ",'close'," + JSONObject.quote(reason) + "," + code + ")");
            }
        });
        sockets.put(id, ws);
        ws.connect();
    }

    @JavascriptInterface
    public void wsSendText(String id, String text) {
        MiniWebSocket ws = sockets.get(id);
        if (ws != null) pool.execute(() -> ws.sendText(text));
    }

    @JavascriptInterface
    public void wsSendBinary(String id, String base64) {
        MiniWebSocket ws = sockets.get(id);
        if (ws != null) {
            byte[] data = Base64.getDecoder().decode(base64);
            pool.execute(() -> ws.sendBinary(data));
        }
    }

    @JavascriptInterface
    public void wsClose(String id, int code, String reason) {
        MiniWebSocket ws = sockets.remove(id);
        if (ws != null) pool.execute(() -> ws.close(code, reason));
    }

    @JavascriptInterface
    public void http(String id, String method, String url, String headersJson, String bodyBase64) {
        pool.execute(() -> {
            String q = JSONObject.quote(id);
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod(method);
                c.setConnectTimeout(15000);
                c.setReadTimeout(60000);
                for (Map.Entry<String, String> h : parseHeaders(headersJson).entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
                byte[] body = bodyBase64 == null || bodyBase64.isEmpty() ? new byte[0] : Base64.getDecoder().decode(bodyBase64);
                if (body.length > 0) {
                    c.setDoOutput(true);
                    try (OutputStream os = c.getOutputStream()) { os.write(body); }
                }
                int status = c.getResponseCode();
                InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                if (is != null) {
                    byte[] b = new byte[16384];
                    int n;
                    while ((n = is.read(b)) > 0) buf.write(b, 0, n);
                    is.close();
                }
                JSONObject hs = new JSONObject();
                for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                    if (e.getKey() != null && !e.getValue().isEmpty()) hs.put(e.getKey().toLowerCase(), e.getValue().get(0));
                }
                js("MiNativeEvents.http(" + q + "," + status + "," + JSONObject.quote(hs.toString()) + ",'" + Base64.getEncoder().encodeToString(buf.toByteArray()) + "','')");
            } catch (Exception e) {
                js("MiNativeEvents.http(" + q + ",0,'{}',''," + JSONObject.quote("网络请求失败：" + e.getMessage()) + ")");
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    @JavascriptInterface
    public void keepAwake(boolean on) {
        activity.runOnUiThread(() -> {
            if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    @JavascriptInterface
    public void openUrl(String url) {
        activity.runOnUiThread(() -> activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
    }

    void shutdown() {
        for (MiniWebSocket ws : sockets.values()) ws.close(1001, "app closed");
        sockets.clear();
        pool.shutdownNow();
    }
}
