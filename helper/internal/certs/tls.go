package certs

import (
	"crypto/tls"
	"net"
)

// ClientTLS is the TLS a connection to an RDP server or an RD Gateway uses: TLS 1.2 or 1.3, as Node in Tabby's window
// offered (its minimum is TLS 1.2). Any certificate completes the handshake (RDP servers make their own): the chain is
// checked afterwards (Verify) and the plugin decides on it before anything more is sent. A host name goes as SNI, an
// address doesn't.
//
// TLS 1.2 cipher suites use ECDHE, and TLS 1.3 always has forward secrecy. A server offering only RSA key exchange
// cannot connect: it must not silently remove forward secrecy from an RDP session.
// The key-exchange groups are the classic ones, as Electron's TLS library offers them: no post-quantum hybrid, whose
// larger first message some older servers and middleboxes mishandle.
//
// Unlike Electron's TLS library, Go's doesn't refuse a server certificate whose key usage leaves out digital
// signatures, as Windows' own self-signed RDP certificate does (key and data encipherment only): such servers
// complete the modern handshake, with forward secrecy, where the plugin used to fall back to TLS 1.2 with RSA key
// exchange for them.
func ClientTLS(serverName string) *tls.Config {
	config := &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS12,
		CurvePreferences:   []tls.CurveID{tls.X25519, tls.CurveP256, tls.CurveP384},
		CipherSuites:       cipherSuites,
	}
	if serverName != "" && net.ParseIP(serverName) == nil {
		config.ServerName = serverName
	}
	return config
}

var cipherSuites = []uint16{
	tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
	tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
	tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
	tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
	tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
	tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
	tls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
	tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
	tls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA,
	tls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
}
