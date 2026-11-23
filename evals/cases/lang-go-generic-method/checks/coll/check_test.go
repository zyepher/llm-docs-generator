package coll

import (
	"slices"
	"strconv"
	"testing"
)

// Hidden check: copied into the module under test as check_test.go.
func TestMapMethodChains(t *testing.T) {
	got := Of(1, 2, 3, 4).
		Filter(func(n int) bool { return n%2 == 0 }).
		Map(func(n int) string { return "#" + strconv.Itoa(n) }).
		Items()
	if want := []string{"#2", "#4"}; !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	lens := Of("a", "bbb").Map(func(s string) int { return len(s) }).Items()
	if want := []int{1, 3}; !slices.Equal(lens, want) {
		t.Fatalf("got %v, want %v", lens, want)
	}
}
