//! Lock-free primitives for the desktop thread layout (spec section 3):
//! the ipc thread publishes `MusicalState` into a triple buffer that the audio
//! callback reads without locking; UI commands travel over an SPSC ring.
//! Both are `Copy`-only, allocation free after construction, and work on wasm
//! (single threaded) as plain buffers.

use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicUsize, Ordering};

/// Classic triple buffer: one writer, one reader, the reader always gets the
/// most recently *completed* write and never blocks.
pub struct TripleBuffer<T: Copy> {
    slots: [UnsafeCell<T>; 3],
    /// bits 0..1: index of the slot holding the latest completed write
    /// bit 2: "fresh" flag set by writer, cleared by reader
    state: AtomicUsize,
    write_idx: UnsafeCell<usize>,
    read_idx: UnsafeCell<usize>,
}

// SAFETY: the protocol below guarantees writer and reader never touch the same
// slot at the same time; T: Copy + Send is all we need.
unsafe impl<T: Copy + Send> Sync for TripleBuffer<T> {}
unsafe impl<T: Copy + Send> Send for TripleBuffer<T> {}

const FRESH: usize = 0b100;
const IDX: usize = 0b011;

impl<T: Copy> TripleBuffer<T> {
    pub fn new(init: T) -> Self {
        Self {
            slots: [
                UnsafeCell::new(init),
                UnsafeCell::new(init),
                UnsafeCell::new(init),
            ],
            state: AtomicUsize::new(0), // latest = slot 0, not fresh
            write_idx: UnsafeCell::new(1),
            read_idx: UnsafeCell::new(2),
        }
    }

    /// Split into a writer and a reader handle. Both borrow the buffer.
    pub fn split(&self) -> (TripleWriter<'_, T>, TripleReader<'_, T>) {
        (TripleWriter { buf: self }, TripleReader { buf: self })
    }
}

pub struct TripleWriter<'a, T: Copy> {
    buf: &'a TripleBuffer<T>,
}

pub struct TripleReader<'a, T: Copy> {
    buf: &'a TripleBuffer<T>,
}

impl<T: Copy> TripleWriter<'_, T> {
    /// Publish a new value. Never blocks.
    pub fn write(&mut self, value: T) {
        // SAFETY: write_idx is only ever touched by the single writer, and the
        // slot it names is neither the latest nor the one the reader holds.
        unsafe {
            let w = *self.buf.write_idx.get();
            *self.buf.slots[w].get() = value;
            // swap our slot with the "latest" slot, mark fresh
            let prev = self.buf.state.swap(w | FRESH, Ordering::AcqRel);
            *self.buf.write_idx.get() = prev & IDX;
        }
    }
}

impl<T: Copy> TripleReader<'_, T> {
    /// Get the latest published value (or the last one read if nothing new).
    pub fn read(&mut self) -> T {
        // SAFETY: read_idx is only touched by the single reader.
        unsafe {
            let st = self.buf.state.load(Ordering::Acquire);
            if st & FRESH != 0 {
                let r = *self.buf.read_idx.get();
                // take the latest slot, give back ours, clear fresh
                let prev = self.buf.state.swap(r, Ordering::AcqRel);
                *self.buf.read_idx.get() = prev & IDX;
            }
            *self.buf.slots[*self.buf.read_idx.get()].get()
        }
    }

    /// True if a write happened since the last `read`.
    pub fn is_fresh(&self) -> bool {
        self.buf.state.load(Ordering::Acquire) & FRESH != 0
    }
}

/// Bounded single-producer single-consumer ring of `Copy` items.
pub struct SpscRing<T: Copy, const N: usize> {
    buf: [UnsafeCell<Option<T>>; N],
    head: AtomicUsize, // next write
    tail: AtomicUsize, // next read
}

unsafe impl<T: Copy + Send, const N: usize> Sync for SpscRing<T, N> {}
unsafe impl<T: Copy + Send, const N: usize> Send for SpscRing<T, N> {}

impl<T: Copy, const N: usize> Default for SpscRing<T, N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Copy, const N: usize> SpscRing<T, N> {
    pub fn new() -> Self {
        Self {
            buf: core::array::from_fn(|_| UnsafeCell::new(None)),
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }

    /// Push; returns false if full (item dropped).
    pub fn push(&self, item: T) -> bool {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        if head.wrapping_sub(tail) >= N {
            return false;
        }
        // SAFETY: slot head%N is not readable until head is published.
        unsafe {
            *self.buf[head % N].get() = Some(item);
        }
        self.head.store(head.wrapping_add(1), Ordering::Release);
        true
    }

    /// Pop the oldest item, if any.
    pub fn pop(&self) -> Option<T> {
        let tail = self.tail.load(Ordering::Relaxed);
        let head = self.head.load(Ordering::Acquire);
        if tail == head {
            return None;
        }
        // SAFETY: slot tail%N was published by the producer.
        let item = unsafe { (*self.buf[tail % N].get()).take() };
        self.tail.store(tail.wrapping_add(1), Ordering::Release);
        item
    }

    pub fn len(&self) -> usize {
        self.head
            .load(Ordering::Acquire)
            .wrapping_sub(self.tail.load(Ordering::Acquire))
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triple_buffer_latest_wins() {
        let tb = TripleBuffer::new(0u32);
        let (mut w, mut r) = tb.split();
        assert_eq!(r.read(), 0);
        w.write(1);
        w.write(2);
        w.write(3);
        assert!(r.is_fresh());
        assert_eq!(r.read(), 3);
        assert!(!r.is_fresh());
        assert_eq!(r.read(), 3);
        w.write(4);
        assert_eq!(r.read(), 4);
    }

    #[test]
    fn ring_fifo_and_capacity() {
        let ring: SpscRing<u8, 4> = SpscRing::new();
        assert!(ring.push(1) && ring.push(2) && ring.push(3) && ring.push(4));
        assert!(!ring.push(5));
        assert_eq!(ring.pop(), Some(1));
        assert!(ring.push(5));
        assert_eq!(ring.pop(), Some(2));
        assert_eq!(ring.pop(), Some(3));
        assert_eq!(ring.pop(), Some(4));
        assert_eq!(ring.pop(), Some(5));
        assert_eq!(ring.pop(), None);
    }

    #[test]
    fn triple_buffer_threads() {
        use std::sync::Arc;
        let tb = Arc::new(TripleBuffer::new(0u64));
        let tb2 = tb.clone();
        let writer = std::thread::spawn(move || {
            let (mut w, _) = tb2.split();
            for i in 1..=10_000u64 {
                w.write(i);
            }
        });
        let (_, mut r) = tb.split();
        let mut last = 0;
        for _ in 0..10_000 {
            let v = r.read();
            assert!(v >= last);
            last = v;
        }
        writer.join().unwrap();
        assert_eq!(r.read(), 10_000);
    }
}
