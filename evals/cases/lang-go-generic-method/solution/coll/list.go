package coll

// List is an ordered collection of values.
type List[T any] struct {
	items []T
}

// Of builds a List from the given values.
func Of[T any](vs ...T) *List[T] { return &List[T]{items: append([]T(nil), vs...)} }

// Items returns a copy of the values in order.
func (l *List[T]) Items() []T { return append([]T(nil), l.items...) }

// Filter returns a new List with the values for which keep returns true.
func (l *List[T]) Filter(keep func(T) bool) *List[T] {
	out := &List[T]{}
	for _, v := range l.items {
		if keep(v) {
			out.items = append(out.items, v)
		}
	}
	return out
}

// Map returns a new List holding f applied to every value, in order.
func (l *List[T]) Map[U any](f func(T) U) *List[U] {
	out := &List[U]{items: make([]U, 0, len(l.items))}
	for _, v := range l.items {
		out.items = append(out.items, f(v))
	}
	return out
}
