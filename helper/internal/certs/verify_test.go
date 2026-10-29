// A chain's verdict and OpenSSL's reason for it, for the chains the plugin's own tests make with openssl (test/unit/
// proxy.ts runs those through the helper end to end): trusted, self-signed whatever the key usage, an authority the
// computer doesn't have, sent along or not, dates, uses, and a certificate signed with the key of one that is no
// authority.
package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"testing"
	"time"
)

type issued struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

var serial int64

// make issues a certificate from template, signed by parent (itself where parent is nil).
func make_(t *testing.T, template *x509.Certificate, parent *issued) issued {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial++
	template.SerialNumber = big.NewInt(serial)
	if template.NotBefore.IsZero() {
		template.NotBefore = time.Now().Add(-time.Hour)
		template.NotAfter = time.Now().Add(48 * time.Hour)
	}
	signer, signerCert := key, template
	if parent != nil {
		signer, signerCert = parent.key, parent.cert
	}
	der, err := x509.CreateCertificate(rand.Reader, template, signerCert, &key.PublicKey, signer)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return issued{cert, key}
}

func authority(t *testing.T, name string, parent *issued) issued {
	return make_(t, &x509.Certificate{
		Subject: pkix.Name{CommonName: name}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}, parent)
}

func server(t *testing.T, name string, parent *issued, tweak func(*x509.Certificate)) issued {
	template := &x509.Certificate{Subject: pkix.Name{CommonName: name}, DNSNames: []string{name}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	if tweak != nil {
		tweak(template)
	}
	return make_(t, template, parent)
}

func rootsOf(t *testing.T, certs ...issued) *Roots {
	var text []byte
	for _, c := range certs {
		text = append(text, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.cert.Raw})...)
	}
	// Something that isn't a certificate among them costs only itself.
	text = append(text, "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n"...)
	roots := ParseRoots(text)
	if len(roots.Certs) != len(certs) {
		t.Fatalf("%d roots read of %d", len(roots.Certs), len(certs))
	}
	return roots
}

func verdict(t *testing.T, roots *Roots, chain ...issued) (bool, string) {
	t.Helper()
	certs := make([]*x509.Certificate, len(chain))
	for i, c := range chain {
		certs[i] = c.cert
	}
	ok, reason, _ := Verify(certs, roots, time.Now())
	return ok, reason
}

func expect(t *testing.T, what string, ok bool, reason string, wantOK bool, wantReason string) {
	t.Helper()
	if ok != wantOK || reason != wantReason {
		t.Errorf("%s: %v %q, want %v %q", what, ok, reason, wantOK, wantReason)
	}
}

