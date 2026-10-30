/* SPDX-License-Identifier: MIT
 * A windowless FreeRDP client. Only framed IPC goes to stdout. Credentials arrive on stdin,
 * never in argv, the environment, a temporary file, or FreeRDP's log output.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <limits.h>
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/disp.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/transport_io.h>
#include <freerdp/version.h>
#include <winpr/synch.h>
#include <winpr/asn1.h>
#include <winpr/thread.h>
#include <winpr/winsock.h>
#include <winpr/wlog.h>
#include <openssl/pem.h>
#include <openssl/x509v3.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#else
#include <signal.h>
#endif

#define MAX_COMMAND (1024 * 1024)
#define MAX_AUTHORITIES (16 * 1024 * 1024)
#define MAX_QUEUE 1024
typedef struct Command { BYTE type; UINT32 length; BYTE* data; struct Command* next; } Command;
typedef struct {
    rdpClientContext client;
    rdpTransportIo original;
    char* token;
    char* authorities;
    char* name;
    UINT32 port;
    DispClientContext* disp;
    HANDLE inputEvent;
    HANDLE inputSpace;
    CRITICAL_SECTION inputLock;
    CRITICAL_SECTION outputLock;
    Command* first;
    Command* last;
    unsigned queued;
    BOOL inputEnded;
    BOOL inputFailed;
    BOOL displayReady;
    BOOL needCredSSPVersion;
    UINT32 width, height, scale;
} Context;

static UINT32 read32(const BYTE* p) { return ((UINT32)p[0] << 24) | ((UINT32)p[1] << 16) | ((UINT32)p[2] << 8) | p[3]; }
static void write32(BYTE* p, UINT32 n) { p[0] = n >> 24; p[1] = n >> 16; p[2] = n >> 8; p[3] = n; }
static BOOL exact(void* p, size_t n) { return fread(p, 1, n, stdin) == n; }
static void free_command(Command* c) { if (c) { if (c->data) { memset(c->data, 0, c->length); free(c->data); } free(c); } }
static Command* read_command(void) {
    BYTE header[5];
    if (!exact(header, sizeof(header))) return NULL;
    UINT32 n = read32(header + 1);
    if (n > MAX_COMMAND) return NULL;
    Command* c = calloc(1, sizeof(*c));
    if (!c) return NULL;
    c->type = header[0]; c->length = n;
    c->data = calloc((size_t)n + 1, 1);
    if (!c->data || !exact(c->data, n)) { free_command(c); return NULL; }
    return c;
}
static BOOL output(Context* c, BYTE type, const void* data, UINT32 n) {
    BYTE header[5]; header[0] = type; write32(header + 1, n);
    EnterCriticalSection(&c->outputLock);
    BOOL ok = fwrite(header, 1, 5, stdout) == 5 && (!n || fwrite(data, 1, n, stdout) == n) && fflush(stdout) == 0;
    LeaveCriticalSection(&c->outputLock);
    return ok;
}
static BOOL decision(Context* c, BYTE type, const void* p, UINT32 n) {
    if (!output(c, type, p, n)) return FALSE;
    Command* answer = read_command();
    BOOL ok = answer && answer->type == type && answer->length == 1 && answer->data[0] == 1;
    free_command(answer);
    return ok;
}
static char* string_field(const BYTE** p, UINT32* left) {
    if (*left < 4) return NULL;
    UINT32 n = read32(*p); *p += 4; *left -= 4;
    if (n > *left || memchr(*p, 0, n)) return NULL;
    char* s = calloc((size_t)n + 1, 1);
    if (!s) return NULL;
    memcpy(s, *p, n); *p += n; *left -= n;
    return s;
}

/* The only TCP destination is the authenticated relay supplied by the parent. Keep the real server name in
 * settings for CredSSP/SPN and certificate validation. Redirects cannot redirect credentials to another server. */
