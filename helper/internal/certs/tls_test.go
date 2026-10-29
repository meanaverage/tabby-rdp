package certs

import (
	"crypto/tls"
	"strings"
	"testing"
)

func TestClientTLSOnlyOffersForwardSecretTLS12Ciphers(t *testing.T) {
	config := ClientTLS("")
	for _, suite := range config.CipherSuites {
		if !strings.Contains(tls.CipherSuiteName(suite), "_ECDHE_") {
			t.Errorf("TLS 1.2 suite %s has no forward secrecy", tls.CipherSuiteName(suite))
		}
	}
	if config.MaxVersion != 0 {
		t.Errorf("gateway TLS should allow TLS 1.3, max version %x", config.MaxVersion)
	}
	rdp := RDPClientTLS("")
	if rdp.MaxVersion != tls.VersionTLS12 {
		t.Errorf("RDP TLS must stop at TLS 1.2, max version %x", rdp.MaxVersion)
	}
}
