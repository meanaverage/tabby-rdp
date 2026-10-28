package ntlm

import (
	"encoding/binary"
	"math/bits"
)

// MD4 is RFC 1320's digest. The password's hash is one; Go's standard library has none (and the x/crypto one is
// deprecated), so it is written out here.
func MD4(data []byte) []byte {
	length := len(data)
	padded := make([]byte, ((length+8)/64+1)*64)
	copy(padded, data)
	padded[length] = 0x80
	binary.LittleEndian.PutUint64(padded[len(padded)-8:], uint64(length)*8)
	a, b, c, d := uint32(0x67452301), uint32(0xefcdab89), uint32(0x98badcfe), uint32(0x10325476)
	var x [16]uint32
	for offset := 0; offset < len(padded); offset += 64 {
		for i := range x {
			x[i] = binary.LittleEndian.Uint32(padded[offset+4*i:])
		}
		aa, bb, cc, dd := a, b, c, d
		f := func(p, q, r, s uint32, k int, n int) uint32 { return bits.RotateLeft32(p+(q&r|^q&s)+x[k], n) }
		g := func(p, q, r, s uint32, k int, n int) uint32 {
			return bits.RotateLeft32(p+(q&r|q&s|r&s)+x[k]+0x5a827999, n)
		}
		h := func(p, q, r, s uint32, k int, n int) uint32 { return bits.RotateLeft32(p+(q^r^s)+x[k]+0x6ed9eba1, n) }
		for _, i := range []int{0, 4, 8, 12} {
			a = f(a, b, c, d, i, 3)
			d = f(d, a, b, c, i+1, 7)
			c = f(c, d, a, b, i+2, 11)
			b = f(b, c, d, a, i+3, 19)
		}
		for _, i := range []int{0, 1, 2, 3} {
			a = g(a, b, c, d, i, 3)
			d = g(d, a, b, c, i+4, 5)
			c = g(c, d, a, b, i+8, 9)
			b = g(b, c, d, a, i+12, 13)
		}
		for _, i := range []int{0, 2, 1, 3} {
			a = h(a, b, c, d, i, 3)
			d = h(d, a, b, c, i+8, 9)
			c = h(c, d, a, b, i+4, 11)
			b = h(b, c, d, a, i+12, 15)
		}
		a, b, c, d = a+aa, b+bb, c+cc, d+dd
	}
	out := make([]byte, 16)
	binary.LittleEndian.PutUint32(out[0:], a)
	binary.LittleEndian.PutUint32(out[4:], b)
	binary.LittleEndian.PutUint32(out[8:], c)
	binary.LittleEndian.PutUint32(out[12:], d)
	return out
}