static int tcp_connect(rdpContext* base, rdpSettings* s, const char* host, int port, DWORD timeout) {
    Context* c = (Context*)base;
    (void)host; (void)port;
    int fd = c->original.TCPConnect(base, s, "127.0.0.1", (int)c->port, timeout);
    if (fd < 0) return fd;
    size_t remaining = strlen(c->token), at = 0;
    while (remaining) {
        int sent = send(fd, c->token + at, (int)remaining, 0);
        if (sent <= 0) { closesocket(fd); return -1; }
        at += (size_t)sent; remaining -= (size_t)sent;
    }
    return fd;
}
static BOOL tls_connect(rdpTransport* transport) {
    rdpContext* base = transport_get_context(transport);
    Context* c = (Context*)base;
    UINT32 protocol = freerdp_settings_get_uint32(base->settings, FreeRDP_SelectedProtocol);
    /* PROTOCOL_HYBRID / PROTOCOL_HYBRID_EX: otherwise stop before TLS and any clear-password sign-in. */
    if (!(protocol & (2 | 8)) && !decision(c, 'N', NULL, 0)) return FALSE;
    c->needCredSSPVersion = (protocol & (2 | 8)) != 0;
    return c->original.TLSConnect(transport);
}

static int read_pdu(rdpTransport* transport, wStream* s) {
    rdpContext* base = transport_get_context(transport);
    Context* c = (Context*)base;
    int status = c->original.ReadPdu(transport, s);
    if (status <= 0 || !c->needCredSSPVersion) return status;
    /* Match IronRDP's policy: reject pre-CVE-2018-0886 binding before NLA can produce AUTHENTICATE/pubKeyAuth.
     * ReadPdu supplies a complete first TSRequest. Decode with WinPR, without moving the upstream stream cursor.
     * FreeRDP itself rejects any later change from this first peer version. */
    WinPrAsn1Decoder dec = WinPrAsn1Decoder_init(), sequence = WinPrAsn1Decoder_init();
    WinPrAsn1_INTEGER version = 0;
    BOOL error = FALSE;
    WinPrAsn1Decoder_InitMem(&dec, WINPR_ASN1_DER, Stream_Buffer(s), (size_t)status);
    if (!WinPrAsn1DecReadSequence(&dec, &sequence) ||
        !WinPrAsn1DecReadContextualInteger(&sequence, 0, &error, &version) || error || version < 5) {
        freerdp_set_last_error(base, FREERDP_ERROR_SECURITY_NEGO_CONNECT_FAILED);
        return -1;
    }
    c->needCredSSPVersion = FALSE;
    return status;
}

