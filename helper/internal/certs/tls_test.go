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
}
