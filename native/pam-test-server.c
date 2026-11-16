/* Synthetic TLS-only cached-bitmap fixture, never authenticates real accounts.
 * Loopback by default; an explicit bind address supports isolated VM-to-VM tests. */
#include <freerdp/freerdp.h>
#include <freerdp/peer.h>
#include <freerdp/primary.h>
#include <freerdp/secondary.h>
#include <freerdp/update.h>
#include <freerdp/settings.h>
#include <freerdp/crypto/certificate.h>
#include <freerdp/crypto/privatekey.h>
#include <freerdp/redirection.h>
#include <winpr/synch.h>
#include <winpr/sysinfo.h>
#include <winpr/ssl.h>
#ifdef _WIN32
#include <winpr/winsock.h>
#define close closesocket
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#endif
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static UINT64 activated;
static BOOL context_new(freerdp_peer* peer, rdpContext* context) { (void)peer; (void)context; return TRUE; }
static BOOL post_connect(freerdp_peer* peer) {
    const char* name = freerdp_settings_get_string(peer->context->settings, FreeRDP_Username);
    printf("{\"event\":\"identity\",\"bracketedUsernamePreserved\":%s}\n",
        name && !strcmp(name, "pam-user[CORP\\vault-account@target-vm]") ? "true" : "false");
    return TRUE;
}
static BOOL activate(freerdp_peer* peer) {
    (void)peer;
    if (!activated) activated = GetTickCount64();
    puts("{\"event\":\"activated\"}");
    return TRUE;
}

static BOOL paint(freerdp_peer* peer, BOOL black) {
    rdpContext* c = peer->context;
    rdpUpdate* u = c->update;
    UINT32 w = freerdp_settings_get_uint32(c->settings, FreeRDP_DesktopWidth);
    UINT32 h = freerdp_settings_get_uint32(c->settings, FreeRDP_DesktopHeight);
    if (!u->BeginPaint(c)) return FALSE;
    OPAQUE_RECT_ORDER rect = { 0 };
    rect.nWidth = w; rect.nHeight = h; rect.color = black ? 0 : 0x00b06020;
    if (!u->primary->OpaqueRect(c, &rect)) return FALSE;
    if (!black) {
        rect.nLeftRect = w / 4; rect.nTopRect = h / 4;
        rect.nWidth = w / 2; rect.nHeight = h / 2; rect.color = 0x0020e080;
        if (!u->primary->OpaqueRect(c, &rect)) return FALSE;
    }
    BOOL ok = u->EndPaint(c);
    printf("{\"event\":\"paint\",\"black\":%s,\"ok\":%s}\n", black ? "true" : "false", ok ? "true" : "false");
    return ok;
}

/* Raw planar encoding inside a compressed Cache Bitmap V2 order. Header bit
 * 0x20 omits the alpha plane; otherwise planes are A,R,G,B. Uniform tiles
 * make orientation irrelevant and keep expected pixel values exact. */
static BOOL bitmap_paint(freerdp_peer* peer, const char* mode) {
    rdpContext* c = peer->context;
    rdpUpdate* u = c->update;
    const UINT32 w = freerdp_settings_get_uint32(c->settings, FreeRDP_DesktopWidth);
    const UINT32 h = freerdp_settings_get_uint32(c->settings, FreeRDP_DesktopHeight);
    BOOL noAlpha = !strcmp(mode, "no-alpha");
    BYTE alpha = !strcmp(mode, "transparent") ? 0 : !strcmp(mode, "partial") ? 127 : 255;
    const BYTE colors[4][3] = {{224,64,224},{32,192,32},{96,224,96},{192,32,192}};
    if (!u->BeginPaint(c)) return FALSE;
    for (UINT32 k = 0; k < 4; k++) {
        BYTE data[1 + 4 * 32 * 32];
        data[0] = noAlpha ? 0x20 : 0;
        size_t off = 1;
        if (!noAlpha) { memset(data + off, alpha, 1024); off += 1024; }
        for (UINT32 p = 0; p < 3; p++) {
            memset(data + off, !strcmp(mode,"black") ? 0 : colors[k][p], 1024);
            off += 1024;
        }
        CACHE_BITMAP_V2_ORDER cache = {0};
        cache.cacheId = 2; cache.cacheIndex = k;
        cache.flags = CBR2_NO_BITMAP_COMPRESSION_HDR;
        cache.bitmapBpp = 32; cache.bitmapWidth = 32; cache.bitmapHeight = 32;
        cache.bitmapLength = (UINT32)off; cache.bitmapDataStream = data;
        cache.compressed = TRUE;
        if (!u->secondary->CacheBitmapV2(c, &cache)) return FALSE;
    }
    for (UINT32 y = 0; y < h; y += 32) for (UINT32 x = 0; x < w; x += 32) {
        MEMBLT_ORDER blt = {0};
        blt.cacheId = 2; blt.cacheIndex = ((x / 32) + (y / 32)) % 4;
        blt.nLeftRect = x; blt.nTopRect = y;
        blt.nWidth = w-x < 32 ? w-x : 32; blt.nHeight = h-y < 32 ? h-y : 32;
        blt.bRop = 0xCC;
        if (!u->primary->MemBlt(c, &blt)) return FALSE;
    }
    BOOL ok = u->EndPaint(c);
    printf("{\"event\":\"bitmap-paint\",\"mode\":\"%s\",\"ok\":%s}\n", mode, ok ? "true":"false");
    return ok;
}