static int verify_certificate(freerdp* instance, const BYTE* data, size_t length, const char* host, UINT16 port, DWORD flags) {
    Context* c = (Context*)instance->context;
    (void)host; (void)port;
    if ((flags & (VERIFY_CERT_FLAG_GATEWAY | VERIFY_CERT_FLAG_REDIRECT)) || length > MAX_COMMAND - 1024) return 0;
    X509_STORE* store = X509_STORE_new();
    X509_STORE_CTX* verify = X509_STORE_CTX_new();
    STACK_OF(X509)* chain = sk_X509_new_null();
    BIO* ca = BIO_new_mem_buf(c->authorities, -1);
    BIO* peer = BIO_new_mem_buf(data, (int)length);
    X509* leaf = peer ? PEM_read_bio_X509(peer, NULL, NULL, NULL) : NULL;
    BOOL valid = FALSE;
    const char* reason = "Certificate could not be verified";
    if (store && verify && chain && ca && leaf) {
        X509* cert;
        while ((cert = PEM_read_bio_X509(ca, NULL, NULL, NULL))) { (void)X509_STORE_add_cert(store, cert); X509_free(cert); }
        while ((cert = PEM_read_bio_X509(peer, NULL, NULL, NULL))) { if (!sk_X509_push(chain, cert)) X509_free(cert); }
        if (X509_STORE_CTX_init(verify, store, leaf, chain)) {
            X509_VERIFY_PARAM* param = X509_STORE_CTX_get0_param(verify);
            BOOL purpose = X509_VERIFY_PARAM_set_purpose(param, X509_PURPOSE_SSL_SERVER) == 1;
            BOOL named = *c->name && (X509_VERIFY_PARAM_set1_ip_asc(param, c->name) == 1 ||
                                      X509_VERIFY_PARAM_set1_host(param, c->name, 0) == 1);
            if (purpose && named) {
                valid = X509_verify_cert(verify) == 1;
                reason = X509_verify_cert_error_string(X509_STORE_CTX_get_error(verify));
            } else reason = "Invalid server name or certificate purpose";
        }
    }
    size_t rn = strlen(reason);
    BYTE* payload = malloc(8 + rn + length);
    BOOL accepted = FALSE;
    if (payload) {
        write32(payload, valid ? 1 : 0); write32(payload + 4, (UINT32)rn);
        memcpy(payload + 8, reason, rn); memcpy(payload + 8 + rn, data, length);
        accepted = decision(c, 'C', payload, (UINT32)(8 + rn + length));
        free(payload);
    }
    X509_free(leaf); BIO_free(peer); BIO_free(ca); sk_X509_pop_free(chain, X509_free);
    X509_STORE_CTX_free(verify); X509_STORE_free(store);
    return accepted ? 2 : 0;
}
static BOOL redirect(freerdp* instance) { (void)instance; return FALSE; }
static BOOL authenticate(freerdp* instance, char** u, char** p, char** d, rdp_auth_reason reason) {
    (void)instance; (void)u; (void)p; (void)d; (void)reason;
    return FALSE; /* All credential prompts belong to the parent. */
}
static BOOL begin_paint(rdpContext* base) {
    base->gdi->primary->hdc->hwnd->invalid->null = TRUE;
    base->gdi->primary->hdc->hwnd->ninvalid = 0;
    return TRUE;
}
static BOOL end_paint(rdpContext* base) {
    Context* c = (Context*)base;
    rdpGdi* g = base->gdi;
    HGDI_RGN dirty = g->primary->hdc->hwnd->invalid;
    if (dirty->null) return TRUE;
    int left = dirty->x < 0 ? 0 : dirty->x, top = dirty->y < 0 ? 0 : dirty->y;
    int right = dirty->x + dirty->w, bottom = dirty->y + dirty->h;
    if (right > g->width) right = g->width;
    if (bottom > g->height) bottom = g->height;
    /* Tiles bound memory and avoid copying an entire high-resolution screen for a small update. */
    BYTE* tile = malloc(24 + 256 * 256 * 4);
    if (!tile) return FALSE;
    for (int y = top; y < bottom; y += 256) for (int x = left; x < right; x += 256) {
        int w = right - x < 256 ? right - x : 256, h = bottom - y < 256 ? bottom - y : 256;
        write32(tile, x); write32(tile + 4, y); write32(tile + 8, w); write32(tile + 12, h);
        write32(tile + 16, g->width); write32(tile + 20, g->height);
        for (int row = 0; row < h; row++) memcpy(tile + 24 + row * w * 4, g->primary_buffer + (y + row) * g->stride + x * 4, (size_t)w * 4);
        if (!output(c, 'F', tile, (UINT32)(24 + w * h * 4))) { free(tile); return FALSE; }
    }
    free(tile); return output(c, 'B', NULL, 0);
}
static BOOL desktop_resize(rdpContext* base) {
    UINT32 w = freerdp_settings_get_uint32(base->settings, FreeRDP_DesktopWidth);
    UINT32 h = freerdp_settings_get_uint32(base->settings, FreeRDP_DesktopHeight);
    if (w < 200 || w > 7680 || h < 200 || h > 4320) return FALSE;
    return gdi_resize(base->gdi, w, h);
}
static UINT send_layout(Context* c) {
    if (!c->disp || !c->displayReady || !c->width) return 0;
    DISPLAY_CONTROL_MONITOR_LAYOUT monitor = { 0 };
    monitor.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY; monitor.Width = c->width; monitor.Height = c->height;
    monitor.PhysicalWidth = c->width * 254 / 960; monitor.PhysicalHeight = c->height * 254 / 960;
    monitor.DesktopScaleFactor = c->scale; monitor.DeviceScaleFactor = 100;
    return c->disp->SendMonitorLayout(c->disp, 1, &monitor);
}
static UINT display_caps(DispClientContext* disp, UINT32 monitors, UINT32 a, UINT32 b) {
    (void)monitors; (void)a; (void)b;
    Context* c = disp->custom; c->displayReady = TRUE;
    return send_layout(c);
}
static void channel_connected(void* context, const ChannelConnectedEventArgs* e) {
    Context* c = context;
    if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        c->disp = e->pInterface; c->disp->custom = c; c->disp->DisplayControlCaps = display_caps;
    }
    else freerdp_client_OnChannelConnectedEventHandler(&c->client, e);
}
static void channel_disconnected(void* context, const ChannelDisconnectedEventArgs* e) {
    Context* c = context;
    if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) { c->disp = NULL; c->displayReady = FALSE; }
    else freerdp_client_OnChannelDisconnectedEventHandler(&c->client, e);
}
static BOOL pre_connect(freerdp* instance) {
    rdpContext* base = instance->context;
    if (PubSub_SubscribeChannelConnected(base->pubSub, channel_connected) < 0 ||
        PubSub_SubscribeChannelDisconnected(base->pubSub, channel_disconnected) < 0) return FALSE;
    return TRUE;
}
static BOOL post_connect(freerdp* instance) {
    UINT32 width = freerdp_settings_get_uint32(instance->context->settings, FreeRDP_DesktopWidth);
    UINT32 height = freerdp_settings_get_uint32(instance->context->settings, FreeRDP_DesktopHeight);
    if (width < 200 || width > 7680 || height < 200 || height > 4320) return FALSE;
    if (!gdi_init(instance, PIXEL_FORMAT_RGBA32)) return FALSE;
    instance->context->update->BeginPaint = begin_paint;
    instance->context->update->EndPaint = end_paint;
    instance->context->update->DesktopResize = desktop_resize;
    return TRUE;
}
static DWORD WINAPI input_thread(LPVOID arg) {
    Context* c = arg;
    Command* cmd;
    while ((cmd = read_command())) {
        EnterCriticalSection(&c->inputLock);
        /* A blocked server/renderer must not turn a full queue into a normal session end. Stop reading the
         * pipe until the main loop drains it; the parent's bounded pipe queue still detects a prolonged stall. */
        while (c->queued >= MAX_QUEUE) {
            LeaveCriticalSection(&c->inputLock);
            if (WaitForSingleObject(c->inputSpace, INFINITE) != WAIT_OBJECT_0) {
                EnterCriticalSection(&c->inputLock); c->inputFailed = TRUE; c->inputEnded = TRUE;
                SetEvent(c->inputEvent); LeaveCriticalSection(&c->inputLock); free_command(cmd); return 1;
            }
            EnterCriticalSection(&c->inputLock);
        }
        /* Only consecutive pure moves are interchangeable. Never discard button, wheel or keyboard ordering. */
        if (cmd->type == 'M' && cmd->length == 12 && read32(cmd->data) == PTR_FLAGS_MOVE &&
            c->last && c->last->type == 'M' && c->last->length == 12 && read32(c->last->data) == PTR_FLAGS_MOVE) {
            memcpy(c->last->data, cmd->data, 12);
            LeaveCriticalSection(&c->inputLock); free_command(cmd); continue;
        }
        if (c->last) c->last->next = cmd; else c->first = cmd;
        c->last = cmd; c->queued++;
        SetEvent(c->inputEvent);
        LeaveCriticalSection(&c->inputLock);
    }
    EnterCriticalSection(&c->inputLock); c->inputEnded = TRUE; SetEvent(c->inputEvent); LeaveCriticalSection(&c->inputLock);
    return 0;
}
static BOOL process_input(Context* c) {
    EnterCriticalSection(&c->inputLock);
    Command* cmd = c->first;
    c->first = c->last = NULL; c->queued = 0;
    SetEvent(c->inputSpace);
    BOOL ended = c->inputEnded;
    ResetEvent(c->inputEvent);
    LeaveCriticalSection(&c->inputLock);
    rdpContext* base = &c->client.context;
    while (cmd) {
        Command* next = cmd->next;
        BYTE* p = cmd->data;
        if (cmd->type == 'K' && cmd->length == 12) {
            UINT32 flags = read32(p), scan = read32(p + 4), unicode = read32(p + 8);
            if (unicode) (void)freerdp_input_send_unicode_keyboard_event(base->input, (UINT16)flags, (UINT16)unicode);
            else if (scan == RDP_SCANCODE_PAUSE) {
                if (!(flags & KBD_FLAGS_RELEASE)) (void)freerdp_input_send_keyboard_pause_event(base->input);
            }
            else (void)freerdp_input_send_keyboard_event_ex(base->input, (flags & KBD_FLAGS_RELEASE) == 0, FALSE, scan);
        } else if (cmd->type == 'M' && cmd->length == 12) {
            (void)freerdp_input_send_mouse_event(base->input, (UINT16)read32(p), (UINT16)read32(p + 4), (UINT16)read32(p + 8));
        } else if (cmd->type == 'R' && cmd->length == 12) {
            UINT32 w = read32(p), h = read32(p + 4), scale = read32(p + 8);
            if (w >= 200 && w <= 7680 && h >= 200 && h <= 4320 && scale >= 100 && scale <= 500) {
                c->width = w; c->height = h; c->scale = scale;
                (void)send_layout(c);
            }
        } else ended = TRUE;
        free_command(cmd); cmd = next;
    }
    return !ended;
}
int main(int argc, char** argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) { printf("tabby-freerdp IPC 5; FreeRDP %s\n", FREERDP_VERSION_FULL); return 0; }
    if (argc != 1) return 2;
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
    WSADATA sockets;
    if (WSAStartup(MAKEWORD(2, 2), &sockets) != 0) return 1;