func TestVerdicts(t *testing.T) {
	root := authority(t, "trusted root", nil)
	roots := rootsOf(t, root)
	intermediate := authority(t, "trusted issuing", &root)
	stranger := authority(t, "made-up root", nil)
	strangerIssuing := authority(t, "made-up issuing", &stranger)

	ok, reason := verdict(t, roots, server(t, "server.test", &intermediate, nil), intermediate)
	expect(t, "trusted, through an intermediate", ok, reason, true, "")

	selfSigned := server(t, "server.test", nil, func(c *x509.Certificate) { c.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature })
	ok, reason = verdict(t, roots, selfSigned)
	expect(t, "self-signed", ok, reason, false, "DEPTH_ZERO_SELF_SIGNED_CERT")

	// Windows' own: key and data encipherment, which OpenSSL doesn't take for one that issued itself.
	windows := server(t, "server.test", nil, func(c *x509.Certificate) { c.KeyUsage = x509.KeyUsageKeyEncipherment | x509.KeyUsageDataEncipherment })
	ok, reason = verdict(t, roots, windows)
	expect(t, "Windows' own", ok, reason, false, "UNABLE_TO_VERIFY_LEAF_SIGNATURE")

	ok, reason = verdict(t, roots, server(t, "server.test", &stranger, nil))
	expect(t, "an authority not here, not sent", ok, reason, false, "UNABLE_TO_VERIFY_LEAF_SIGNATURE")

	ok, reason = verdict(t, roots, server(t, "server.test", &stranger, nil), stranger)
	expect(t, "an authority not here, sent along", ok, reason, false, "SELF_SIGNED_CERT_IN_CHAIN")

	ok, reason = verdict(t, roots, server(t, "server.test", &strangerIssuing, nil), strangerIssuing)
	expect(t, "an issuer whose own issuer is missing", ok, reason, false, "UNABLE_TO_GET_ISSUER_CERT_LOCALLY")

	expired := server(t, "server.test", &root, func(c *x509.Certificate) {
		c.NotBefore, c.NotAfter = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	})
	ok, reason = verdict(t, roots, expired)
	expect(t, "expired", ok, reason, false, "CERT_HAS_EXPIRED")
	early := server(t, "server.test", &root, func(c *x509.Certificate) {
		c.NotBefore, c.NotAfter = time.Now().Add(24*time.Hour), time.Now().Add(48*time.Hour)
	})
	ok, reason = verdict(t, roots, early)
	expect(t, "not yet valid", ok, reason, false, "CERT_NOT_YET_VALID")

	// The last of OpenSSL's checks that failed: the dates come after the chain.
	strangerExpired := server(t, "server.test", &stranger, func(c *x509.Certificate) {
		c.NotBefore, c.NotAfter = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	})
	ok, reason = verdict(t, roots, strangerExpired, stranger)
	expect(t, "expired, from an authority not here", ok, reason, false, "CERT_HAS_EXPIRED")

	// Marked for other uses than a server's: by the trusted authority, or by one not here (the uses come after the
	// chain in OpenSSL's order).
	clientOnly := func(c *x509.Certificate) { c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth} }
	ok, reason = verdict(t, roots, server(t, "server.test", &root, clientOnly))
	expect(t, "other uses, trusted", ok, reason, false, "INVALID_PURPOSE")
	ok, reason = verdict(t, roots, server(t, "server.test", &stranger, clientOnly), stranger)
	expect(t, "other uses, made up", ok, reason, false, "INVALID_PURPOSE")

	// A key usage that allows neither signatures, key encipherment nor key agreement: Go's verifier takes it, OpenSSL
	// doesn't, so it isn't valid.
	ok, reason = verdict(t, roots, server(t, "server.test", &root, func(c *x509.Certificate) { c.KeyUsage = x509.KeyUsageDataEncipherment }))
	expect(t, "a key usage for no server", ok, reason, false, "INVALID_PURPOSE")

	// Signed with the key of a server's certificate from the trusted authority (no authority itself).
	someServer := server(t, "evil.example", &root, nil)
	forged := server(t, "server.test", &someServer, nil)
	ok, reason = verdict(t, roots, forged, someServer)
	expect(t, "issued by no authority", ok, reason, false, "INVALID_PURPOSE")

	// The trusted root sent along cross-signed by another authority: still the trusted root's.
	oldRoot := authority(t, "old root", nil)
	crossSigned := make_(t, &x509.Certificate{
		Subject: pkix.Name{CommonName: "trusted root"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
		SubjectKeyId: root.cert.SubjectKeyId,
	}, &oldRoot)
	ok, reason = verdict(t, roots, server(t, "server.test", &intermediate, nil), intermediate, crossSigned)
	expect(t, "cross-signed root sent along", ok, reason, true, "")
}

func TestReasonsInOpenSSLOrder(t *testing.T) {
	stranger := authority(t, "made-up root", nil)
	roots := rootsOf(t, authority(t, "trusted root", nil))
	leaf := server(t, "server.test", &stranger, func(c *x509.Certificate) {
		c.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		c.NotBefore, c.NotAfter = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	})
	got := Reasons([]*x509.Certificate{leaf.cert, stranger.cert}, roots, time.Now(), nil)
	want := []string{"SELF_SIGNED_CERT_IN_CHAIN", "INVALID_PURPOSE", "CERT_HAS_EXPIRED"}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%v, want %v", got, want)
		}
	}
}