int main(int argc, char** argv) {
    if (argc != 4 && argc != 5) { fprintf(stderr, "usage: redirect-server cert.pem key.pem opaque|transparent|partial|no-alpha|black [bind-address]\n"); return 2; }
    const char* mode = argv[3];
    if (strcmp(mode,"opaque") && strcmp(mode,"transparent") && strcmp(mode,"no-alpha") && strcmp(mode,"black") && strcmp(mode,"partial")) return 2;
    setbuf(stdout, NULL);
#ifdef _WIN32
    WSADATA wsa; if (WSAStartup(MAKEWORD(2,2), &wsa)) return 3;
#else
    signal(SIGPIPE, SIG_IGN);
#endif
    if (!winpr_InitializeSSL(WINPR_SSL_INIT_DEFAULT)) return 3;
    SOCKET server = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = 0 };
    const char* bindAddress = argc == 5 ? argv[4] : "127.0.0.1";
    if (inet_pton(AF_INET, bindAddress, &addr.sin_addr) != 1) return 4;
    if (bind(server, (struct sockaddr*)&addr, sizeof(addr)) || listen(server, 1)) return 4;
    #ifdef _WIN32
    int size = sizeof(addr);
#else
    socklen_t size = sizeof(addr);
#endif
    if (getsockname(server, (struct sockaddr*)&addr, &size)) return 4;
    printf("{\"event\":\"listening\",\"host\":\"%s\",\"port\":%u}\n", bindAddress, ntohs(addr.sin_port));
    SOCKET fd = accept(server, NULL, NULL);
    close(server);
    if (fd == (SOCKET)-1) return 5;
    puts("{\"event\":\"accepted\"}");
    freerdp_peer* peer = freerdp_peer_new((int)fd);
    if (!peer) return 6;
    peer->ContextNew = context_new;
    if (!freerdp_peer_context_new(peer)) return 6;
    rdpSettings* s = peer->context->settings;
    rdpPrivateKey* key = freerdp_key_new_from_file_enc(argv[2], NULL);
    rdpCertificate* cert = freerdp_certificate_new_from_file(argv[1]);
    if (!key || !cert) return 7;
#define BOOLSET(k,v) if (!freerdp_settings_set_bool(s, FreeRDP_##k, v)) return 8
#define NUM(k,v) if (!freerdp_settings_set_uint32(s, FreeRDP_##k, v)) return 8
    if (!freerdp_settings_set_pointer_len(s, FreeRDP_RdpServerRsaKey, key, 1) ||
        !freerdp_settings_set_pointer_len(s, FreeRDP_RdpServerCertificate, cert, 1)) return 8;
    BOOLSET(RdpSecurity, FALSE); BOOLSET(TlsSecurity, TRUE); BOOLSET(NlaSecurity, FALSE); BOOLSET(ExtSecurity, FALSE);
    BOOLSET(RemoteFxCodec, FALSE); BOOLSET(NSCodec, FALSE); BOOLSET(SupportGraphicsPipeline, FALSE);
    BOOLSET(SupportDisplayControl, FALSE); BOOLSET(NetworkAutoDetect, FALSE);
    NUM(ColorDepth, 32); NUM(DesktopWidth, 800); NUM(DesktopHeight, 600);
    peer->Activate = activate;
    peer->PostConnect = post_connect;
    if (!peer->Initialize(peer)) return 9;
    UINT64 start = GetTickCount64();
    BOOL painted = FALSE, black = FALSE, sent = FALSE;
    while (GetTickCount64() - start < 15000) {
        HANDLE events[32]; DWORD count = peer->GetEventHandles(peer, events, 32);
        if (!count || WaitForMultipleObjects(count, events, FALSE, 20) == WAIT_FAILED) break;
        if (!peer->CheckFileDescriptor(peer)) { puts("{\"event\":\"peer-closed\"}"); break; }
        UINT64 elapsed = activated ? GetTickCount64() - activated : 0;
        if (activated && !painted && elapsed >= 200) {
            if (!paint(peer, FALSE)) return 10;
            painted = TRUE;
        }
        if (painted && !black && elapsed >= 900) {
            if (!paint(peer, TRUE)) return 10;
            black = TRUE;
        }
        if (painted && !sent && elapsed >= 1200) {
            if (!bitmap_paint(peer, mode)) return 13;
            sent = TRUE;
        }
    }

    peer->Disconnect(peer);
    freerdp_peer_context_free(peer); freerdp_peer_free(peer);
    puts("{\"event\":\"server-exit\"}");
    return 0;
}