#else
    signal(SIGPIPE, SIG_IGN);
#endif
    /* FreeRDP diagnostics must never corrupt stdout or expose settings/credentials. Errors use numeric IPC below. */
    WLog_SetLogLevel(WLog_GetRoot(), WLOG_OFF);
    freerdp* instance = freerdp_new();
    if (!instance) return 1;
    instance->ContextSize = sizeof(Context);
    if (!freerdp_context_new(instance)) { freerdp_free(instance); return 1; }
    Context* c = (Context*)instance->context;
    InitializeCriticalSection(&c->inputLock); InitializeCriticalSection(&c->outputLock);
    c->inputEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
    c->inputSpace = CreateEvent(NULL, FALSE, FALSE, NULL);
    if (!c->inputEvent || !c->inputSpace) return 1;
    char* authorities = NULL;
    size_t authorityLength = 0;
    Command* start = read_command();
    while (start && start->type == 'A') {
        if (!start->length || start->length > MAX_AUTHORITIES - authorityLength || memchr(start->data, 0, start->length)) return 2;
        char* expanded = realloc(authorities, authorityLength + start->length + 1);
        if (!expanded) return 2;
        authorities = expanded;
        memcpy(authorities + authorityLength, start->data, start->length);
        authorityLength += start->length; authorities[authorityLength] = 0;
        free_command(start); start = read_command();
    }
    if (!start || start->type != 'S') return 2;
    const BYTE* p = start->data; UINT32 left = start->length;
    char* fields[6] = { 0 };
    for (int i = 0; i < 6; i++) if (!(fields[i] = string_field(&p, &left))) return 2;
    if (left != 32) return 2;
    if (authorities && *fields[4]) return 2;
    c->name = fields[0]; c->authorities = authorities ? authorities : fields[4]; c->token = fields[5]; c->port = read32(p);
    if (authorities) free(fields[4]);
    UINT32 w = read32(p + 4), h = read32(p + 8), gfx = read32(p + 12), autologon = read32(p + 16), relaxOrderChecks = read32(p + 20);
    UINT32 glyphCache = read32(p + 24), bitmapCache = read32(p + 28);
    if (!c->inputEvent || !c->port || c->port > 65535 || strlen(c->token) != 64 || w < 200 || w > 7680 || h < 200 || h > 4320) return 2;
    rdpSettings* s = instance->context->settings;
