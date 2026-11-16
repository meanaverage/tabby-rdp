/* Exercises the actual helper callbacks without an RDP server. */
#define main helper_main
#include "main.c"
#undef main
#undef NDEBUG
#include <assert.h>
static UINT32 offered, requested, requests, responseFlags, responseBytes;
static unsigned file_acks(FILE* file, UINT32 generation, BOOL ok) {
    fflush(file); rewind(file);
    BYTE header[5], data[5]; unsigned count = 0;
    while (fread(header, 1, 5, file) == 5) {
        UINT32 length = read32(header + 1);
        if (header[0] == 'a') {
            assert(length == 5 && fread(data, 1, 5, file) == 5);
            assert(read32(data) == generation && data[4] == (ok ? 1 : 0)); count++;
        } else assert(fseek(file, length, SEEK_CUR) == 0);
    }
    clearerr(file); fseek(file, 0, SEEK_END);
    return count;
}
static UINT capture_offer(CliprdrClientContext* clip, const CLIPRDR_FORMAT_LIST* list) {
    (void)clip; offered = list->numFormats ? list->formats[0].formatId : 0;
    if (offered == FILE_FORMAT) assert(strcmp(list->formats[0].formatName, "FileGroupDescriptorW") == 0);
    return CHANNEL_RC_OK;
}
static UINT capture_request(CliprdrClientContext* clip, const CLIPRDR_FORMAT_DATA_REQUEST* request) {
    (void)clip; requested = request->requestedFormatId; requests++; return CHANNEL_RC_OK;
}
static UINT capture_ack(CliprdrClientContext* clip, const CLIPRDR_FORMAT_LIST_RESPONSE* response) {
    (void)clip; assert(response->common.msgFlags == CB_RESPONSE_OK); return CHANNEL_RC_OK;
}
static UINT capture_data(CliprdrClientContext* clip, const CLIPRDR_FORMAT_DATA_RESPONSE* response) {
    (void)clip; responseFlags = response->common.msgFlags; responseBytes = response->common.dataLen; return CHANNEL_RC_OK;
}
static UINT capture_file(CliprdrClientContext* clip, const CLIPRDR_FILE_CONTENTS_RESPONSE* response) {
    (void)clip; responseFlags = response->common.msgFlags; responseBytes = response->cbRequested; return CHANNEL_RC_OK;
}
static UINT capture_file_request(CliprdrClientContext* clip, const CLIPRDR_FILE_CONTENTS_REQUEST* request) {
    (void)clip; assert(request->cbRequested <= MAX_FILE_DATA); requests++; return CHANNEL_RC_OK;
}
static UINT capture_caps(CliprdrClientContext* clip, const CLIPRDR_CAPABILITIES* caps) {
    (void)clip;
    const CLIPRDR_GENERAL_CAPABILITY_SET* general = (const void*)caps->capabilitySets;
    assert(general->generalFlags & CB_STREAM_FILECLIP_ENABLED);
    assert(!(general->generalFlags & CB_CAN_LOCK_CLIPDATA));
    return CHANNEL_RC_OK;
}
int main(void) {
    FILE* outputFile = freopen("clipboard-test.ipc", "w+b", stdout);
    assert(outputFile);
    Context c = { 0 };
    InitializeCriticalSection(&c.clipboardLock); InitializeCriticalSection(&c.offerLock); InitializeCriticalSection(&c.outputLock);
    c.clipboard = CLIPBOARD_TO_REMOTE | CLIPBOARD_FROM_REMOTE;
    CliprdrClientContext clip = { 0 };
    clip.custom = &c; c.cliprdr = &clip;
    clip.ClientCapabilities = capture_caps; clip.ClientFormatList = capture_offer;
    clip.ClientFormatDataRequest = capture_request; clip.ClientFormatListResponse = capture_ack;
    clip.ClientFormatDataResponse = capture_data; clip.ClientFileContentsResponse = capture_file;
    clip.ClientFileContentsRequest = capture_file_request;
    BYTE files[600] = { 0 }; write32(files, 7); files[4] = 1; /* one FILEDESCRIPTORW */
    Command offer = { 'o', sizeof(files), files, NULL };
    clipboard_file_command(&c, &offer); /* Not ready: fail immediately, keep the existing text. */
    assert(file_acks(outputFile, 7, FALSE) == 1);
    set_local_text(&c, (const BYTE*)"text", 4);
    c.clipboardReady = TRUE; /* Ready without file-streaming capability. */
    clipboard_file_command(&c, &offer);
    assert(c.localText && c.localTextLength == 4 && !c.localFiles);
    assert(file_acks(outputFile, 7, FALSE) == 2);
    c.clipboardReady = FALSE;
    CLIPRDR_GENERAL_CAPABILITY_SET general = { CB_CAPSTYPE_GENERAL, 12, CB_CAPS_VERSION_2, CB_STREAM_FILECLIP_ENABLED };
    CLIPRDR_CAPABILITIES caps = { 0 }; caps.cCapabilitiesSets = 1; caps.capabilitySets = (void*)&general;
    assert(clipboard_server_capabilities(&clip, &caps) == CHANNEL_RC_OK);
    assert(clipboard_monitor_ready(&clip, NULL) == CHANNEL_RC_OK);
    assert(c.fileStreaming && offered == CF_UNICODETEXT);
    clipboard_file_command(&c, &offer);
    assert(offered == CF_UNICODETEXT && c.offerPending && c.offerAgain);
    CLIPRDR_FORMAT_LIST_RESPONSE offerResponse = { 0 };
    offerResponse.common.msgFlags = CB_RESPONSE_FAIL;
    assert(clipboard_server_format_list_response(&clip, &offerResponse) == CHANNEL_RC_OK);
    /* A delayed rejection of text cannot reject the new file offer. */
    assert(file_acks(outputFile, 7, FALSE) == 2);
    assert(offered == FILE_FORMAT && c.localGeneration == 7);
    /* rdpclip restarts before answering: MonitorReady must start a fresh announcement. */
    assert(c.offerPending);
    offered = 0;
    assert(clipboard_monitor_ready(&clip, NULL) == CHANNEL_RC_OK);
    assert(offered == FILE_FORMAT && c.offerPending && !c.offerAgain);
    offerResponse.common.msgFlags = CB_RESPONSE_OK;
    assert(clipboard_server_format_list_response(&clip, &offerResponse) == CHANNEL_RC_OK);
    assert(!c.offerPending);
    fflush(outputFile); assert(fseek(outputFile, -10, SEEK_END) == 0);
    BYTE accepted[10]; assert(fread(accepted, 1, 10, outputFile) == 10);
    assert(accepted[0] == 'a' && read32(accepted + 1) == 5 && read32(accepted + 5) == 7 && accepted[9] == 1);
    fseek(outputFile, 0, SEEK_END);
    CLIPRDR_FORMAT_DATA_REQUEST dataRequest = { 0 }; dataRequest.requestedFormatId = FILE_FORMAT;
    assert(clipboard_server_data_request(&clip, &dataRequest) == CHANNEL_RC_OK);
    assert(responseFlags == CB_RESPONSE_OK && responseBytes == 596);
    BYTE content[15] = { 0 }; write32(content, 7); write32(content + 4, 10); memcpy(content + 12, "abc", 3);
    Command answer = { 's', sizeof(content), content, NULL };
    clipboard_file_command(&c, &answer);
    assert(responseFlags == CB_RESPONSE_OK && responseBytes == 3);
    write32(content, 6); clipboard_file_command(&c, &answer);
    assert(responseFlags == CB_RESPONSE_FAIL && responseBytes == 0);
    set_local_text(&c, (const BYTE*)"text", 4); assert(!c.localFiles);
    assert(clipboard_offer(&c) == CHANNEL_RC_OK && offered == CF_UNICODETEXT);
    assert(clipboard_server_data_request(&clip, &dataRequest) == CHANNEL_RC_OK && responseFlags == CB_RESPONSE_FAIL);
    /* The first descriptor response arrives after a new text clipboard. It must not be decoded as text. */
    CLIPRDR_FORMAT format = { 500, "FileGroupDescriptorW" };
    CLIPRDR_FORMAT_LIST list = { 0 }; list.numFormats = 1; list.formats = &format;
    assert(clipboard_server_format_list(&clip, &list) == CHANNEL_RC_OK);
    assert(requested == 500 && requests == 1 && c.requestedFiles);
    format.formatId = CF_UNICODETEXT; format.formatName = NULL;
    assert(clipboard_server_format_list(&clip, &list) == CHANNEL_RC_OK);
    assert(requests == 1);
    CLIPRDR_FORMAT_DATA_RESPONSE response = { 0 };
    response.common.msgFlags = CB_RESPONSE_OK; response.common.dataLen = sizeof(files) - 4; response.requestedFormatData = files + 4;
    assert(clipboard_server_data_response(&clip, &response) == CHANNEL_RC_OK);
    assert(requested == CF_UNICODETEXT && requests == 2 && !c.requestedFiles);
    BYTE requestData[28] = { 0 }; write32(requestData, c.remoteGeneration - 1); write32(requestData + 12, FILECONTENTS_SIZE); write32(requestData + 24, 8);
    Command request = { 'q', sizeof(requestData), requestData, NULL };
    clipboard_file_command(&c, &request); assert(requests == 2);
    write32(requestData, c.remoteGeneration); clipboard_file_command(&c, &request); assert(requests == 3);
    c.clipboard = 0;
    clipboard_file_command(&c, &request); assert(requests == 3);
    assert(clipboard_server_data_request(&clip, &dataRequest) == CHANNEL_RC_OK && responseFlags == CB_RESPONSE_FAIL);
    CLIPRDR_FILE_CONTENTS_REQUEST incoming = { 0 }; incoming.dwFlags = FILECONTENTS_RANGE; incoming.cbRequested = MAX_FILE_DATA + 1;
    assert(clipboard_server_file_request(&clip, &incoming) == CHANNEL_RC_OK && responseFlags == CB_RESPONSE_FAIL);
    set_local_text(&c, NULL, 0);
    fclose(outputFile); remove("clipboard-test.ipc");
    fprintf(stderr, "Clipboard callback checks passed\n");
    return 0;
}
