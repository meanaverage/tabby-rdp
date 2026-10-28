// Package certs checks a server's certificate chain against the certificate authorities the plugin gives the helper:
// the ones Node.js in Tabby's window would check it against (its own list and this computer's store), so that what
// counts as an authority's word is the same as before the helper. Only the chain is checked here; whether the
// certificate is for the server's name, the plugin checks with Node's own rule (tls.checkServerIdentity), as Node
// checks it once the chain has passed.
//
// A chain is valid only where Go's verifier takes it and its certificate may serve a server by its key usage, as
// OpenSSL also requires: where Go's verifier and OpenSSL differ, the stricter one decides (Go refuses SHA-1
// signatures, for one), so a certificate is asked about rather than trusted.
//
// The reason one isn't valid is OpenSSL's, as Node reported it (TLSSocket.authorizationError), for the plugin's
// account of why a certificate isn't valid (src/authorities.ts): OpenSSL goes on through all of its checks and
// reports the last that failed (Node's verify callback lets it), in its own order: the chain to an authority, each
// certificate's extensions (an issuer that is no authority, uses other than a server's), then signatures and dates
// from the authority down, then name constraints. Reason works the same out here.
package certs

import (
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"time"
)

// Roots are the certificate authorities: a pool for Go's verifier, and a list to find an issuer in by name.
type Roots struct {
	Pool  *x509.CertPool
	Certs []*x509.Certificate
}

// ParseRoots reads PEM certificate authorities, one at a time (a bad one costs only itself).
func ParseRoots(text []byte) *Roots {
	roots := &Roots{Pool: x509.NewCertPool()}
	for len(text) > 0 {
		var block []byte
		block, text = nextPEM(text)
		if block == nil {
			break
		}
		if c, err := parsePEM(block); err == nil {
			roots.Pool.AddCert(c)
			roots.Certs = append(roots.Certs, c)
		}
	}
	return roots
}

func parsePEM(block []byte) (*x509.Certificate, error) {
	b, _ := pem.Decode(block)
	if b == nil {
		return nil, errors.New("not PEM")
	}
	return x509.ParseCertificate(b.Bytes)
}

// nextPEM cuts one PEM certificate off the front.
func nextPEM(pem []byte) ([]byte, []byte) {
	begin := bytes.Index(pem, []byte("-----BEGIN CERTIFICATE-----"))
	if begin < 0 {
		return nil, nil
	}
	endMarker := []byte("-----END CERTIFICATE-----")
	end := bytes.Index(pem[begin:], endMarker)
	if end < 0 {
		return nil, nil
	}
	end += begin + len(endMarker)
	return pem[begin:end], pem[end:]
}

// issuedBy says whether parent may be child's issuer as OpenSSL takes one (X509_check_issued): parent's name is the
// one child names as its issuer, their key identifiers (where both have them) agree, and parent's key usage, if it has
// one, allows signing certificates. Signatures are checked later, as OpenSSL checks them.
func issuedBy(child, parent *x509.Certificate) bool {
	if !bytes.Equal(child.RawIssuer, parent.RawSubject) {
		return false
	}
	if len(child.AuthorityKeyId) > 0 && len(parent.SubjectKeyId) > 0 && !bytes.Equal(child.AuthorityKeyId, parent.SubjectKeyId) {
		return false
	}
	return parent.KeyUsage == 0 || parent.KeyUsage&x509.KeyUsageCertSign != 0
}

// isAuthority is OpenSSL's X509_check_ca: by basic constraints where it has them; else a version 1 certificate that
// is its own issuer, or one whose key usage allows signing certificates.
func isAuthority(c *x509.Certificate) bool {
	if c.BasicConstraintsValid {
		return c.IsCA
	}
	if c.Version == 1 && issuedBy(c, c) {
		return true
	}
	return c.KeyUsage&x509.KeyUsageCertSign != 0
}

// forServers says whether a certificate's extended key usage allows a server's (or any) use; none at all allows any.
func forServers(c *x509.Certificate) bool {
	if len(c.ExtKeyUsage) == 0 && len(c.UnknownExtKeyUsage) == 0 {
		return true
	}
	for _, use := range c.ExtKeyUsage {
		if use == x509.ExtKeyUsageServerAuth || use == x509.ExtKeyUsageAny || use == x509.ExtKeyUsageNetscapeServerGatedCrypto ||
			use == x509.ExtKeyUsageMicrosoftServerGatedCrypto {
			return true
		}
	}
	return false
}

// ServerPurpose says whether a server's own certificate may serve a server, as OpenSSL's purpose check has it: its
// extended key usage, and its key usage, which (where it has one) has to allow a signature, key encipherment or key
// agreement. Go's verifier doesn't look at the key usage.
func ServerPurpose(leaf *x509.Certificate) bool {
	keyUsage := leaf.KeyUsage == 0 || leaf.KeyUsage&(x509.KeyUsageDigitalSignature|x509.KeyUsageKeyEncipherment|x509.KeyUsageKeyAgreement) != 0
	return forServers(leaf) && keyUsage
}

// findIssuer is the first of candidates that may be child's issuer (see issuedBy) and isn't used yet, one within its
// dates before one that isn't, as OpenSSL prefers.
func findIssuer(child *x509.Certificate, candidates []*x509.Certificate, used map[*x509.Certificate]bool, now time.Time) *x509.Certificate {
	var fallback *x509.Certificate
	for _, c := range candidates {
		if used[c] || !issuedBy(child, c) {
			continue
		}
		if !now.Before(c.NotBefore) && !now.After(c.NotAfter) {
			return c
		}
		if fallback == nil {
			fallback = c
		}
	}
	return fallback
}