#define STR(key, value) if (!freerdp_settings_set_string(s, FreeRDP_##key, value)) return 2
#define NUM(key, value) if (!freerdp_settings_set_uint32(s, FreeRDP_##key, value)) return 2
#define BOOLSET(key, value) if (!freerdp_settings_set_bool(s, FreeRDP_##key, value)) return 2
    STR(ServerHostname, fields[0]); STR(Username, fields[1]); STR(Password, fields[2]); STR(Domain, fields[3]);
    NUM(ServerPort, 3389); NUM(DesktopWidth, w); NUM(DesktopHeight, h); NUM(ColorDepth, 32);
    NUM(TcpConnectTimeout, 15000);
    /* X.224 is sent before the certificate: never put the sign-in name in its routing cookie. */
    BOOLSET(MstscCookieMode, FALSE); NUM(CookieMaxLength, 0);
    BOOLSET(ExternalCertificateManagement, TRUE); BOOLSET(NlaSecurity, TRUE); BOOLSET(TlsSecurity, TRUE);
    BOOLSET(RdpSecurity, FALSE); BOOLSET(NegotiateSecurityLayer, TRUE); BOOLSET(Authentication, TRUE);
    BOOLSET(AutoLogonEnabled, autologon != 0);
    BOOLSET(AllowUnanouncedOrdersFromServer, relaxOrderChecks != 0);
    /* Glyph decoding is independent of accepting orders the client did not announce. */
    NUM(GlyphSupportLevel, glyphCache ? GLYPH_SUPPORT_FULL : GLYPH_SUPPORT_NONE);
    /* Announces MemBlt/Mem3Blt with FreeRDP's default bitmap cache cells (xfreerdp's +bitmap-cache). Cache Bitmap V3
     * goes with it: offered the bitmap codecs below and MemBlt without it, Windows 11 closed the connection as soon as
     * the session started. */
    BOOLSET(BitmapCacheEnabled, bitmapCache != 0); BOOLSET(BitmapCacheV3Enabled, bitmapCache != 0);
    BOOLSET(AutoReconnectionEnabled, FALSE); /* The parent owns retries and their fresh native processes. */
    BOOLSET(SupportDisplayControl, TRUE); BOOLSET(DynamicResolutionUpdate, TRUE);
    BOOLSET(SupportGraphicsPipeline, gfx != 0); BOOLSET(GfxH264, FALSE); BOOLSET(GfxAVC444, FALSE);
    BOOLSET(NSCodec, TRUE); BOOLSET(RemoteFxCodec, TRUE);
    BOOLSET(RedirectClipboard, FALSE); BOOLSET(AudioPlayback, FALSE); BOOLSET(DeviceRedirection, FALSE);
    BOOLSET(SupportMultitransport, FALSE); /* The parent supplies one authenticated TCP transport. */
    for (int i = 1; i <= 3; i++) { memset(fields[i], 0, strlen(fields[i])); free(fields[i]); }
    free_command(start);
    c->original = *freerdp_get_io_callbacks(instance->context);
    rdpTransportIo io = c->original; io.TCPConnect = tcp_connect; io.TLSConnect = tls_connect; io.ReadPdu = read_pdu;
    if (!freerdp_set_io_callbacks(instance->context, &io)) return 2;
    instance->PreConnect = pre_connect; instance->PostConnect = post_connect;
    /* FreeRDP replaces the channel collection after PreConnect. Load addins on the replacement, not the old one. */
    instance->LoadChannels = freerdp_client_load_channels;
    instance->VerifyX509Certificate = verify_certificate; instance->AuthenticateEx = authenticate; instance->Redirect = redirect;
    freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0);
    BOOL connected = freerdp_connect(instance);
    HANDLE reader = NULL;
    if (connected) {
        BYTE size[8]; write32(size, instance->context->gdi->width); write32(size + 4, instance->context->gdi->height);
        if (!output(c, 'D', size, 8)) return 1;
        reader = CreateThread(NULL, 0, input_thread, c, 0, NULL);
        while (reader && !freerdp_shall_disconnect_context(instance->context)) {
            HANDLE events[64]; events[0] = c->inputEvent;
            DWORD count = freerdp_get_event_handles(instance->context, events + 1, 63);
            if (!count || WaitForMultipleObjects(count + 1, events, FALSE, 1000) == WAIT_FAILED) break;
            if (!process_input(c) || !freerdp_check_event_handles(instance->context)) break;
        }
    }
    UINT32 error = freerdp_get_last_error(instance->context);
    EnterCriticalSection(&c->inputLock);
    if (c->inputFailed && !error) error = FREERDP_ERROR_CONNECT_TRANSPORT_FAILED;
    LeaveCriticalSection(&c->inputLock);
    BYTE result[8]; write32(result, error); write32(result + 4, freerdp_error_info(instance));
    (void)output(c, connected ? 'X' : 'E', result, 8);
    /* The stdin reader may be waiting on its pipe; the parent closes it and reaps this process. Exiting releases all
     * native resources together, avoiding a worker accessing a freed context during teardown. */
    (void)reader;
    return connected ? 0 : 1;
}
