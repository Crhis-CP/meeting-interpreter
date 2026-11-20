package io.github.crhiscp.meetinginterpreter;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * A small RFC 6455 WebSocket client (no dependencies). Unlike the WebView's WebSocket, it can send
 * request headers in the handshake, which cloud speech services use for their API keys.
 */
final class MiniWebSocket {
    interface Listener {
        void onOpen();
        void onText(String text);
        void onBinary(byte[] data);
        void onClose(int code, String reason);
        void onError(String message);
    }

    private final URI uri;
    private final Map<String, String> headers;
    private final Listener listener;
    private final SecureRandom random = new SecureRandom();
    private Socket socket;
    private OutputStream out;
    private volatile boolean closed;
    private volatile boolean notified;

    /** Reports the end of the connection exactly once. */
    private void notifyClose(int code, String reason) {
        if (notified) return;
        notified = true;
        listener.onClose(code, reason);
    }

    MiniWebSocket(URI uri, Map<String, String> headers, Listener listener) {
        this.uri = uri;
        this.headers = headers;
        this.listener = listener;
    }

    void connect() {
        Thread t = new Thread(this::run, "ws-" + uri.getHost());
        t.setDaemon(true);
        t.start();
    }

    private void run() {
        try {
            boolean tls = "wss".equalsIgnoreCase(uri.getScheme());
            int port = uri.getPort() > 0 ? uri.getPort() : (tls ? 443 : 80);
            String host = uri.getHost();
            if (tls) {
                SSLSocket s = (SSLSocket) SSLSocketFactory.getDefault().createSocket(host, port);
                s.startHandshake();
                if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, s.getSession())) {
                    s.close();
                    throw new IOException("证书与服务器不匹配：" + host);
                }
                socket = s;
            } else {
                socket = new Socket();
                socket.connect(new InetSocketAddress(host, port), 15000);
            }
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(0);
            out = socket.getOutputStream();
            InputStream in = new BufferedInputStream(socket.getInputStream());

            byte[] keyBytes = new byte[16];
            random.nextBytes(keyBytes);
            String key = Base64.getEncoder().encodeToString(keyBytes);
            String path = uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
            if (uri.getRawQuery() != null) path += "?" + uri.getRawQuery();
            StringBuilder req = new StringBuilder()
                    .append("GET ").append(path).append(" HTTP/1.1\r\n")
                    .append("Host: ").append(host).append(uri.getPort() > 0 ? ":" + uri.getPort() : "").append("\r\n")
                    .append("Upgrade: websocket\r\nConnection: Upgrade\r\n")
                    .append("Sec-WebSocket-Key: ").append(key).append("\r\n")
                    .append("Sec-WebSocket-Version: 13\r\n");
            for (Map.Entry<String, String> h : headers.entrySet()) {
                req.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
            }
            req.append("\r\n");
            synchronized (this) {
                out.write(req.toString().getBytes(StandardCharsets.UTF_8));
                out.flush();
            }

            String status = readLine(in);
            int code = status.split(" ").length > 1 ? Integer.parseInt(status.split(" ")[1]) : 0;
            while (!readLine(in).isEmpty()) {
                // skip response headers
            }
            if (code != 101) {
                String hint = code == 401 || code == 403 ? "（Key 无效或无权限）" : "";
                listener.onError("WebSocket 握手失败：HTTP " + code + hint);
                close(1006, "handshake");
                notifyClose(1006, "handshake failed");
                return;
            }
            listener.onOpen();
            readFrames(in);
        } catch (IOException e) {
            if (!closed) {
                listener.onError("连接失败：" + e.getMessage());
                notifyClose(1006, String.valueOf(e.getMessage()));
            }
        } finally {
            closed = true;
            try {
                if (socket != null) socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void readFrames(InputStream in) throws IOException {
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        int messageOpcode = 0;
        while (!closed) {
            int b0 = in.read();
            int b1 = in.read();
            if (b0 < 0 || b1 < 0) throw new IOException("connection closed");
            boolean fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0f;
            long len = b1 & 0x7f;
            if (len == 126) len = ((long) readByte(in) << 8) | readByte(in);
            else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in);
            }
            byte[] mask = null;
            if ((b1 & 0x80) != 0) {
                mask = new byte[4];
                readFully(in, mask);
            }
            byte[] payload = new byte[(int) len];
            readFully(in, payload);
            if (mask != null) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

            if (opcode == 0x8) {
                int code = payload.length >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 1005;
                String reason = payload.length > 2 ? new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8) : "";
                if (!closed) send(0x8, payload);
                closed = true;
                notifyClose(code, reason);
                return;
            } else if (opcode == 0x9) {
                send(0xA, payload);
            } else if (opcode == 0xA) {
                // pong
            } else {
                if (opcode != 0) {
                    messageOpcode = opcode;
                    message.reset();
                }
                message.write(payload);
                if (fin) {
                    byte[] data = message.toByteArray();
                    message.reset();
                    if (messageOpcode == 0x1) listener.onText(new String(data, StandardCharsets.UTF_8));
                    else listener.onBinary(data);
                }
            }
        }
    }

    void sendText(String text) {
        send(0x1, text.getBytes(StandardCharsets.UTF_8));
    }

    void sendBinary(byte[] data) {
        send(0x2, data);
    }

    void close(int code, String reason) {
        if (closed) return;
        byte[] r = reason.getBytes(StandardCharsets.UTF_8);
        byte[] payload = new byte[2 + Math.min(r.length, 120)];
        payload[0] = (byte) (code >> 8);
        payload[1] = (byte) code;
        System.arraycopy(r, 0, payload, 2, payload.length - 2);
        send(0x8, payload);
        closed = true;
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
        }
        notifyClose(code, reason);
    }

    private synchronized void send(int opcode, byte[] payload) {
        if (out == null || (closed && opcode != 0x8)) return;
        try {
            ByteArrayOutputStream frame = new ByteArrayOutputStream(payload.length + 14);
            frame.write(0x80 | opcode);
            int len = payload.length;
            if (len < 126) frame.write(0x80 | len);
            else if (len < 65536) {
                frame.write(0x80 | 126);
                frame.write(len >> 8);
                frame.write(len);
            } else {
                frame.write(0x80 | 127);
                for (int i = 7; i >= 0; i--) frame.write((int) ((long) len >> (8 * i)));
            }
            byte[] mask = new byte[4];
            random.nextBytes(mask);
            frame.write(mask);
            byte[] masked = new byte[len];
            for (int i = 0; i < len; i++) masked[i] = (byte) (payload[i] ^ mask[i & 3]);
            frame.write(masked);
            out.write(frame.toByteArray());
            out.flush();
        } catch (IOException e) {
            if (!closed) {
                closed = true;
                listener.onError("发送失败：" + e.getMessage());
                notifyClose(1006, "send failed");
            }
        }
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) throw new IOException("connection closed");
        return b;
    }

    private static void readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new IOException("connection closed");
            off += n;
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') line.write(c);
        }
        if (c < 0 && line.size() == 0) throw new IOException("connection closed during handshake");
        return line.toString(StandardCharsets.UTF_8.name());
    }
}