// chainOf is the chain as OpenSSL builds it: from the server's certificate, each issuer among the authorities first,
// then among what the server sent, until an authority. Whether it reached one, and OpenSSL's error where it didn't.
func chainOf(sent []*x509.Certificate, roots *Roots, now time.Time) ([]*x509.Certificate, bool, string) {
	current := sent[0]
	chain := []*x509.Certificate{current}
	used := map[*x509.Certificate]bool{current: true}
	for depth := 0; depth < 32; depth++ {
		if anchor := findIssuer(current, roots.Certs, used, now); anchor != nil {
			return append(chain, anchor), true, ""
		}
		if issuedBy(current, current) {
			if depth == 0 {
				return chain, false, "DEPTH_ZERO_SELF_SIGNED_CERT"
			}
			return chain, false, "SELF_SIGNED_CERT_IN_CHAIN"
		}
		issuer := findIssuer(current, sent[1:], used, now)
		if issuer == nil {
			if depth == 0 {
				return chain, false, "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
			}
			return chain, false, "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
		}
		used[issuer] = true
		chain = append(chain, issuer)
		current = issuer
	}
	return chain, false, "CERT_CHAIN_TOO_LONG"
}

// Reasons are OpenSSL's failures for a chain, in the order it reports them (see the package's comment).
func Reasons(sent []*x509.Certificate, roots *Roots, now time.Time, verifyErr error) []string {
	chain, anchored, buildErr := chainOf(sent, roots, now)
	var reasons []string
	if !anchored {
		reasons = append(reasons, buildErr)
	}
	// Each certificate's extensions, the server's own first.
	for i, c := range chain {
		if anchored && i == len(chain)-1 && i > 0 && bytes.Equal(c.Raw, chain[i-1].Raw) {
			break
		}
		if len(c.UnhandledCriticalExtensions) > 0 {
			reasons = append(reasons, "UNHANDLED_CRITICAL_EXTENSION")
		}
		if i == 0 {
			if !ServerPurpose(c) {
				reasons = append(reasons, "INVALID_PURPOSE")
			}
			continue
		}
		if !isAuthority(c) {
			reasons = append(reasons, "INVALID_CA")
		}
		if !forServers(c) || !isAuthority(c) {
			reasons = append(reasons, "INVALID_PURPOSE")
		}
		if c.BasicConstraintsValid && (c.MaxPathLen > 0 || c.MaxPathLenZero) && i-1 > c.MaxPathLen {
			reasons = append(reasons, "PATH_LENGTH_EXCEEDED")
		}
	}
	// Signatures and dates, from the top of the chain down to the server's own.
	for i := len(chain) - 1; i >= 0; i-- {
		c := chain[i]
		if i < len(chain)-1 {
			if err := chain[i+1].CheckSignature(c.SignatureAlgorithm, c.RawTBSCertificate, c.Signature); err != nil {
				var insecure x509.InsecureAlgorithmError
				if errors.As(err, &insecure) {
					reasons = append(reasons, "CA_MD_TOO_WEAK")
				} else {
					reasons = append(reasons, "CERT_SIGNATURE_FAILURE")
				}
			}
		}
		if now.Before(c.NotBefore) {
			reasons = append(reasons, "CERT_NOT_YET_VALID")
		} else if now.After(c.NotAfter) {
			reasons = append(reasons, "CERT_HAS_EXPIRED")
		}
	}
	var invalid x509.CertificateInvalidError
	if errors.As(verifyErr, &invalid) {
		switch invalid.Reason {
		case x509.CANotAuthorizedForThisName, x509.NameConstraintsWithoutSANs:
			reasons = append(reasons, "PERMITTED_VIOLATION")
		}
	}
	return reasons
}

// Verify checks a chain (the server's certificate first, then what else the server sent) against roots at now, for a
// server's use: whether it is valid; else OpenSSL's reason for it (see the package's comment), and Go's own words
// for the log.
func Verify(sent []*x509.Certificate, roots *Roots, now time.Time) (ok bool, reason string, detail string) {
	if len(sent) == 0 {
		return false, "", "no certificate"
	}
	intermediates := x509.NewCertPool()
	for _, c := range sent[1:] {
		intermediates.AddCert(c)
	}
	_, err := sent[0].Verify(x509.VerifyOptions{
		Roots:         roots.Pool,
		Intermediates: intermediates,
		CurrentTime:   now,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	if err == nil && ServerPurpose(sent[0]) {
		return true, "", ""
	}
	if err == nil {
		err = errors.New("the certificate's key usage doesn't allow a server's use")
	}
	if reasons := Reasons(sent, roots, now, err); len(reasons) > 0 {
		return false, reasons[len(reasons)-1], err.Error()
	}
	return false, fallbackReason(err), err.Error()
}

// fallbackReason names a refusal of Go's verifier that OpenSSL's checks, as Reasons has them, don't account for.
func fallbackReason(err error) string {
	var invalid x509.CertificateInvalidError
	var insecure x509.InsecureAlgorithmError
	var critical x509.UnhandledCriticalExtension
	switch {
	case errors.As(err, &invalid):
		switch invalid.Reason {
		case x509.Expired:
			return "CERT_HAS_EXPIRED"
		case x509.IncompatibleUsage:
			return "INVALID_PURPOSE"
		case x509.NotAuthorizedToSign:
			return "INVALID_CA"
		case x509.TooManyIntermediates:
			return "PATH_LENGTH_EXCEEDED"
		}
	case errors.As(err, &insecure):
		return "CA_MD_TOO_WEAK"
	case errors.As(err, &critical):
		return "UNHANDLED_CRITICAL_EXTENSION"
	}
	return "CERT_REJECTED"
}
